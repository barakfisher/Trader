/**
 * How a topic resolution is put into words on the confirm screen.
 *
 * Kept out of the component for the reason `observationPresentation.ts` is:
 * the sentences here make claims ("nothing in the universe is about this",
 * "this installation has no universe loaded"), and a claim is worth a test.
 */

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
