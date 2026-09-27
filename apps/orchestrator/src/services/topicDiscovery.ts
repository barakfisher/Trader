/**
 * Auto-discovery: recurring themes in the news become topic *proposals* (FR-11, M5).
 *
 * A proposal is only ever a question. It is a `topics` row with
 * `status = 'proposed'`; it is not scanned, collects no news, does not count
 * against the topic cap, and becomes a topic only when the user confirms an
 * instrument set for it through the ordinary confirm (`PUT /topics/:id`), which
 * re-resolves on the server like any other. Declining it
 * (`POST /topics/:id/reject`) turns it into rejection memory.
 *
 * One run, in order, cheapest test first:
 *
 * 1. The AI service returns phrases recurring across the window's headlines
 *    (`app/topics/discovery.py`), with the headlines as evidence. No embedding.
 * 2. Each phrase is compared by **words** with every theme the user already has:
 *    active topics, open proposals, and rejections inside the cooldown. A match
 *    is dropped here, before any resolver call, so a rejected theme that recurs
 *    every day costs nothing every day - and cannot hold a resolve slot that a
 *    new theme lower in the list needed.
 * 3. Survivors are resolved through the same `/topics/resolve` the Topics page
 *    uses, at most `MAX_RESOLVED_PER_RUN` of them. Only a `confident` verdict with
 *    at least `MIN_PROPOSAL_INSTRUMENTS` confident candidates can be proposed: a
 *    proposal nobody asked for has to clear a higher bar than an answer to a
 *    question someone typed.
 * 4. Each is compared again, now by **instruments** as well (`topicMatching.ts`),
 *    using every candidate it would show - see the measurement in the loop.
 * 5. What remains is written, strongest first, while slots remain: at most
 *    `MAX_OPEN_PROPOSALS` may be open at once, checked under the same user-row
 *    lock that guards the topic cap.
 *
 * Every phrase the run looked at leaves a reason in the run's stats, so "why was
 * nothing proposed?" is answered by `GET /runs` rather than by guessing.
 */

import type { AiClient, DiscoveredPhrase, TopicResolveResponse } from '@traders/shared/ai';
import { AiServiceError } from '@traders/shared/ai';

import {
  countOpenProposals,
  insertProposal,
  listAnalysedInstruments,
  listKnownThemes,
  lockTopicsForWrite,
  transaction,
  type KnownThemeRow,
  type TopicEvidence,
  type UserRow,
} from '../db/queries.js';
import { firstMatch, matchWords, type KnownTheme } from './topicMatching.js';

/** How far back headlines are read. A week: a theme is a story that lasts, not a day's spike. */
export const DISCOVERY_WINDOW_DAYS = 7;

/** Phrases asked for, strongest first. More than are resolved, so suppressed ones leave room. */
export const PHRASES_REQUESTED = 20;

/**
 * Resolver calls one run may make. Each costs an embedding; a day's news rarely
 * holds more than a handful of real themes, and the rest wait for tomorrow.
 */
export const MAX_RESOLVED_PER_RUN = 8;

/** Confident candidates a proposal needs. One instrument is a company, not a theme. */
export const MIN_PROPOSAL_INSTRUMENTS = 2;

/**
 * Proposals that may be open at once. Few, because each is a question the user
 * is asked and an unanswered pile teaches them to ignore the pile. A product
 * bound; nothing measured it.
 */
export const MAX_OPEN_PROPOSALS = 3;

export interface DiscoveryResult {
  /** Headlines in the window. Zero means there was nothing to read, not nothing to find. */
  headlines: number;
  phrases: number;
  resolved: number;
  proposed: { id: string; label: string; symbols: string[] }[];
  /** Phrase -> why it was not proposed. Every phrase examined appears here or in `proposed`. */
  notProposed: Record<string, string>;
  openProposals: number;
  maxOpenProposals: number;
  cooldownDays: number;
  /** Set when the run could not look properly: a resolve failed, or no universe. */
  degraded: boolean;
  /** Why nothing was examined, when nothing was. */
  reason?: string;
}

