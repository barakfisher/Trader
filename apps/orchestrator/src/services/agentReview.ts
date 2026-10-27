/**
 * The agent review (D335-D338): every `AGENT_REVIEW_EVERY_SCANS` counted scans
 * of a simulated agent, three rules read its last window of scans and its
 * ledger, and each that fires stores one suggestion - the figures it stands
 * on, and one setting it proposes to change, or none. Nothing changes until
 * the user applies it on the agent page; no model is asked (the user's choice,
 * 2026-10-27: free, deterministic, and the user's Apply).
 *
 * - **idle_cash**: at most `IDLE_MAX_TRADE_SCANS` of the window's scans traded
 *   while cash is at least `IDLE_CASH_SHARE_BPS` of deposits. Proposes, in
 *   order, a halved cash buffer, the next smaller company size, or one step
 *   more risk.
 * - **fee_drag**: the agent's fills in the window paid at least
 *   `FEE_DRAG_SHARE_BPS` of deposits in fees. Proposes fewer trades - one
 *   decision less per scan, or half as many market-hours scans - or else
 *   larger ones, a higher position limit.
 * - **benchmark_lag**: since its first deposit the agent trails the shadow SPY
 *   (D115) by at least `BENCHMARK_LAG_POINTS`. Proposes allowing ETFs when they
 *   are off; otherwise it only reports.
 *
 * Every figure is the ledger's, the scans', or the Performance tab's own
 * computation (guideline 7); an unavailable one skips its rule.
 */

import {
  AGENT_REVIEW_EVERY_SCANS,
  MARKET_CAPS,
  MAX_SCAN_EVERY_HOURS,
  MIN_DECISIONS_PER_SCAN,
  type AgentReviewRule,
  type MarketCap,
  type PerformanceComparison,
  type SuggestionChange,
  type SuggestionEvidence,
} from '@traders/shared';
import type { AiClient } from '@traders/shared/ai';

import { insertSuggestions, readReviewWindow, type AgentRow, type ReviewWindowRow } from '../db/queries.js';
import { logger } from '../logger.js';
import { readAgentPerformance } from './performanceInputs.js';

/**
 * Scans that count: the model answered, whatever it decided. A provider
 * failure, a spent budget or a missing key never reached a decision, and a
 * re-check of an expired proposal (`refresh`) is not one of the agent's scans.
 */
export const COUNTED_SCAN_OUTCOMES = ['trade', 'no_trade', 'rule_rejected', 'invalid_answer', 'step_limit'] as const;

/** idle_cash: cash at least this share of deposits... */
export const IDLE_CASH_SHARE_BPS = 5_000;
/** ...while at most this many of the window's scans traded. */
export const IDLE_MAX_TRADE_SCANS = 1;
/** fee_drag: the window's fees at least this share of deposits. */
export const FEE_DRAG_SHARE_BPS = 100;
/** benchmark_lag: the agent's return this many points or more below the shadow SPY's. */
export const BENCHMARK_LAG_POINTS = 5;

/** The highest risk level (`agents_risk_level_check`). */
export const MAX_RISK_LEVEL = 10;
/** A position limit cannot exceed all of capital. */
export const MAX_POSITION_LIMIT_BPS = 10_000;
/** Percentages move in whole percents: 100 basis points. */
const WHOLE_PERCENT_BPS = 100;

const BPS = 10_000n;

export type ReviewedAgent = Pick<
  AgentRow,
  | 'currency'
  | 'cash_buffer_bps'
  | 'market_caps'
  | 'risk_level'
  | 'max_decisions'
  | 'scan_every_hours'
  | 'max_position_bps'
  | 'allow_etfs'
>;

/** What the rules read: the window, the ledger beside it, and the comparison with SPY. */
export interface ReviewInput {
  agent: ReviewedAgent;
  window: {
    scans: number;
    tradeScans: number;
    since: Date;
    fills: number;
    feesMinor: bigint;
    depositsMinor: bigint;
    /** Null when the agent has no cash row. */
    cashMinor: bigint | null;
  };
  /** Null when it could not be computed: the rule that needs it is skipped. */
  comparison: PerformanceComparison | null;
}

