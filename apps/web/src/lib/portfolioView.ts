/**
 * Facts about a valued portfolio that the server does not state directly but
 * the screen must: how old its prices are, and whether any are cached.
 */

import type { PortfolioResponse } from '@traders/shared';

/**
 * The oldest observation time among priced holdings, as an ISO string.
 *
 * This is what the header should show, and it is not the same thing as the
 * time the response arrived. Quotes come from a delayed feed and are dated to
 * the provider's observation window, so a portfolio fetched seconds ago can be
 * built entirely from prices that were true twenty minutes ago. Reporting the
 * fetch time as though it were the price time is the same misrepresentation
 * the backend used to make when it stamped every quote with `now()`.
 */
export function pricesAsOf(portfolio: PortfolioResponse | undefined): string | null {
  const times = (portfolio?.holdings ?? [])
    .map((holding) => holding.quote?.asOf)
    .filter((asOf): asOf is string => Boolean(asOf));
  if (times.length === 0) return null;
  return times.reduce((oldest, current) => (current < oldest ? current : oldest));
}

/** True when any displayed price came from a cached last-known-good value. */
export function hasStaleQuotes(portfolio: PortfolioResponse | undefined): boolean {
  return (portfolio?.holdings ?? []).some((holding) => holding.quote?.stale === true);
}

/**
 * The currency every total is in: the portfolio's, else the account's, else USD
 * (guideline 10) while neither has loaded.
 */
export function baseCurrencyOf(
  portfolio: PortfolioResponse | undefined,
  accountCurrency?: string,
): string {
  return portfolio?.summary.baseCurrency ?? accountCurrency ?? 'USD';
}

/** An FX rate (a decimal string) cut to four places on its digits - never rounded through a float. */
export function shortRate(rate: string): string {
  return rate.replace(/(\.\d{4})\d+$/, '$1');
}
