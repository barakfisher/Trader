/**
 * The holdings as a file to save (UX6): `traders-holdings-2026-10-08.json`,
 * in the shape the import wizard reads (`holdingsExport` in `@traders/shared`).
 *
 * Built in the browser from the portfolio already on screen - the stored
 * values the server sent, not the figures the table formats - so exporting
 * needs no endpoint of its own. The date in the name is "today" where the user
 * is, like every other date the app shows.
 */

import { holdingsExport, type HoldingView } from '@traders/shared';

import { getDisplayTimeZone } from './relativeTime.ts';

/** `traders-holdings-YYYY-MM-DD.json`, the date in `timeZone`. */
export function holdingsFilename(now: Date, timeZone: string): string {
  // en-CA formats a date as YYYY-MM-DD.
  const day = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return `traders-holdings-${day}.json`;
}

export function downloadHoldings(holdings: HoldingView[], now: Date = new Date()): void {
  const body = JSON.stringify(holdingsExport(holdings, now), null, 2);
  const url = URL.createObjectURL(new Blob([`${body}\n`], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = holdingsFilename(now, getDisplayTimeZone());
  link.click();
  // After the click has handed the file to the browser, not before.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