export interface ReviewFinding {
  rule: AgentReviewRule;
  evidence: SuggestionEvidence;
  change: SuggestionChange | null;
}

/** A share of `whole` in basis points, rounded down once. */
function shareBps(part: bigint, whole: bigint): number {
  return Number((part * BPS) / whole);
}

/** A percentage as the Performance tab shows it, to the hundredth: the evidence is what is read. */
function hundredths(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Half a percentage, down to a whole percent. */
function halvedBps(bps: number): number {
  return Math.floor(bps / 2 / WHOLE_PERCENT_BPS) * WHOLE_PERCENT_BPS;
}

/** The next smaller company size not yet allowed, kept in the mandate's order. */
function widerCaps(caps: MarketCap[]): MarketCap[] | null {
  if (caps.length === 0) return null; // none ticked is already any size
  const smallest = Math.max(...caps.map((cap) => MARKET_CAPS.indexOf(cap)));
  const next = MARKET_CAPS.slice(smallest + 1).find((cap) => !caps.includes(cap));
  return next === undefined ? null : [...caps, next];
}

/** idle_cash's change: a lower buffer, then a wider size band, then one step of risk. */
export function idleCashChange(agent: ReviewedAgent): SuggestionChange | null {
  const buffer = agent.cash_buffer_bps;
  if (buffer !== null && buffer >= WHOLE_PERCENT_BPS) {
    return { setting: 'cash_buffer_bps', from: buffer, to: halvedBps(buffer) };
  }
  const caps = widerCaps(agent.market_caps as MarketCap[]);
  if (caps !== null) return { setting: 'market_caps', from: agent.market_caps, to: caps };
  const risk = agent.risk_level;
  if (risk !== null && risk < MAX_RISK_LEVEL) return { setting: 'risk_level', from: risk, to: risk + 1 };
  return null;
}

/** fee_drag's change: fewer decisions per scan, then fewer scans, then larger positions. */
export function feeDragChange(agent: ReviewedAgent): SuggestionChange | null {
  if (agent.max_decisions > MIN_DECISIONS_PER_SCAN) {
    return { setting: 'max_decisions', from: agent.max_decisions, to: agent.max_decisions - 1 };
  }
  const every = agent.scan_every_hours;
  if (every !== null && every < MAX_SCAN_EVERY_HOURS) {
    return { setting: 'scan_every_hours', from: every, to: Math.min(every * 2, MAX_SCAN_EVERY_HOURS) };
  }
  const position = agent.max_position_bps;
  if (position !== null && position < MAX_POSITION_LIMIT_BPS) {
    const raised = Math.floor((position * 3) / 2 / WHOLE_PERCENT_BPS) * WHOLE_PERCENT_BPS;
    return { setting: 'max_position_bps', from: position, to: Math.min(Math.max(raised, position + WHOLE_PERCENT_BPS), MAX_POSITION_LIMIT_BPS) };
  }
  return null;
}

/** benchmark_lag's change: allow ETFs when they are off - SPY itself among them. */
export function benchmarkLagChange(agent: ReviewedAgent): SuggestionChange | null {
  return agent.allow_etfs ? null : { setting: 'allow_etfs', from: false, to: true };
}

/** The three rules over one window. Pure. */
export function reviewAgent(input: ReviewInput): ReviewFinding[] {
  const { agent, window } = input;
  const base: SuggestionEvidence = {
    scans: window.scans,
    tradeScans: window.tradeScans,
    since: window.since.toISOString(),
    currency: agent.currency,
  };
  const findings: ReviewFinding[] = [];
  const deposits = window.depositsMinor;

  if (deposits > 0n && window.cashMinor !== null) {
    const cash = window.cashMinor;
    if (window.tradeScans <= IDLE_MAX_TRADE_SCANS && cash * BPS >= BigInt(IDLE_CASH_SHARE_BPS) * deposits) {
      findings.push({
        rule: 'idle_cash',
        evidence: {
          ...base,
          cashMinor: Number(cash),
          depositsMinor: Number(deposits),
          cashShareBps: shareBps(cash, deposits),
        },
        change: idleCashChange(agent),
      });
    }
  }

  if (deposits > 0n && window.fills > 0 && window.feesMinor * BPS >= BigInt(FEE_DRAG_SHARE_BPS) * deposits) {
    findings.push({
      rule: 'fee_drag',
      evidence: {
        ...base,
        fills: window.fills,
        feesMinor: Number(window.feesMinor),
        depositsMinor: Number(deposits),
        feeShareBps: shareBps(window.feesMinor, deposits),
      },
      change: feeDragChange(agent),
    });
  }

  const comparison = input.comparison;
  if (
    comparison !== null &&
    comparison.returnPct !== null &&
    comparison.benchmarkReturnPct !== null &&
    comparison.differencePts !== null &&
    comparison.differencePts <= -BENCHMARK_LAG_POINTS
  ) {
    findings.push({
      rule: 'benchmark_lag',
      evidence: {
        ...base,
        returnPct: hundredths(comparison.returnPct),
        benchmarkReturnPct: hundredths(comparison.benchmarkReturnPct),
        // From the two figures as shown, so the sentence's subtraction is the reader's too.
        differencePts: hundredths(hundredths(comparison.returnPct) - hundredths(comparison.benchmarkReturnPct)),
        day: comparison.day,
      },
      change: benchmarkLagChange(agent),
    });
  }
  return findings;
}

/** Whether `counted` scans close a window: the 10th, the 20th, and so on. */
export function closesWindow(counted: number): boolean {
  return counted > 0 && counted % AGENT_REVIEW_EVERY_SCANS === 0;
}

/** A window is named by its last scan, so a review run twice writes once (D336). */
export function suggestionKey(lastScanId: string, rule: AgentReviewRule): string {
  return `${lastScanId}:${rule}`;
}

function windowOf(row: ReviewWindowRow): ReviewInput['window'] | null {
  if (row.since === null) return null;
  return {
    scans: Number(row.scans),
    tradeScans: Number(row.trade_scans),
    since: row.since,
    fills: Number(row.fills),
    feesMinor: BigInt(row.fees_minor),
    depositsMinor: BigInt(row.deposits_minor),
    cashMinor: row.cash_minor === null ? null : BigInt(row.cash_minor),
  };
}

/**
 * Review the agent if its last counted scan closed a window; called after
 * every scan. Never throws: a review is a by-product, and a failed one must
 * not fail the scan that ran. Returns the suggestions written.
 */
export async function reviewAfterScan(
  userId: string,
  agent: Pick<AgentRow, 'id' | 'is_primary'> & ReviewedAgent,
  deps: { ai: AiClient; now?: () => Date; requestId?: string },
): Promise<string[]> {
  if (agent.is_primary) return [];
  try {
    const row = await readReviewWindow(userId, agent.id, COUNTED_SCAN_OUTCOMES, AGENT_REVIEW_EVERY_SCANS);
    if (row === null || row.last_scan_id === null || !closesWindow(Number(row.counted))) return [];
    const window = windowOf(row);
    if (window === null) return [];
    let comparison: PerformanceComparison | null = null;
    try {
      const now = (deps.now ?? (() => new Date()))();
      comparison = (await readAgentPerformance(userId, agent, deps.ai, now, deps.requestId)).comparison;
    } catch (error) {
      // No calendar or no closes: the comparison is unavailable, and so is its rule.
      logger().warn({ err: error, agentId: agent.id }, 'agent_review.performance_unavailable');
    }
    const lastScanId = row.last_scan_id;
    const findings = reviewAgent({ agent, window, comparison });
    const written = await insertSuggestions(
      userId,
      agent.id,
      findings.map((finding) => ({ ...finding, dedupeKey: suggestionKey(lastScanId, finding.rule) })),
    );
    if (written.length > 0) logger().info({ agentId: agent.id, written: written.length }, 'agent_review.suggested');
    return written;
  } catch (error) {
    logger().error({ err: error, agentId: agent.id }, 'agent_review.failed');
    return [];
  }
}
