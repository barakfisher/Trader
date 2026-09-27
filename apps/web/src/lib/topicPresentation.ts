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
  return `held by ${heldBy.map((h) => `${h.etf} ${fundShare(h.weight)}`).join(', ')}`;
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
        text: 'These are weak matches: the closest descriptions are only loosely about this topic. Keep only what you recognise, and add what is missing.',
      };
    case 'none':
      return {
        tone: 'empty',
        text: 'Nothing in the instrument universe describes itself as being about this topic. You can still add tickers yourself.',
      };
    case 'unavailable':
      return { tone: 'empty', text: universeMessage(resolution.universe.state) };
  }
}

function universeMessage(state: UniverseState): string {
  switch (state) {
    case 'not_loaded':
      return 'No suggestions: this installation has no instrument universe loaded, so the topic was not looked up. You can still add tickers yourself.';
    case 'not_embedded':
      return 'No suggestions: the instrument universe is loaded but not indexed for the configured embedding model, so the topic was not looked up. You can still add tickers yourself.';
    // Resolution runs in both of these states; `unavailable` never carries them.
    case 'partially_embedded':
    case 'ready':
      return 'No suggestions are available right now. You can still add tickers yourself.';
  }
}

/** A note when only part of the universe could be searched, or null. */
export function coverageNote(universe: TopicResolveResponse['universe']): string | null {
  if (universe.state !== 'partially_embedded') return null;
  return `Only ${universe.embedded.toLocaleString('en-US')} of ${universe.profiles.toLocaleString('en-US')} instruments could be searched, so some matches may be missing.`;
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
): string {
  // Undefined too: an orchestrator older than this field sends none, and that
  // must not read as a failed collection.
  if (!collection) {
    return 'News has not been collected yet, so there is nothing to show here.';
  }
  if (collection.status === 'ok' || collection.status === 'skipped') {
    return `No news about this topic’s instruments in the last ${days} days.`;
  }
  const who = collection.failedProviders.length > 0 ? ` (${collection.failedProviders.join(', ')})` : '';
  return (
    `No news to show, but that may not mean a quiet week: the last news collection could not ` +
    `reach its sources${who}, so stories may be missing.`
  );
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
const GAP_TEXT: Record<TopicSentimentGap, string> = {
  no_articles: 'No tone yet: there were no articles to read.',
  not_scored: 'No tone yet: the articles have not been scored.',
  too_few_polarised: 'Too little to judge: too few articles expressed any tone.',
};

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
    return { score: null, text: GAP_TEXT[gap] };
  }
  const tones = `${counts.positive} positive, ${counts.negative} negative, ${counts.neutral} neutral`;
  return {
    score: signedScore(sentiment.score),
    text: `Headline tone over ${days} days, from ${counts.articles} article${
      counts.articles === 1 ? '' : 's'
    } (${tones}). A word count, not a forecast.`,
  };
}
