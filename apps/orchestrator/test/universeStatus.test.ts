/**
 * The universe status reconciles the database against the loader's own
 * account, so a known difference is named and only a remainder is flagged.
 * The numbers are the 2026-09-24 snapshot as this installation loaded it.
 */

import { describe, expect, it } from 'vitest';

import { universeStatus } from '../src/services/universeStatus.js';

const LOAD = {
  snapshot_as_of: new Date('2026-09-24T12:04:35Z'),
  source: 'yahoo-finance:longBusinessSummary',
  manifest: { as_of: '2026-09-24T12:04:35Z', counts: { kept: 5294, equities: 2592, etfs: 2702 } },
  report: {
    members: 5294,
    profiled: 5223,
    undescribed: 71,
    no_currency: 0,
    holding_rows: 16396,
    holdings_stored: 16363,
    holdings_implausible: 19,
    holdings_of_unprofiled_etf: 14,
  },
  loaded_at: new Date('2026-09-30T21:47:00Z'),
};

const COUNTS = {
  profiles: 5223,
  equities: 2534,
  etfs: 2689,
  embedded: 5223,
  etf_holdings: 16363,
  on_demand: 0,
  dropped: 0,
};

describe('the universe status', () => {
  it('names every difference between the snapshot and the database, leaving none unexplained', () => {
    const status = universeStatus(LOAD, COUNTS);
    expect(status.reconciliation).toEqual([
      {
        what: 'members',
        inSnapshot: 5294,
        inDatabase: 5223,
        explained: [{ reason: 'no description on this installation', count: 71 }],
        unexplained: 0,
      },
      {
        what: 'etf_holdings',
        inSnapshot: 16396,
        inDatabase: 16363,
        explained: [
          { reason: 'weight is not a fraction of the fund', count: 19 },
          { reason: 'the fund has no profile here', count: 14 },
        ],
        unexplained: 0,
      },
    ]);
    expect(status.lastLoad).toMatchObject({
      snapshotAsOf: '2026-09-24T12:04:35.000Z',
      manifestCounts: { kept: 5294, equities: 2592, etfs: 2702 },
    });
  });

  it('flags what the loader did not explain - here, profiles removed since it ran', () => {
    const status = universeStatus(LOAD, { ...COUNTS, profiles: 5220 });
    expect(status.reconciliation[0]!.unexplained).toBe(3);
  });

  it('flags the database holding more than the snapshot as a negative remainder', () => {
    // A screened profile no load accounts for - written by hand, say.
    const status = universeStatus(LOAD, { ...COUNTS, profiles: 5224 });
    expect(status.reconciliation[0]!.unexplained).toBe(-1);
  });

  it('does not count a member that kept an earlier profile among the missing', () => {
    // The first real rescreen: 72 members without a description, 4 of which
    // still held the profile an earlier snapshot gave them.
    const rescreened = {
      ...LOAD,
      report: { ...LOAD.report, members: 5289, profiled: 5217, undescribed: 72, undescribed_kept: 4 },
    };
    const status = universeStatus(rescreened, { ...COUNTS, profiles: 5221 });
    expect(status.reconciliation[0]).toMatchObject({
      explained: [{ reason: 'no description on this installation', count: 68 }],
      unexplained: 0,
    });
  });

  it('counts on-demand profiles apart, so they leave the reconciliation alone', () => {
    const status = universeStatus(LOAD, { ...COUNTS, on_demand: 2 });
    expect(status.database.onDemand).toBe(2);
    expect(status.reconciliation[0]!.unexplained).toBe(0);
  });

  it('reports the database alone, and reconciles nothing, before any load is recorded', () => {
    const status = universeStatus(null, COUNTS);
    expect(status.lastLoad).toBeNull();
    expect(status.reconciliation).toEqual([]);
    expect(status.database.profiles).toBe(5223);
  });
});
