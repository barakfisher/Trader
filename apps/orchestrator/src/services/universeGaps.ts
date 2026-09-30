/**
 * Gaps between what a user asks for and what the universe holds (M8), recorded
 * as `ops_events` for the admin page.
 *
 * Recorded only where a *user* named something - a holding, an import row, a
 * ticker added to a topic, a topic typed into the resolver. The scheduled
 * metadata run and topic discovery look things up too, but a phrase discovery
 * tried and dropped is the system's search, not a user's gap, and recording
 * them would bury the real ones.
 *
 * Nothing here can fail the flow that called it: a gap that could not be
 * written is logged and the user's import, holding or topic carries on
 * exactly as it would have. The panel is an observation of the product, and
 * an observer that could break what it observes is the wrong way round.
 */

import type { InstrumentResolution, TopicResolveResponse } from '@traders/shared/ai';

import { recordOpsEvent } from '../db/queries.js';
import { logger } from '../logger.js';
import { localDate } from './snapshot.js';

/** Where the user named the symbol. */
export type GapSource = 'holding' | 'import' | 'topic';

/**
 * What kind of gap it is:
 * - `outside_screen`: the screen can never hold it (`rule` says why) - expected;
 * - `not_in_universe`: a US equity or ETF the snapshot lacks - the real gap;
 * - `unpriced`: nothing could price the symbol at all.
 */
export type GapClass = 'outside_screen' | 'not_in_universe' | 'unpriced';

export interface MissingTickerDetail {
  symbol: string;
  source: GapSource;
  gap: GapClass;
  rule: 'asset_class' | 'exchange' | null;
  assetClass: string | null;
  exchange: string | null;
}

export interface UserContext {
  userId: string;
  timezone: string;
}

/**
 * The detail for a resolution that is a gap, or null when it is not one - a
 * member, or a resolution whose membership was never checked. "Not checked"
 * is never reported as missing.
 */
export function missingTickerDetail(
  symbol: string,
  resolution: InstrumentResolution,
  source: GapSource,
): MissingTickerDetail | null {
  const resolved = resolution.resolved;
  if (!resolved) {
    // Candidates mean the user is being asked which one they meant, not that
    // nothing exists: the gap, if any, is in whatever they pick.
    if ((resolution.candidates ?? []).length > 0) return null;
    return { symbol, source, gap: 'unpriced', rule: null, assetClass: null, exchange: null };
  }
  const universe = resolution.universe;
  if (!universe || universe.member) return null;
  const rule = universe.outside_screen ?? null;
  return {
    symbol: resolved.symbol,
    source,
    gap: rule ? 'outside_screen' : 'not_in_universe',
    rule,
    assetClass: resolved.asset_class ?? null,
    exchange: resolved.exchange ?? null,
  };
}

export async function recordMissingTicker(
  user: UserContext,
  symbol: string,
  resolution: InstrumentResolution,
  source: GapSource,
  now: Date = new Date(),
): Promise<void> {
  const detail = missingTickerDetail(symbol, resolution, source);
  if (!detail) return;
  await record({
    kind: 'universe_gap_missing_ticker',
    userId: user.userId,
    detail,
    dedupeKey: `missing_ticker:${user.userId}:${detail.symbol.toUpperCase()}:${localDate(user.timezone, now)}`,
  });
}

/** Lower-cased, whitespace collapsed: "Quantum  Computing" and "quantum computing" are one question. */
export function normaliseTopic(topic: string): string {
  return topic.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * A topic whose every candidate fell below the resolver's gate. Only `none`:
 * `weak` is an answer the user was given, and `unavailable` means the universe
 * was not searched at all - an installation fault, not a gap in its contents.
 */
export async function recordLowConfidence(
  user: UserContext,
  resolution: TopicResolveResponse,
  now: Date = new Date(),
): Promise<void> {
  if (resolution.verdict !== 'none') return;
  const topic = normaliseTopic(resolution.topic);
  await record({
    kind: 'universe_gap_low_confidence',
    userId: user.userId,
    detail: {
      topic,
      bestSimilarity: resolution.best_similarity ?? null,
      refuseBelow: resolution.refuse_below,
      confidentAbove: resolution.confident_above,
      embeddingModel: resolution.embedding_model,
      vectorIsSemantic: resolution.vector_is_semantic,
    },
    dedupeKey: `low_confidence:${user.userId}:${topic}:${localDate(user.timezone, now)}`,
  });
}

async function record(event: Parameters<typeof recordOpsEvent>[0]): Promise<void> {
  try {
    await recordOpsEvent(event);
  } catch (error) {
    logger().warn({ err: error, kind: event.kind, dedupeKey: event.dedupeKey }, 'gap event not recorded');
  }
}
