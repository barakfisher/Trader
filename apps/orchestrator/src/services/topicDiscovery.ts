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
 *    Then a phrase whose headlines are mostly one followed instrument's
 *    (`SINGLE_INSTRUMENT_SHARE`) is dropped: it is that company's news, not a
 *    theme, and it would spend a resolve learning so. So is a phrase carried
 *    mostly by one foreign country's press (`SINGLE_COUNTRY_SHARE`): that
 *    country's local news.
 * 3. Survivors are resolved through the same `/topics/resolve` the Topics page
 *    uses, at most `MAX_RESOLVED_PER_RUN` of them. A `confident` verdict with
 *    at least `MIN_PROPOSAL_INSTRUMENTS` confident candidates is a confident
 *    proposal: one nobody asked for has to clear a higher bar than an answer to
 *    a question someone typed. Short of that, a verdict with at least
 *    `MIN_WEAK_PROPOSAL_INSTRUMENTS` candidates is a **weak** proposal, shown
 *    only when the user asks for weak matches and capped on its own
 *    (`MAX_OPEN_WEAK_PROPOSALS`), so it can never take a confident one's place.
 * 4. Each is compared again, now by **instruments** as well (`topicMatching.ts`),
 *    using every candidate it would show - see the measurement in the loop.
 * 5. What remains is written, strongest first, while slots remain: at most
 *    `MAX_OPEN_PROPOSALS` may be open at once, checked under the same user-row
 *    lock that guards the topic cap.
 *
 * Before any of that, proposals left unanswered for `TOPIC_PROPOSAL_TTL_DAYS`
 * expire (migration 0021). Without it, `MAX_OPEN_PROPOSALS` ignored proposals
 * would stop discovery for good. An expired proposal is kept, named in the run's
 * stats, and held back for one discovery window: silence is not a "no", so it
 * may be asked again, but only on news that all postdates the silence - never
 * the next morning on the headlines the user already scrolled past.
 *
 * Expiry happens here and nowhere else, so a proposal past its deadline stays
 * visible and answerable until the next run. That is harmless - accepting it is
 * the user choosing a topic, declining it is a rejection - and it keeps the
 * sweep in the one place that needs the slot.
 *
 * Every phrase the run looked at leaves a reason in the run's stats, so "why was
 * nothing proposed?" is answered by `GET /runs` rather than by guessing.
 */

import type { AiClient, DiscoveredPhrase, TopicResolveResponse } from '@traders/shared/ai';
import { AiServiceError } from '@traders/shared/ai';
import type { ProposalBand } from '@traders/shared';

