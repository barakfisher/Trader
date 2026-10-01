/**
 * The universe's status for the admin page: the snapshot, the database, and
 * every difference between them either named or flagged (decision 86).
 *
 * The reasons are the loader's own. It is the code that skipped each row, so
 * it is the one that knows why; the page only checks the sums. Anything the
 * sums leave over - a profile deleted by hand, a loader that skipped
 * something without counting it - shows up as `unexplained`, which is exactly
 * the disagreement the page exists to make visible. On-demand profiles
 * (decision 89) are not members and are counted apart, never against the
 * snapshot. Measured on the 2026-09-24 snapshot: 71 members without a
 * description, and 33 holding rows (19 implausible weights, 14 of three
 * unprofiled funds) - with those named, nothing is left over.
 */

import type { UniverseReconciliation, UniverseStatusResponse } from '@traders/shared';

import type { UniverseCountsRow, UniverseLoadRow } from '../db/queries.js';

function reconcile(
  what: UniverseReconciliation['what'],
  inSnapshot: number,
  inDatabase: number,
  reasons: [string, number][],
): UniverseReconciliation {
  const explained = reasons
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => ({ reason, count }));
  const accounted = explained.reduce((total, difference) => total + difference.count, 0);
  return { what, inSnapshot, inDatabase, explained, unexplained: inSnapshot - inDatabase - accounted };
}

function numbers(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
  );
}

export function universeStatus(
  load: UniverseLoadRow | null,
  counts: UniverseCountsRow,
): UniverseStatusResponse {
  const database = {
    profiles: counts.profiles,
    equities: counts.equities,
    etfs: counts.etfs,
    embedded: counts.embedded,
    etfHoldings: counts.etf_holdings,
    onDemand: counts.on_demand,
  };
  if (!load) return { lastLoad: null, database, reconciliation: [] };

  const report = numbers(load.report);
  const count = (key: string) => report[key] ?? 0;
  return {
    lastLoad: {
      loadedAt: new Date(load.loaded_at).toISOString(),
      snapshotAsOf: new Date(load.snapshot_as_of).toISOString(),
      source: load.source,
      manifestCounts: numbers(load.manifest?.counts),
    },
    database,
    reconciliation: [
      reconcile('members', count('members'), counts.profiles, [
        ['no description on this installation', count('undescribed')],
        ['no currency reported by the provider', count('no_currency')],
      ]),
      reconcile('etf_holdings', count('holding_rows'), counts.etf_holdings, [
        ['weight is not a fraction of the fund', count('holdings_implausible')],
        ['the fund has no profile here', count('holdings_of_unprofiled_etf')],
      ]),
    ],
  };
}
