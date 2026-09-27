/**
 * When two topics are "the same theme": the rule behind rejection memory (FR-11).
 *
 * A proposal is suppressed when it matches a topic by **either** of two tests:
 *
 * - **Words.** Every meaningful word of the other label appears in the new one.
 *   Case, plurals and filler words are ignored, so after "uranium" is rejected,
 *   "Uranium miners" is suppressed too. The containment runs one way on purpose:
 *   the new proposal is the one being judged, and a broader label than a rejected
 *   one ("energy" after "nuclear energy") is a different claim about interest.
 * - **Instruments.** At least `INSTRUMENT_OVERLAP` of the new proposal's
 *   instruments are in the other topic's set. This catches a re-wording the
 *   word test cannot see: "nuclear fuel" after "uranium" names the same miners.
 *   Measured over the *new* proposal's set, because the question is "is what we
 *   would show mostly something the user already turned down?".
 *
 * **Why both, and why it errs towards suppressing.** Either test alone lets a
 * rejected theme back in: words miss re-wordings, and instruments miss an exact
 * repeat whenever the universe shifts enough to move the resolver's picks.
 * Suppressing too much costs a suggestion the user might have liked; suppressing
 * too little shows them something they already said no to, which is the one
 * failure rejection memory exists to prevent. That asymmetry decides the ties.
 *
 * The same rule decides whether a theme is something the user *already* follows
 * or has pending, so "is this new?" and "was this rejected?" cannot disagree.
 * Rejected topics only count inside the cooldown (`TOPIC_REJECTION_COOLDOWN_DAYS`).
 */

/**
 * The fraction of a new proposal's instruments that, if already in another
 * topic's set, makes it that topic. Half: a proposal that is mostly a rejected
 * basket is that basket with a new name. A product bound; nothing measured it.
 */
export const INSTRUMENT_OVERLAP = 0.5;

/**
 * Words that carry no theme. The resolver's rationale stopwords plus the words
 * people add to a theme without changing it ("uranium stocks" is "uranium").
 */
const FILLER_WORDS = new Set([
  'a', 'an', 'and', 'the', 'of', 'in', 'on', 'for', 'to', 'with', 'its', 'it', 'is',
  'are', 'as', 'by', 'or', 'at', 'from', 'that', 'this',
  'company', 'companies', 'inc', 'corporation',
  'stock', 'stocks', 'share', 'shares', 'sector', 'industry', 'theme', 'market',
  'markets', 'play', 'plays', 'etf', 'etfs', 'fund', 'funds',
]);

/** 'miners' meets 'miner'; the same crude rule as the AI service's `fold`. */
export function foldPlural(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

/**
 * The words a label is compared by: lower-case, filler removed, plurals folded,
 * de-duplicated and sorted, so the stored form is stable and readable in psql.
 */
export function matchWords(label: string): string[] {
  const words = label.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return [...new Set(words.filter((w) => !FILLER_WORDS.has(w)).map(foldPlural))].sort();
}

/** A theme as the rule sees it: its words and its instrument ids. */
export interface ThemeFingerprint {
  words: readonly string[];
  instrumentIds: readonly string[];
}

/** A topic the new proposal is compared against, and why it counts. */
export interface KnownTheme extends ThemeFingerprint {
  topicId: string;
  label: string;
  status: 'active' | 'proposed' | 'rejected';
}

export type MatchReason = 'words' | 'instruments';

/** Does every word of `known` appear in `candidate`? A wordless label matches nothing. */
export function wordsCovered(candidate: readonly string[], known: readonly string[]): boolean {
  if (known.length === 0) return false;
  const have = new Set(candidate);
  return known.every((word) => have.has(word));
}

/** The fraction of `candidate`'s instruments that are in `known`; 0 for an empty candidate. */
export function instrumentOverlap(candidate: readonly string[], known: readonly string[]): number {
  const unique = new Set(candidate);
  if (unique.size === 0) return 0;
  const other = new Set(known);
  let shared = 0;
  for (const id of unique) if (other.has(id)) shared += 1;
  return shared / unique.size;
}

/** Why `candidate` is the same theme as `known`, or null if it is not. Words are checked first. */
export function matchReason(candidate: ThemeFingerprint, known: ThemeFingerprint): MatchReason | null {
  if (wordsCovered(candidate.words, known.words)) return 'words';
  if (instrumentOverlap(candidate.instrumentIds, known.instrumentIds) >= INSTRUMENT_OVERLAP) {
    return 'instruments';
  }
  return null;
}

/** The first known theme `candidate` matches, with the reason; null if it is new. */
export function firstMatch(
  candidate: ThemeFingerprint,
  known: readonly KnownTheme[],
): { theme: KnownTheme; reason: MatchReason } | null {
  for (const theme of known) {
    const reason = matchReason(candidate, theme);
    if (reason) return { theme, reason };
  }
  return null;
}
