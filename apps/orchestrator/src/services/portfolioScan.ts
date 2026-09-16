/**
 * The scheduled scan: value the portfolio, analyse it, store what is new.
 *
 * The division of labour matters. This process owns the portfolio, the FX rates
 * and the single rounding boundary, so it values the holdings and sends the
 * result. The AI service owns the price history, the rules and the words. And
 * the write stays here, because idempotency belongs to whoever holds the run
 * key - one process is responsible for not saying the same thing twice.
 */

import type { AiClient } from '@traders/shared/ai';

import {
  insertObservations,
  listHoldings,
  type ObservationToStore,
  type UserRow,
} from '../db/queries.js';
import { logger } from '../logger.js';
import { valuePortfolio } from './valuation.js';

export interface ScanResult {
  holdings: number;
  priced: number;
  findings: number;
  created: number;
  suppressed: number;
  narratedByLlm: number;
  narrationFallbacks: Record<string, number>;
  /** Present when a rule declined to run, and why. Never silently absent. */
  skipped: string[];
  degraded: boolean;
}

export async function runPortfolioScan(
  user: UserRow,
  ai: AiClient,
  runId: string | null,
  requestId?: string,
): Promise<ScanResult> {
  const rows = await listHoldings(user.id);
  if (rows.length === 0) {
    return {
      holdings: 0,
      priced: 0,
      findings: 0,
      created: 0,
      suppressed: 0,
      narratedByLlm: 0,
      narrationFallbacks: {},
      skipped: ['no holdings to analyse'],
      degraded: false,
    };
  }

  const portfolio = await valuePortfolio(rows, {
    baseCurrency: user.base_currency,
    ai,
    requestId,
  });

  const response = await ai.portfolioScan(
    {
      base_currency: portfolio.summary.baseCurrency,
      holdings: portfolio.holdings.map((holding) => ({
        instrument_id: holding.instrument.id,
        symbol: holding.instrument.symbol,
        // Null rather than zero: an unpriced holding is a known unknown, and the
        // scan needs to see it to report that drift was skipped.
        value_minor: holding.valueMinor,
        currency: portfolio.summary.baseCurrency,
        // The observation time behind the value, not the time we fetched it.
        // Allocation drift dates a weight by its stalest input, and a position
        // without this cannot take part in the calculation at all.
        as_of: holding.quote?.asOf ?? null,
      })),
      target_weights: {},
    },
    requestId,
  );

  const toStore: ObservationToStore[] = response.observations.map((observation) => ({
    userId: user.id,
    runId,
    kind: observation.kind,
    severity: observation.severity,
    subjectKind: observation.subject_ref.startsWith('portfolio') ? 'portfolio' : 'instrument',
    subjectRef: observation.subject_ref,
    headline: observation.headline,
    explanation: observation.explanation,
    evidence: observation.evidence ?? {},
    conceptRefs: observation.concept_refs ?? [],
    dedupeKey: observation.dedupe_key,
  }));

  const { created, suppressed } = await insertObservations(toStore);

  const skipped: string[] = [];
  if (response.stats.drift_skipped_reason) {
    skipped.push(`allocation drift: ${response.stats.drift_skipped_reason}`);
  }
  if (response.stats.insufficient_history?.length) {
    skipped.push(
      `insufficient price history: ${response.stats.insufficient_history.join(', ')}`,
    );
  }

  const result: ScanResult = {
    holdings: rows.length,
    priced: portfolio.summary.pricedCount,
    findings: response.stats.findings,
    created,
    suppressed,
    narratedByLlm: response.stats.narrated_by_llm,
    narrationFallbacks: response.stats.narration_fallbacks ?? {},
    skipped,
    // A scan that could not price everything, or whose rules declined to run,
    // did less than it appears to have done. Recording that is the difference
    // between "nothing happened" and "we did not look".
    degraded: portfolio.summary.degraded || skipped.length > 0,
  };

  logger().info({ userId: user.id, ...result }, 'portfolio scan complete');
  return result;
}
