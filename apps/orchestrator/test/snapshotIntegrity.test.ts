/**
 * What `takeSnapshot` commits to the equity curve.
 *
 * Snapshots are historical facts: written once, never recomputed. So the row's
 * own record of how complete its pricing was is the only thing standing between
 * a missing price and M2 explaining a crash that never happened. The database
 * layer is mocked, as in app.test.ts, so these assertions are about the row we
 * would write rather than about Postgres.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HoldingRow } from '../src/db/queries.js';

const USER = {
  id: '00000000-0000-0000-0000-000000000001',
  email: null,
  base_currency: 'USD',
  timezone: 'Asia/Jerusalem',
  role: 'admin' as const,
};

function holding(symbol: string, quantity: string, assetClass = 'equity'): HoldingRow {
  return {
    id: `holding-${symbol}`,
    user_id: USER.id,
    instrument_id: `instrument-${symbol}`,
    quantity,
    cost_basis_minor: '10000',
    currency: 'USD',
    opened_at: null,
    notes: null,
    symbol,
    name: symbol,
    asset_class: assetClass,
    exchange: 'TEST',
    instrument_currency: 'USD',
  } as HoldingRow;
}

const holdings: HoldingRow[] = [];

vi.mock('../src/db/queries.js', () => ({
  listHoldings: vi.fn(async () => holdings),
  upsertSnapshot: vi.fn(async () => undefined),
}));

const { listHoldings, upsertSnapshot } = await import('../src/db/queries.js');
const { takeSnapshot } = await import('../src/services/snapshot.js');
const { createFakeAi } = await import('./fakeAi.js');

/** The single row `takeSnapshot` wrote, or undefined if it wrote nothing. */
function writtenRow() {
  return vi.mocked(upsertSnapshot).mock.calls[0]?.[0];
}

describe('takeSnapshot integrity', () => {
  beforeEach(() => {
    vi.mocked(upsertSnapshot).mockClear();
    vi.mocked(listHoldings).mockClear();
    holdings.length = 0;
  });

  it('stores a fully priced portfolio as complete', async () => {
    holdings.push(holding('AAPL', '10'), holding('VOO', '5', 'etf'));

    const result = await takeSnapshot(USER, createFakeAi());

    // 10 x 232.14 + 5 x 512.08 = 4881.80
    expect(result.totalMinor).toBe(488180);
    expect(result.skipped).toBe(false);
    expect(result.degraded).toBe(false);
    expect(writtenRow()).toMatchObject({
      totalMinor: 488180,
      holdingsCount: 2,
      pricedCount: 2,
      degraded: false,
    });
  });

  it('stores a partially priced portfolio, marked, rather than silently understating it', async () => {
    holdings.push(holding('AAPL', '10'), holding('VOO', '5', 'etf'));

    const result = await takeSnapshot(USER, createFakeAi({ unpriceable: ['VOO'] }));

    // The total is what could be priced - the VOO position is simply absent from
    // it - which is exactly why the row has to say so.
    expect(result.totalMinor).toBe(232140);
    expect(result.skipped).toBe(false);
    expect(result.degraded).toBe(true);
    const row = writtenRow();
    expect(row).toMatchObject({ totalMinor: 232140, holdingsCount: 2, pricedCount: 1, degraded: true });
    expect(row!.pricedCount).toBeLessThan(row!.holdingsCount);
  });

  it('marks the snapshot degraded when a quote was served stale', async () => {
    holdings.push(holding('AAPL', '10'), holding('VOO', '5', 'etf'));

    const result = await takeSnapshot(USER, createFakeAi({ stale: ['VOO'] }));

    // Every holding priced, so the counts match; the total is still approximate.
    expect(result.degraded).toBe(true);
    expect(writtenRow()).toMatchObject({ holdingsCount: 2, pricedCount: 2, degraded: true });
  });

  it('refuses to write when no holding could be priced', async () => {
    holdings.push(holding('AAPL', '10'), holding('VOO', '5', 'etf'));

    const result = await takeSnapshot(USER, createFakeAi({ unpriceable: ['AAPL', 'VOO'] }));

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no holding could be priced');
    expect(upsertSnapshot).not.toHaveBeenCalled();
  });

  it('writes nothing for a user with no holdings', async () => {
    const result = await takeSnapshot(USER, createFakeAi());

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no holdings');
    expect(upsertSnapshot).not.toHaveBeenCalled();
  });
});