interface Accepted {
  label: string;
  words: string[];
  instrumentIds: string[];
  evidence: TopicEvidence;
}

function known(row: KnownThemeRow): KnownTheme {
  return {
    topicId: row.id,
    label: row.label,
    status: row.status,
    // A followed topic is compared by what it is called now, since a relabel
    // is the user saying what the theme is; a proposal or rejection by the
    // words frozen when it was proposed.
    words: row.status === 'active' || row.match_words === null ? matchWords(row.label) : row.match_words,
    instrumentIds: row.instrument_ids,
  };
}

function describe(match: { theme: KnownTheme; reason: string }): string {
  const what = match.theme.status === 'rejected' ? 'rejected' : match.theme.status;
  return `matches ${what} topic "${match.theme.label}" by ${match.reason}`;
}

/** Every candidate across every interpretation, first occurrence kept, with its band. */
function offeredCandidates(
  resolution: TopicResolveResponse,
): { id: string; symbol: string; confident: boolean }[] {
  const seen = new Map<string, { id: string; symbol: string; confident: boolean }>();
  for (const interpretation of resolution.interpretations ?? []) {
    for (const candidate of interpretation.candidates) {
      if (!seen.has(candidate.instrument_id)) {
        seen.set(candidate.instrument_id, {
          id: candidate.instrument_id,
          symbol: candidate.symbol,
          confident: candidate.confidence === 'confident',
        });
      }
    }
  }
  return [...seen.values()];
}

function evidenceOf(phrase: DiscoveredPhrase, symbols: string[]): TopicEvidence {
  return {
    phrase: phrase.phrase,
    articleCount: phrase.article_count,
    sourceCount: phrase.source_count,
    windowDays: DISCOVERY_WINDOW_DAYS,
    headlines: phrase.headlines.map((h) => ({
      articleId: h.article_id,
      title: h.title,
      source: h.source,
      publishedAt: h.published_at,
    })),
    symbols,
  };
}

