/**
 * The feed's filters as the Insights page's address carries them.
 *
 * The address is typed by whoever sends a link, so anything this does not
 * recognise is dropped rather than trusted: `?severity=urgent` is the unfiltered
 * feed, not an error page and not a request the server would refuse.
 */

import type { FeedFilters } from '../queries/observations.ts';

const SEVERITIES = new Set(['notable', 'high']);
const SYMBOL = /^[A-Z0-9.\-^=]{1,32}$/;

export function feedFiltersFrom(search: unknown): FeedFilters {
  const params = (search ?? {}) as Record<string, unknown>;
  const filters: FeedFilters = {};
  if (typeof params.severity === 'string' && SEVERITIES.has(params.severity)) {
    filters.severity = params.severity as FeedFilters['severity'];
  }
  if (typeof params.symbol === 'string') {
    const symbol = params.symbol.trim().toUpperCase();
    if (SYMBOL.test(symbol)) filters.symbol = symbol;
  }
  return filters;
}
