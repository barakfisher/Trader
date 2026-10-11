import type { AlertSource } from '@traders/shared';

/**
 * Which tab of the Insights page the address asks for (decision 134).
 *
 * Each tab answers one question: Alerts - what was I told; Proposals - what do I
 * owe an answer to; Digest - what the daily summary carried; All findings -
 * everything the engine noticed. `observations` stays the address of the last,
 * as it was before the tabs, so links sent since UX3 still land on the feed.
 *
 * Like the feed's filters (`feedFilters.ts`), the address is typed by whoever
 * sends a link, so anything unrecognised is the default tab rather than an
 * error: `?tab=news` is Alerts.
 */
export const INSIGHTS_TABS = ['alerts', 'proposals', 'digest', 'observations'] as const;

export type InsightsTab = (typeof INSIGHTS_TABS)[number];

/** The tab an address without one, or with one we do not know, opens on. */
export const DEFAULT_INSIGHTS_TAB: InsightsTab = 'alerts';

export function insightsTabFrom(search: unknown): InsightsTab {
  const params = (search ?? {}) as Record<string, unknown>;
  return INSIGHTS_TABS.find((tab) => tab === params.tab) ?? DEFAULT_INSIGHTS_TAB;
}

const ALERT_SOURCES: readonly AlertSource[] = ['portfolio', 'topics', 'agents'];

/** The Alerts tab's source pill; undefined is "All". An unknown value is "All" too. */
export function alertSourceFrom(search: unknown): AlertSource | undefined {
  const params = (search ?? {}) as Record<string, unknown>;
  return ALERT_SOURCES.find((source) => source === params.source);
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
