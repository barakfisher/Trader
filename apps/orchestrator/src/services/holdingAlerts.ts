/**
 * One alert per holding per scan, where two findings describe one fall
 * (decision 148).
 *
 * A single day's drop can fire two rules on the same holding: the move rule
 * ("fell 9.51% today") and the drawdown rule ("28.81% below its 30-day high").
 * Both are worth keeping in the feed - they answer different questions, and the
 * drawdown's episode (decision 132) needs its own row - but sent separately they
 * arrive as two messages that state the same price twice. So the fan-out sends
 * them as one, and this module decides which findings belong together and what
 * the single message says.
 *
 * The sentence is the catalogue's (`moveWithDrawdown`), filled from the two
 * observations' stored evidence: every figure in it is one the rules computed
 * and the evidence validator already accepted, formatted here through `Intl`.
 * When the evidence is not what the sentence needs, the pair is not merged and
 * each finding goes out with its own stored words - a sentence with a figure
 * missing would be a figure invented.
 *
 * A move, merged or alone, also carries one line on what the market did that
 * day when the scan found its best-fitting index moved with it (decision 149,
 * `marketLine`). The line is added here rather than to the stored narration so
 * that it is the catalogue's sentence in the user's language, from evidence.
 */

import { formatMoney } from '@traders/shared';

import type { Messages, NoticeText } from '../notify/messages.js';
import { isMarketBenchmark } from './marketBenchmarks.js';
import { SEVERITY_RANK } from './notificationPolicy.js';

/** What grouping needs to know about a finding, beyond what delivers it. */
export interface GroupableFinding {
  refKind: 'observation' | 'proposal' | 'narration' | 'model_fallback' | 'run';
  severity: string;
  kind?: string;
  subjectRef?: string | null;
  evidence?: unknown;
  proposalId?: string;
  trade?: boolean;
  urgent?: boolean;
}

/**
 * One delivery: a finding on its own, or a move and a drawdown on one holding.
 * `severity` is the group's strongest, so the pair is routed once.
 */
export interface AlertGroup<T extends GroupableFinding> {
  members: T[];
  severity: string;
  /** The single message for a merged pair, in a given language; absent for a lone finding. */
  render?: (messages: Messages) => NoticeText;
}

const MOVE_KINDS = new Set(['price_move', 'sigma_move']);

/**
 * Group `findings` for delivery, keeping their order.
 *
 * Only plain observations merge: a finding carrying a proposal, a trade or an
 * urgent flag has a channel treatment of its own (buttons, quiet hours), and
 * folding it into another message would lose it. Moves and drawdowns carry none
 * today; the guard keeps it that way if that ever changes.
 */
export function groupAlerts<T extends GroupableFinding>(findings: T[]): AlertGroup<T>[] {
  const groups: AlertGroup<T>[] = [];
  const merged = new Set<T>();

  for (const finding of findings) {
    if (merged.has(finding)) continue;
    const partner = mergeable(finding) ? findings.find((other) => isPartner(finding, other)) : undefined;
    const pair = partner === undefined || merged.has(partner) ? null : orderPair(finding, partner);
    const render = pair === null ? null : renderer(pair.move, pair.drawdown);
    if (pair !== null && render !== null) {
      merged.add(pair.move);
      merged.add(pair.drawdown);
      groups.push({
        members: [pair.move, pair.drawdown],
        severity: strongest(pair.move.severity, pair.drawdown.severity),
        render,
      });
      continue;
    }
    groups.push({ members: [finding], severity: finding.severity });
  }
  return groups;
}

function mergeable(finding: GroupableFinding): boolean {
  return (
    finding.refKind === 'observation' &&
    finding.proposalId === undefined &&
    finding.trade !== true &&
    finding.urgent !== true &&
    typeof finding.subjectRef === 'string' &&
    finding.subjectRef.startsWith('instrument:') &&
    (MOVE_KINDS.has(finding.kind ?? '') || finding.kind === 'drawdown')
  );
}

