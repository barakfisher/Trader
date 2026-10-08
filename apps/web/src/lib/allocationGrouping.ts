/**
 * How the allocation donut groups the portfolio, and the viewer's last choice.
 *
 * By holding is the default: it answers "what do I own" at a glance, and by
 * class is one click away. The choice is a per-browser convenience, so it lives
 * in `localStorage` rather than on the server - and every access is guarded,
 * because storage can be blocked or throw (a private window, cleared site
 * data), and the chart must draw the default when it does.
 */
export type AllocationGrouping = 'instrument' | 'assetClass';

export const DEFAULT_ALLOCATION_GROUPING: AllocationGrouping = 'instrument';

export const ALLOCATION_GROUPING_KEY = 'traders.allocation.groupBy';

export function readAllocationGrouping(): AllocationGrouping {
  try {
    const stored = window.localStorage.getItem(ALLOCATION_GROUPING_KEY);
    return stored === 'instrument' || stored === 'assetClass' ? stored : DEFAULT_ALLOCATION_GROUPING;
  } catch {
    return DEFAULT_ALLOCATION_GROUPING;
  }
}

export function rememberAllocationGrouping(grouping: AllocationGrouping): void {
  try {
    window.localStorage.setItem(ALLOCATION_GROUPING_KEY, grouping);
  } catch {
    // Not remembered: the next visit starts from the default, which is harmless.
  }
}
