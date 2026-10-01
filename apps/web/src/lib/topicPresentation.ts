/**
 * How topics are put into words: a resolution on the confirm screen, and a
 * topic card's news and tone.
 *
 * Kept out of the component for the reason `observationPresentation.ts` is:
 * the sentences here make claims ("nothing in the universe is about this",
 * "this installation has no universe loaded"), and a claim is worth a test.
 */

import type { NewsCollectionState, TopicSentimentGap, TopicSentimentResponse } from '@traders/shared';
import type { TopicResolveResponse } from '@traders/shared/ai';

import { formatNumber } from '../i18n/format.ts';
import { t } from '../i18n/index.ts';

export type Verdict = TopicResolveResponse['verdict'];
export type UniverseState = TopicResolveResponse['universe']['state'];

/**
 * A fund weight ("0.219495", a fraction as a decimal string) as a percentage
 * with one decimal: "21.9%". Done on the digits rather than through a float,
 * for the same reason the weight travels as a string (guideline 4). It
 * truncates instead of rounding, so the figure shown is never larger than the
 * stored one.
 */
export function fundShare(weight: string): string {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(weight.trim());
  if (!match) return weight;
  const [, whole = '0', fraction = ''] = match;
  // A fraction times 100 moves the point two places right; the third fraction
  // digit is the one decimal kept, and everything after it is dropped.
  const digits = `${whole}${fraction.slice(0, 3).padEnd(3, '0')}`;
  const percent = digits.slice(0, -1).replace(/^0+(?=\d)/, '');
  return `${percent}.${digits.slice(-1)}%`;
}

/** "held by URA 21.9%, NLR 4.0%" - the checkable half of a candidate's reason. */
export function heldByText(heldBy: { etf: string; weight: string }[]): string | null {
  if (heldBy.length === 0) return null;
  const funds = heldBy.map((h) => t('topics.fundShare', { etf: h.etf, share: fundShare(h.weight) }));
  return t('topics.heldBy', { funds: funds.join(t('common.listSeparator')) });
}

/**
 * What the screen says about a resolution before it shows any candidate.
 *
 * `none` and `unavailable` are kept apart on purpose. The first is a finding
 * about the topic. The second is a finding about this installation, and
 * showing it as the first would tell the user their topic is unknown when
 * nobody loaded the universe. Both still let the user add tickers by hand,
 * because a topic's instruments are the user's choice either way.
 */
export function verdictMessage(resolution: Pick<TopicResolveResponse, 'verdict' | 'universe'>): {
  tone: 'ok' | 'caution' | 'empty';
  text: string;
} | null {
  switch (resolution.verdict) {
    case 'confident':
      return null;
    case 'weak':
      return {
        tone: 'caution',
        text: t('topics.verdicts.weak'),
      };
    case 'none':
      return {
        tone: 'empty',
        text: t('topics.verdicts.none'),
      };
    case 'unavailable':
      return { tone: 'empty', text: universeMessage(resolution.universe.state) };
  }
}

function universeMessage(state: UniverseState): string {
  switch (state) {
    case 'not_loaded':
    case 'not_embedded':
      return t(`topics.universe.${state}`);
    // Resolution runs in both of these states; `unavailable` never carries them.
    case 'partially_embedded':
    case 'ready':
      return t('topics.universe.available');
  }
}

/** A note when only part of the universe could be searched, or null. */
export function coverageNote(universe: TopicResolveResponse['universe']): string | null {
  if (universe.state !== 'partially_embedded') return null;
  return t('topics.partialCoverage', {
    embedded: formatNumber(universe.embedded),
    profiles: formatNumber(universe.profiles),
  });
}

// --- The topic card: news and tone ------------------------------------------

/**
 * What an empty news list says. Three different situations look identical as
 * an empty array, and only one of them is "a quiet week": the card must not
 * call a week quiet when the app could not read the news.
 */
export function newsEmptyMessage(
  collection: NewsCollectionState | null | undefined,
  days: number,
  /** What the news is about: a topic's instruments, or one holding. */
  subject: string = t('topics.news.thisTopicsInstruments'),
): string {
  // Undefined too: an orchestrator older than this field sends none, and that
  // must not read as a failed collection.
  if (!collection) {
    return t('topics.news.notCollected');
  }
  if (collection.status === 'ok' || collection.status === 'skipped') {
    return t('topics.news.quiet', { subject, days });
  }
  const who =
    collection.failedProviders.length > 0
      ? t('topics.news.failedProviders', { providers: collection.failedProviders.join(t('common.listSeparator')) })
      : '';
  return t('topics.news.unreachable', { who });
}

/**
 * A sentiment score ("0.4125", -1..1 as a decimal string) with a sign and two
 * decimals: "+0.41". Truncated on the digits rather than rounded through a
 * float, like `fundShare`, so the figure shown never exceeds the stored one.
 */
export function signedScore(score: string): string {
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(score.trim());
  if (!match) return score;
  const [, minus, whole = '0', fraction = ''] = match;
  const shown = `${whole}.${fraction.slice(0, 2).padEnd(2, '0')}`;
  if (/^0\.00$/.test(shown)) return '0.00';
  return `${minus ? '−' : '+'}${shown}`;
}

/** Why there is no tone, in words. A null score is never shown as 0. */
function gapText(gap: TopicSentimentGap): string {
  return t(`topics.tone.gaps.${gap}`);
}

/**
 * The tone line of a topic card: the score with the counts it rests on, or the
 * named reason there is none.
 */
export function sentimentSummary(sentiment: TopicSentimentResponse): {
  score: string | null;
  text: string;
} {
  const { counts, days } = sentiment;
  if (sentiment.score === null) {
    const gap = sentiment.gap ?? 'no_articles';
    return { score: null, text: gapText(gap) };
  }
  const tones = t('topics.tone.counts', {
    positive: counts.positive,
    negative: counts.negative,
    neutral: counts.neutral,
  });
  return {
    score: signedScore(sentiment.score),
    text: t('topics.tone.summary', {
      days,
      articles: t('topics.tone.articles', { count: counts.articles }),
      tones,
    }),
  };
}
