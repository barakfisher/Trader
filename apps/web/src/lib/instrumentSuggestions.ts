/**
 * Which listings to offer while a symbol is typed (D324).
 *
 * The local directory is matched in the browser: symbols that start with what
 * was typed come first (from one character, since "F" is a symbol), then names
 * that contain it (from NAME_MATCH_MIN_LENGTH characters, since one letter is
 * in almost every name). Only when nothing local matches does the form ask the
 * market-data provider's search.
 */

import type { InstrumentSuggestion } from '@traders/shared';

/** The most suggestions the list shows - the AI service's search returns as many. */
export const SUGGESTION_LIMIT = 8;
/** A name is searched from this many characters. */
export const NAME_MATCH_MIN_LENGTH = 2;
/** How long typing must pause before the provider is asked. */
export const SEARCH_DEBOUNCE_MS = 300;

export function matchDirectory(
  directory: readonly InstrumentSuggestion[],
  typed: string,
  limit = SUGGESTION_LIMIT,
): InstrumentSuggestion[] {
  const needle = typed.trim().toLowerCase();
  if (!needle) return [];
  const exact: InstrumentSuggestion[] = [];
  const prefix: InstrumentSuggestion[] = [];
  const byName: InstrumentSuggestion[] = [];
  for (const entry of directory) {
    const symbol = entry.symbol.toLowerCase();
    if (symbol === needle) exact.push(entry);
    else if (symbol.startsWith(needle)) prefix.push(entry);
    else if (needle.length >= NAME_MATCH_MIN_LENGTH && entry.name?.toLowerCase().includes(needle)) {
      byName.push(entry);
    }
  }
  // Shorter symbols first among prefixes: typing "SP" should offer SPY before SPYG.
  prefix.sort((a, b) => a.symbol.length - b.symbol.length || a.symbol.localeCompare(b.symbol));
  return [...exact, ...prefix, ...byName].slice(0, limit);
}
