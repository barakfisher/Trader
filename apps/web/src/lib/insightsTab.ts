/**
 * Which tab of the Insights page the address asks for.
 *
 * Like the feed's filters (`feedFilters.ts`), the address is typed by whoever
 * sends a link, so anything unrecognised is the default tab rather than an
 * error: `?tab=news` is the observations feed.
 */
export type InsightsTab = 'observations' | 'digest';

export function insightsTabFrom(search: unknown): InsightsTab {
  const params = (search ?? {}) as Record<string, unknown>;
  return params.tab === 'digest' ? 'digest' : 'observations';
}

/**
 * Whether a dashboard address was a link to the feed. Before the Insights page
 * (UX3) the feed lived on the dashboard and its filters in the dashboard's
 * address, so `/?severity=high&symbol=NVDA` may still be bookmarked or sent.
 */
export function isLegacyFeedAddress(search: unknown): boolean {
  const params = (search ?? {}) as Record<string, unknown>;
  return params.severity !== undefined || params.symbol !== undefined;
}
