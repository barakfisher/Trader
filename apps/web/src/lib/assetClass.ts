/**
 * An asset class in words. The server sends a code (`equity`) and, for the
 * allocation chart, an English group name ("Stocks"); both are interface
 * vocabulary rather than generated text, so they are read from the catalogue
 * by code. A code this build does not know is shown as it came.
 */

import { i18n, t } from '../i18n/index.ts';

type Known = 'equity' | 'etf' | 'crypto' | 'fx' | 'index' | 'unknown';

function known(code: string): code is Known {
  return i18n.exists(`assetClasses.one.${code}`);
}

/** One instrument's class: "equity", "קרן סל". */
export function assetClassName(code: string): string {
  return known(code) ? t(`assetClasses.one.${code}`) : code;
}

/** A group of them, as the allocation chart labels a slice: "Stocks". */
export function assetClassGroup(code: string, fallback: string): string {
  return known(code) ? t(`assetClasses.groups.${code}`) : fallback;
}