function isPartner(finding: GroupableFinding, other: GroupableFinding): boolean {
  if (other === finding || !mergeable(other) || other.subjectRef !== finding.subjectRef) return false;
  const kinds = [finding.kind, other.kind];
  return kinds.includes('drawdown') && kinds.some((kind) => MOVE_KINDS.has(kind ?? ''));
}

function orderPair<T extends GroupableFinding>(a: T, b: T): { move: T; drawdown: T } {
  return a.kind === 'drawdown' ? { move: b, drawdown: a } : { move: a, drawdown: b };
}

function strongest(a: string, b: string): string {
  return (SEVERITY_RANK[b] ?? -1) > (SEVERITY_RANK[a] ?? -1) ? b : a;
}

/** The pair's message, or null when either evidence lacks a figure the sentence states. */
function renderer(
  move: GroupableFinding,
  drawdown: GroupableFinding,
): ((messages: Messages) => NoticeText) | null {
  const m = record(move.evidence);
  const d = record(drawdown.evidence);
  if (m === null || d === null) return null;

  const currency = m.currency;
  const symbol = m.symbol;
  const price = m.price_minor;
  const change = m.change_pct;
  const decline = d.drawdown_pct;
  const high = d.high_price_minor;
  if (
    typeof currency !== 'string' ||
    d.currency !== currency ||
    typeof symbol !== 'string' ||
    !isMinor(price) ||
    !isMinor(high) ||
    !isFiniteNumber(change) ||
    change === 0 ||
    !isFiniteNumber(decline)
  ) {
    return null;
  }
  const windowDays = isFiniteNumber(d.window_days) ? d.window_days : null;
  let z: number | null = null;
  if (move.kind === 'sigma_move') {
    if (!isFiniteNumber(m.z_score)) return null;
    z = m.z_score;
  }

  return (messages) => {
    const percent = percentFormat(messages);
    const money = (minor: number) => formatMoney(minor, currency, { locale: messages.numberLocale });
    const text = messages.moveWithDrawdown({
      symbol,
      direction: change < 0 ? 'fell' : 'rose',
      change: percent.format(Math.abs(change)),
      price: money(price),
      drawdown: percent.format(Math.abs(decline)),
      high: money(high),
      windowDays,
      sigma:
        z === null
          ? null
          : new Intl.NumberFormat(messages.numberLocale, {
              minimumFractionDigits: 1,
              maximumFractionDigits: 1,
            }).format(Math.abs(z)),
    });
    return withMarketLine(text, move, messages);
  };
}

/**
 * `text` with the market line under it, when `finding` is a move whose evidence
 * says its index moved with it (decision 149); `text` unchanged otherwise.
 */
export function withMarketLine<T extends { explanation: string | null }>(
  text: T,
  finding: Pick<GroupableFinding, 'kind' | 'evidence'>,
  messages: Messages,
): T {
  const line = marketLine(finding, messages);
  if (line === null) return text;
  return { ...text, explanation: text.explanation ? `${text.explanation}\n${line}` : line };
}

/** The market line for a move, or null when the evidence holds no complete `market` block. */
export function marketLine(
  finding: Pick<GroupableFinding, 'kind' | 'evidence'>,
  messages: Messages,
): string | null {
  if (!MOVE_KINDS.has(finding.kind ?? '')) return null;
  const market = record(record(finding.evidence)?.market);
  if (market === null) return null;
  const symbol = market.symbol;
  const change = market.change_pct;
  if (!isMarketBenchmark(symbol) || !isFiniteNumber(change) || change === 0) return null;
  return messages.marketLine({
    benchmark: symbol,
    direction: change < 0 ? 'fell' : 'rose',
    change: percentFormat(messages).format(Math.abs(change)),
  });
}

function percentFormat(messages: Messages): Intl.NumberFormat {
  return new Intl.NumberFormat(messages.numberLocale, {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Money in evidence is integer minor units; anything else is not a price we can state. */
function isMinor(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}