import {
  countOpenProposals,
  expireProposals,
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

/**
 * How long the market feed's unlinked articles are kept (decision 60): the
 * window a proposal was found in plus the time it may stay open, so every
 * headline behind an open proposal can still be read. Derived, not tuned -
 * changing either term moves it. Linked articles are never pruned.
 */
export function marketRetentionDays(proposalTtlDays: number): number {
  return DISCOVERY_WINDOW_DAYS + proposalTtlDays;
}

/**
 * Phrases asked for, strongest first. Far more than are resolved, because most
 * are dropped before resolving - by rejection memory and, above all, as one
 * company's news: on 2026-09-29, 19 of the top 20 were. At 20 that left seven
 * of eight resolve slots unused while phrases further down went unread. Asking
 * costs no embedding; only resolving does. The AI service's maximum.
 */
export const PHRASES_REQUESTED = 100;

/**
 * Resolver calls one run may make. Each costs an embedding; a day's news rarely
 * holds more than a handful of real themes, and the rest wait for tomorrow.
 */
export const MAX_RESOLVED_PER_RUN = 8;

/** Confident candidates a proposal needs. One instrument is a company, not a theme. */
export const MIN_PROPOSAL_INSTRUMENTS = 2;

/**
 * A phrase whose headlines are at least this share about one followed
 * instrument is that company's news, not a theme across companies, and is not
 * resolved. Measured on the stored headlines of 2026-09-29: multi-word phrases'
 * lead shares ran 0.60, 0.67 (x4), then 0.80 and up, 49 of 58 at 1.0 - every
 * one of the top ten NVDA or AAPL news ("ai agents" 96% NVDA, "rogue ai" 100%).
 * 0.75 sits in that gap. Articles linked to no followed instrument count
 * against the lead (the AI service's denominator), so market or sector news
 * from a broader feed reads as spread without this rule changing.
 */
export const SINGLE_INSTRUMENT_SHARE = 0.75;

/** Why `phrase` is one instrument's news, or null when it is spread across several. */
export function singleInstrumentReason(phrase: DiscoveredPhrase): string | null {
  const lead = phrase.lead_instrument;
  const articles = phrase.lead_instrument_articles ?? 0;
  if (!lead || phrase.article_count === 0) return null;
  if (articles < SINGLE_INSTRUMENT_SHARE * phrase.article_count) return null;
  const percent = Math.round((100 * articles) / phrase.article_count);
  return `${percent}% of its headlines are ${lead} news: one company, not a theme`;
}

/**
 * The market the user trades: US listings, priced in USD. A phrase carried
 * mostly by US outlets is never "local news" to this user, because it is the
 * market their holdings are in. A FIPS 10-4 code, as GDELT writes it.
 */
export const HOME_COUNTRY = 'US';

/**
 * A phrase whose articles are at least this share from one other country's
 * outlets is that country's local news (decision 61), and is not resolved.
 * Measured over the market feed's week (2026-09-22..29), top 100 phrases: the
 * local ones ran 0.78 and up (India's IPO calendar, "sensex nifty" 0.97; the
 * Reserve Bank of Australia's "cash rate" 0.95), the next was 0.67 ("class
 * action"), and global commodities sat far below ("brent crude" 0.52, "gold
 * silver" 0.51, mostly Indian outlets but not only). 0.75 sits in that gap -
 * the same number as the one-company rule, arrived at separately.
 */
export const SINGLE_COUNTRY_SHARE = 0.75;

/** Why `phrase` is one foreign country's local news, or null when it is not. */
export function singleCountryReason(phrase: DiscoveredPhrase): string | null {
  const lead = phrase.lead_country;
  const articles = phrase.lead_country_articles ?? 0;
  if (!lead || lead === HOME_COUNTRY || phrase.article_count === 0) return null;
  if (articles < SINGLE_COUNTRY_SHARE * phrase.article_count) return null;
  const percent = Math.round((100 * articles) / phrase.article_count);
  const where = phrase.lead_country_name ?? lead;
  return `${percent}% of its headlines are from ${where}'s press: one country's news, not a theme`;
}

/**
 * Proposals that may be open at once. Few, because each is a question the user
 * is asked and an unanswered pile teaches them to ignore the pile. A product
 * bound; nothing measured it.
 */
export const MAX_OPEN_PROPOSALS = 3;

/**
 * Weak proposals that may be open at once: their own cap, by the user's
 * decision (2026-09-29). A shared cap would let three weak proposals block
 * every confident one - the failure decision 57 fixed for unanswered ones.
 * Mirrors the confident cap; a product bound, not a measurement.
 */
export const MAX_OPEN_WEAK_PROPOSALS = 3;

/**
 * Candidates a weak proposal needs: one more than a confident proposal's
 * `MIN_PROPOSAL_INSTRUMENTS`, because each weak one is less evidence (the
 * user's decision, 2026-09-29).
 */
export const MIN_WEAK_PROPOSAL_INSTRUMENTS = 3;

/** What a resolution can be proposed as, with the symbols it would show. */
export type ProposalVerdict =
  { band: ProposalBand; symbols: { id: string; symbol: string }[] } | { reason: string };

/**
 * Whether a resolution becomes a proposal, and in which band.
 *
 * Confident: a `confident` verdict with `MIN_PROPOSAL_INSTRUMENTS` confident
 * candidates, showing those. Weak: any other `confident` or `weak` verdict with
 * `MIN_WEAK_PROPOSAL_INSTRUMENTS` candidates offered, showing all of them - a
 * confident verdict resting on one confident instrument ("treasury yields":
 * GOVI, then six weak) is a weak match in substance, and this is where the
 * user sees it. `none` is never proposed.
 */
export function proposalVerdict(
  verdict: TopicResolveResponse['verdict'],
  offered: { id: string; symbol: string; confident: boolean }[],
): ProposalVerdict {
  const confident = offered.filter((c) => c.confident);
  if (verdict === 'confident' && confident.length >= MIN_PROPOSAL_INSTRUMENTS) {
    return { band: 'confident', symbols: confident };
  }
  if (
    (verdict === 'confident' || verdict === 'weak') &&
    offered.length >= MIN_WEAK_PROPOSAL_INSTRUMENTS
  ) {
    return { band: 'weak', symbols: offered };
  }
  if (verdict === 'confident') {
    return {
      reason:
        `${confident.length} confident instrument(s) of ${offered.length} offered; a proposal ` +
        `needs ${MIN_PROPOSAL_INSTRUMENTS} confident, or ${MIN_WEAK_PROPOSAL_INSTRUMENTS} in all for a weak one`,
    };
  }
  if (verdict === 'weak') {
    return {
      reason: `resolver verdict is weak with ${offered.length} candidate(s); a weak proposal needs ${MIN_WEAK_PROPOSAL_INSTRUMENTS}`,
    };
  }
  return { reason: `resolver verdict is ${verdict}` };
}

/** The cap on open proposals of `band`. */
export function proposalCap(band: ProposalBand): number {
  return band === 'confident' ? MAX_OPEN_PROPOSALS : MAX_OPEN_WEAK_PROPOSALS;
}

/**
 * Days an expired proposal's theme is not proposed again: one discovery window,
 * so a re-proposal rests only on headlines published after it expired.
 */
export const EXPIRED_HOLD_DAYS = DISCOVERY_WINDOW_DAYS;

export interface DiscoveryPolicy {
  /** `TOPIC_REJECTION_COOLDOWN_DAYS`. */
  cooldownDays: number;
  /** `TOPIC_PROPOSAL_TTL_DAYS`. */
  proposalTtlDays: number;
}

export interface DiscoveryResult {
  /** Headlines in the window. Zero means there was nothing to read, not nothing to find. */
  headlines: number;
  phrases: number;
  resolved: number;
  proposed: { id: string; label: string; band: ProposalBand; symbols: string[] }[];
  /** Labels of proposals this run expired, unanswered after `proposalTtlDays`. */
  expired: string[];
  /** Phrase -> why it was not proposed. Every phrase examined appears here or in `proposed`. */
  notProposed: Record<string, string>;
  /** Open confident proposals, and their cap. */
  openProposals: number;
  maxOpenProposals: number;
  /** Open weak proposals, and their own cap. */
  openWeakProposals: number;
  maxOpenWeakProposals: number;
  cooldownDays: number;
  proposalTtlDays: number;
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
  band: ProposalBand;
}

function known(row: KnownThemeRow): KnownTheme {
  return {
    topicId: row.id,
    label: row.label,
    status: row.status,
    // A followed topic is compared by what it is called now, since a relabel
    // is the user saying what the theme is; a proposal or rejection by the
    // words frozen when it was proposed.
    words:
      row.status === 'active' || row.match_words === null ? matchWords(row.label) : row.match_words,
    instrumentIds: row.instrument_ids,
  };
}

function describe(match: { theme: KnownTheme; reason: string }): string {
  return `matches ${match.theme.status} topic "${match.theme.label}" by ${match.reason}`;
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
  policy: DiscoveryPolicy,
  requestId?: string,
): Promise<DiscoveryResult> {
  // First, and before the early returns: a run with no headlines must still
  // free the slots of proposals nobody answered.
  const expired = await transaction(async (client) => {
    await lockTopicsForWrite(client, user.id);
    return expireProposals(client, user.id, policy.proposalTtlDays);
  });

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
    listKnownThemes(user.id, policy.cooldownDays, EXPIRED_HOLD_DAYS),
  ]);
  const themes = rows.map(known);
  const openBefore: Record<ProposalBand, number> = { confident: 0, weak: 0 };
  for (const row of rows) {
    if (row.status === 'proposed' && row.proposal_band) openBefore[row.proposal_band] += 1;
  }
  const phrases = discovered.phrases ?? [];

  const result: DiscoveryResult = {
    headlines: discovered.headlines,
    phrases: phrases.length,
    resolved: 0,
    proposed: [],
    expired,
    notProposed: {},
    openProposals: openBefore.confident,
    maxOpenProposals: MAX_OPEN_PROPOSALS,
    openWeakProposals: openBefore.weak,
    maxOpenWeakProposals: MAX_OPEN_WEAK_PROPOSALS,
    cooldownDays: policy.cooldownDays,
    proposalTtlDays: policy.proposalTtlDays,
    degraded: false,
  };
  if (discovered.headlines === 0) {
    result.reason = 'no headlines in the window; see GET /runs?kind=news_collect';
    return result;
  }
  const slots: Record<ProposalBand, number> = {
    confident: MAX_OPEN_PROPOSALS - openBefore.confident,
    weak: MAX_OPEN_WEAK_PROPOSALS - openBefore.weak,
  };
  if (slots.confident <= 0 && slots.weak <= 0) {
    // Nothing is resolved when nothing could be written: an embedding bought
    // for a proposal that has nowhere to go is money spent to learn nothing.
    result.reason =
      `${openBefore.confident} confident and ${openBefore.weak} weak proposals are already open ` +
      `(at most ${MAX_OPEN_PROPOSALS} and ${MAX_OPEN_WEAK_PROPOSALS})`;
    return result;
  }

  const accepted: Accepted[] = [];
  const taken = (band: ProposalBand) => accepted.filter((a) => a.band === band).length;
  for (const phrase of phrases) {
    if (taken('confident') >= slots.confident && taken('weak') >= slots.weak) {
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
    // After rejection memory, so a rejected theme still says it was rejected;
    // before the budget, so one company's news never spends a resolve.
    const oneCompany = singleInstrumentReason(phrase);
    if (oneCompany) {
      result.notProposed[phrase.phrase] = oneCompany;
      continue;
    }
    const oneCountry = singleCountryReason(phrase);
    if (oneCountry) {
      result.notProposed[phrase.phrase] = oneCountry;
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
    const offered = offeredCandidates(resolution);
    const verdict = proposalVerdict(resolution.verdict, offered);
    if ('reason' in verdict) {
      result.notProposed[phrase.phrase] = verdict.reason;
      continue;
    }
    if (taken(verdict.band) >= slots[verdict.band]) {
      result.notProposed[phrase.phrase] = `no open ${verdict.band} proposal slot left this run`;
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

    const symbols = verdict.symbols.map((c) => c.symbol);
    accepted.push({
      label: phrase.phrase,
      words,
      instrumentIds: fingerprint.instrumentIds,
      evidence: evidenceOf(phrase, symbols),
      band: verdict.band,
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
    const ids: { id: string; label: string; band: ProposalBand; symbols: string[] }[] = [];
    for (const proposal of accepted) {
      const written = ids.filter((row) => row.band === proposal.band).length;
      if (open[proposal.band] + written >= proposalCap(proposal.band)) {
        result.notProposed[proposal.label] = `no open ${proposal.band} proposal slot left this run`;
        continue;
      }
      const row = await insertProposal(client, {
        userId: user.id,
        label: proposal.label,
        matchWords: proposal.words,
        instrumentIds: proposal.instrumentIds,
        evidence: proposal.evidence,
        band: proposal.band,
      });
      if ('duplicate' in row) {
        result.notProposed[proposal.label] = 'a live topic already has this label';
        continue;
      }
      ids.push({
        id: row.id,
        label: proposal.label,
        band: proposal.band,
        symbols: proposal.evidence.symbols,
      });
    }
    const count = (band: ProposalBand) =>
      open[band] + ids.filter((row) => row.band === band).length;
    return { ids, open: { confident: count('confident'), weak: count('weak') } };
  });

  result.proposed = written.ids;
  result.openProposals = written.open.confident;
  result.openWeakProposals = written.open.weak;
  return result;
}
