/**
 * What an agent's scan looked at before it proposed a trade: the "Evidence
 * checked" line on the proposal's card and its Telegram message.
 *
 * Derived at read time from `agent_scans.transcript`, never stored: the
 * transcript is the record, and a second copy of it is a copy that can
 * disagree. Each assistant step carries `tool_calls` with a `name` and the
 * `arguments` the model wrote, as a JSON string (`llm/tool_loop.py`).
 *
 * The line is about what was *asked*, not what came back - an answer that was an
 * error still shows as checked, and the full transcript, one link away, says
 * what each call answered.
 */

import { isScanToolName, type EvidenceChecked, type ScanToolName, type ToolCheck } from '@traders/shared';

/** A search phrase is the model's own text; a long one is cut so the line stays a line. */
export const MAX_SUBJECT_CHARS = 40;

/**
 * The checks, in the order each was first made. Calls to the same tool about
 * the same subject are one check, with the widest window any of them asked for:
 * a scan that read 21 days of NVDA and then 60 checked 60 days of NVDA. A tool
 * the product does not know is counted in `otherCalls`, never named.
 */
export function evidenceCheckedFrom(calls: readonly unknown[]): EvidenceChecked {
  const checks = new Map<string, ToolCheck>();
  let otherCalls = 0;
  for (const raw of calls) {
    const call = (typeof raw === 'object' && raw !== null ? raw : {}) as { name?: unknown; arguments?: unknown };
    const name = typeof call.name === 'string' ? call.name : '';
    if (!isScanToolName(name)) {
      otherCalls += 1;
      continue;
    }
    const args = argumentsOf(call.arguments);
    const check: ToolCheck = { tool: name, subject: subjectOf(name, args), days: daysOf(args) };
    const key = `${check.tool}\u0000${check.subject ?? ''}`;
    const seen = checks.get(key);
    if (seen === undefined) checks.set(key, check);
    else if (check.days !== null && (seen.days === null || check.days > seen.days)) seen.days = check.days;
  }
  return { checks: [...checks.values()], otherCalls };
}

/** The arguments as an object; the model's malformed JSON reads as no arguments. */
function argumentsOf(raw: unknown): Record<string, unknown> {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function subjectOf(tool: ScanToolName, args: Record<string, unknown>): string | null {
  switch (tool) {
    case 'search_universe':
    case 'explain_concept':
      return phrase(args.query);
    case 'get_quote': {
      const symbols = Array.isArray(args.symbols) ? args.symbols.map(symbol).filter((s) => s !== null) : [];
      return symbols.length > 0 ? [...new Set(symbols)].join(', ') : null;
    }
    case 'get_price_history':
    case 'get_findings':
    case 'get_news':
    case 'get_position':
      return symbol(args.symbol);
  }
}

/** A ticker as the tools read it (`tools.py:_symbol`): trimmed, upper case. */
function symbol(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : null;
}

function phrase(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text) return null;
  return text.length > MAX_SUBJECT_CHARS ? `${text.slice(0, MAX_SUBJECT_CHARS - 1).trimEnd()}…` : text;
}

function daysOf(args: Record<string, unknown>): number | null {
  const days = args.days;
  return typeof days === 'number' && Number.isInteger(days) && days > 0 ? days : null;
}