export async function runTopicDiscovery(
  user: UserRow,
  ai: AiClient,
  cooldownDays: number,
  requestId?: string,
): Promise<DiscoveryResult> {
  const instruments = await listAnalysedInstruments(user.id);
  const [discovered, rows] = await Promise.all([
    ai.discoverTopics(
      {
        instruments: instruments.map((row) => ({
          instrument_id: row.id,
          symbol: row.symbol,
          name: row.name,
          asset_class: row.asset_class,
        })),
        days: DISCOVERY_WINDOW_DAYS,
        limit: PHRASES_REQUESTED,
      },
      requestId,
    ),
    listKnownThemes(user.id, cooldownDays),
  ]);
  const themes = rows.map(known);
  const openBefore = rows.filter((row) => row.status === 'proposed').length;
  const phrases = discovered.phrases ?? [];

  const result: DiscoveryResult = {
    headlines: discovered.headlines,
    phrases: phrases.length,
    resolved: 0,
    proposed: [],
    notProposed: {},
    openProposals: openBefore,
    maxOpenProposals: MAX_OPEN_PROPOSALS,
    cooldownDays,
    degraded: false,
  };
  if (discovered.headlines === 0) {
    result.reason = 'no headlines in the window; see GET /runs?kind=news_collect';
    return result;
  }
  const slots = MAX_OPEN_PROPOSALS - openBefore;
  if (slots <= 0) {
    // Nothing is resolved when nothing could be written: an embedding bought
    // for a proposal that has nowhere to go is money spent to learn nothing.
    result.reason = `${openBefore} proposals are already open (at most ${MAX_OPEN_PROPOSALS})`;
    return result;
  }

  const accepted: Accepted[] = [];
  for (const phrase of phrases) {
    if (accepted.length >= slots) {
      result.notProposed[phrase.phrase] = 'no open proposal slot left this run';
      continue;
    }
    const words = matchWords(phrase.phrase);
    if (words.length === 0) {
      result.notProposed[phrase.phrase] = 'no words left after filler words were removed';
      continue;
    }
    const byWords = firstMatch({ words, instrumentIds: [] }, themes);
    if (byWords) {
      result.notProposed[phrase.phrase] = describe(byWords);
      continue;
    }
    if (result.resolved >= MAX_RESOLVED_PER_RUN) {
      result.notProposed[phrase.phrase] = `not resolved: at most ${MAX_RESOLVED_PER_RUN} per run`;
      continue;
    }

    let resolution: TopicResolveResponse;
    try {
      resolution = await ai.resolveTopic(phrase.phrase, requestId);
    } catch (error) {
      if (!(error instanceof AiServiceError)) throw error;
      result.degraded = true;
      result.notProposed[phrase.phrase] = `resolve failed (HTTP ${error.status})`;
      continue;
    }
    result.resolved += 1;
    if (resolution.verdict === 'unavailable') {
      // No universe to resolve against: every later phrase would say the same.
      result.degraded = true;
      result.notProposed[phrase.phrase] = `not resolved: universe ${resolution.universe.state}`;
      result.reason = 'no searchable universe';
      break;
    }
    if (resolution.verdict !== 'confident') {
      result.notProposed[phrase.phrase] = `resolver verdict is ${resolution.verdict}, not confident`;
      continue;
    }
    const offered = offeredCandidates(resolution);
    const confident = offered.filter((c) => c.confident);
    if (confident.length < MIN_PROPOSAL_INSTRUMENTS) {
      result.notProposed[phrase.phrase] =
        `${confident.length} confident instrument(s); a proposal needs ${MIN_PROPOSAL_INSTRUMENTS}`;
      continue;
    }
    // The fingerprint is everything the proposal would show, weak candidates
    // included, not only the confident few. Measured on the real resolver
    // (2026-09-27): confident sets are 2-4 instruments and rarely share one, so
    // "nuclear fuel" overlapped a rejected "uranium" by 0%; over everything
    // offered it overlaps by 57%, and "uranium miners" by 100%. The confidence
    // bar decides whether to propose; the fingerprint decides what it repeats.
    const fingerprint = { words, instrumentIds: offered.map((c) => c.id) };
    const match = firstMatch(fingerprint, themes);
    if (match) {
      result.notProposed[phrase.phrase] = describe(match);
      continue;
    }

    const symbols = confident.map((c) => c.symbol);
    accepted.push({
      label: phrase.phrase,
      words,
      instrumentIds: fingerprint.instrumentIds,
      evidence: evidenceOf(phrase, symbols),
    });
    // A later phrase in the same run is compared against this one too, so
    // "data centre" and "data centre power" cannot both be proposed.
    themes.push({ topicId: '', label: phrase.phrase, status: 'proposed', ...fingerprint });
  }

  if (accepted.length === 0) return result;

  const written = await transaction(async (client) => {
    await lockTopicsForWrite(client, user.id);
    // Counted again under the lock: a proposal written by a concurrent run
    // since the first count takes a slot.
    const open = await countOpenProposals(client, user.id);
    const room = Math.max(0, MAX_OPEN_PROPOSALS - open);
    const ids: { id: string; label: string; symbols: string[] }[] = [];
    for (const proposal of accepted) {
      if (ids.length >= room) {
        result.notProposed[proposal.label] = 'no open proposal slot left this run';
        continue;
      }
      const row = await insertProposal(client, {
        userId: user.id,
        label: proposal.label,
        matchWords: proposal.words,
        instrumentIds: proposal.instrumentIds,
        evidence: proposal.evidence,
      });
      if ('duplicate' in row) {
        result.notProposed[proposal.label] = 'a live topic already has this label';
        continue;
      }
      ids.push({ id: row.id, label: proposal.label, symbols: proposal.evidence.symbols });
    }
    return { ids, open: open + ids.length };
  });

  result.proposed = written.ids;
  result.openProposals = written.open;
  return result;
}
