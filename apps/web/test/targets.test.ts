/**
 * The target-weights form: the unit conversion underneath it, and the rules it
 * applies to a draft before the server ever sees one.
 *
 * Two things here are worth more than the rest. The conversion between the
 * percentage a user types and the decimal string the column stores must lose
 * nothing in either direction, because the number that comes back is one they
 * will compare against the drift reported to them. And an empty box must stay
 * distinguishable from a target of zero: the first can never produce a finding,
 * the second means "I meant to hold none of this" and makes everything still
 * held count as drift. Collapsing those two deletes a statement the user made.
 *
 * The API client is mocked, as in settings.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PortfolioResponse, TargetsResponse } from '@traders/shared';

const get = vi.fn();
const post = vi.fn();
const postForm = vi.fn();
const patch = vi.fn();
const put = vi.fn();
const del = vi.fn();

vi.mock('../src/api/client.ts', () => ({
  api: { get, post, postForm, patch, put, delete: del },
  ApiRequestError: class ApiRequestError extends Error {
    constructor(
      message: string,
      readonly status = 500,
      readonly code = 'error',
    ) {
      super(message);
    }
  },
}));

const { RootStore } = await import('../src/stores/RootStore.ts');
const { ApiRequestError } = await import('../src/api/client.ts');
const {
  DRIFT_BANDS,
  UNITS_PER_PERCENT,
  WEIGHT_UNITS_PER_PORTFOLIO,
  driftSeverity,
  formatDriftPoints,
  percentToUnits,
  unitsToPercent,
  unitsToWeight,
  weightToUnits,
} = await import('../src/lib/targetWeights.ts');

function holding(symbol: string, weightPct: number | null) {
  return {
    id: `holding-${symbol}`,
    instrument: {
      id: `instrument-${symbol}`,
      symbol,
      name: `${symbol} Inc.`,
      assetClass: 'equity' as const,
      exchange: 'NASDAQ',
      currency: 'USD',
    },
    quantity: '10',
    costBasisMinor: null,
    costCurrency: 'USD',
    openedAt: null,
    notes: null,
    quote: null,
    valueMinor: weightPct === null ? null : 100_000,
    costMinor: null,
    pnlMinor: null,
    pnlPct: null,
    weightPct,
    fxRate: null,
  };
}

function portfolio(
  holdings: ReturnType<typeof holding>[],
  unpricedSymbols: string[] = [],
): PortfolioResponse {
  return {
    summary: {
      baseCurrency: 'USD',
      totalValueMinor: 1_000_000,
      totalCostMinor: 900_000,
      pnlMinor: 100_000,
      pnlPct: 11.1,
      dayChangeMinor: null,
      dayChangePct: null,
      holdingsCount: holdings.length,
      pricedCount: holdings.length - unpricedSymbols.length,
      unpricedSymbols,
      degraded: unpricedSymbols.length > 0,
      asOf: '2026-09-17T10:00:00.000Z',
    },
    holdings: holdings as PortfolioResponse['holdings'],
    allocationByInstrument: [],
    allocationByAssetClass: [],
  };
}

const STORED: TargetsResponse = {
  targets: [
    { symbol: 'AAPL', name: 'Apple Inc.', weight: '0.4000' },
    { symbol: 'MSFT', name: 'Microsoft Corp.', weight: '0.2500' },
  ],
};

async function loadedStore(
  holdings = [holding('AAPL', 50), holding('MSFT', 20)],
  targets: TargetsResponse = STORED,
  unpricedSymbols: string[] = [],
) {
  const root = new RootStore();
  get.mockResolvedValueOnce(portfolio(holdings, unpricedSymbols));
  await root.portfolio.load();
  get.mockResolvedValueOnce(targets);
  await root.targets.load();
  return root;
}

describe('target weight units', () => {
  it('round-trips a percentage through the units the column stores', () => {
    for (const percent of ['0', '0.01', '5', '12.34', '33.33', '99.99', '100']) {
      const units = percentToUnits(percent);
      expect(units).not.toBeNull();
      expect(unitsToPercent(units as number)).toBe(percent === '0' ? '0' : percent);
      expect(weightToUnits(unitsToWeight(units as number))).toBe(units);
    }
  });

  it('writes the weight in the decimal string the API stores', () => {
    expect(unitsToWeight(2500)).toBe('0.2500');
    expect(unitsToWeight(WEIGHT_UNITS_PER_PORTFOLIO)).toBe('1.0000');
    expect(unitsToWeight(1)).toBe('0.0001');
  });

  it('reads a stored weight back without a float in between', () => {
    expect(weightToUnits('0.4000')).toBe(4000);
    expect(weightToUnits('0.0001')).toBe(1);
    expect(weightToUnits('1.0000')).toBe(WEIGHT_UNITS_PER_PORTFOLIO);
  });

  it('shows the shortest percentage that means the same thing', () => {
    expect(unitsToPercent(2500)).toBe('25');
    expect(unitsToPercent(2550)).toBe('25.5');
    expect(unitsToPercent(2505)).toBe('25.05');
  });

  it('treats an empty box as no target and zero as a target of zero', () => {
    expect(percentToUnits('')).toBeNull();
    expect(percentToUnits('   ')).toBeNull();
    expect(percentToUnits('0')).toBe(0);
  });

  it('accepts a half-typed decimal, so the error does not flash between keystrokes', () => {
    expect(percentToUnits('25.')).toBe(25 * UNITS_PER_PERCENT);
    expect(percentToUnits('25.5')).toBe(2550);
  });

  it('refuses text that is not a percentage, rather than salvaging a number from it', () => {
    for (const text of ['abc', '1e2', '-5', '25%', '1.234', '1,5']) {
      expect(percentToUnits(text)).toBeNull();
    }
  });

  it('bands a drift by size in either direction, and reports none below the floor', () => {
    expect(driftSeverity(DRIFT_BANDS.info - 1)).toBeNull();
    expect(driftSeverity(DRIFT_BANDS.info)).toBe('info');
    expect(driftSeverity(-DRIFT_BANDS.notable)).toBe('notable');
    expect(driftSeverity(DRIFT_BANDS.high)).toBe('high');
  });

  it('signs a drift in percentage points, which is what the feed quotes', () => {
    expect(formatDriftPoints(320)).toBe('+3.2pp');
    expect(formatDriftPoints(-320)).toBe('−3.2pp');
    expect(formatDriftPoints(0)).toBe('0pp');
  });
});

describe('TargetsStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('holds nothing until a load succeeds, and says so', async () => {
    const root = new RootStore();
    expect(root.targets.isEmpty).toBe(true);
    get.mockRejectedValueOnce(new ApiRequestError('Cannot reach the server.', 0, 'network_error'));
    await root.targets.load();
    expect(root.targets.error).toBe('Cannot reach the server.');
    expect(root.targets.isEmpty).toBe(true);
  });

  it('gives every holding a row, whether or not it has a target', async () => {
    const root = await loadedStore([
      holding('AAPL', 50),
      holding('MSFT', 20),
      holding('NVDA', 30),
    ]);
    expect(root.targets.rows.map((row) => row.symbol)).toEqual(['AAPL', 'NVDA', 'MSFT']);
    expect(root.targets.rows.find((row) => row.symbol === 'NVDA')?.targetText).toBe('');
  });

  it('keeps a target on something no longer held, and calls the whole position drift', async () => {
    const root = await loadedStore([holding('AAPL', 100)]);
    const msft = root.targets.rows.find((row) => row.symbol === 'MSFT');
    expect(msft?.held).toBe(false);
    // Nothing held against a 25% target is a drift of the whole target.
    expect(msft?.actualUnits).toBe(0);
    expect(msft?.driftUnits).toBe(-2500);
    // Reported at whatever band the whole target clears — the band edges are
    // the engine's to retune, so the test names the constant, not its value.
    expect(Math.abs(msft?.driftUnits ?? 0)).toBeGreaterThanOrEqual(DRIFT_BANDS.high);
    expect(msft?.driftSeverity).toBe('high');
  });

  it('reports an unpriced holding as unknown rather than as a weight of zero', async () => {
    const root = await loadedStore(
      [holding('AAPL', null), holding('MSFT', 20)],
      STORED,
      ['AAPL'],
    );
    const aapl = root.targets.rows.find((row) => row.symbol === 'AAPL');
    expect(aapl?.actualUnits).toBeNull();
    expect(aapl?.driftUnits).toBeNull();
    expect(root.targets.driftBlockedBySymbols).toEqual(['AAPL']);
  });

  it('does not read an unloaded portfolio as an empty one', async () => {
    const root = new RootStore();
    get.mockResolvedValueOnce(STORED);
    await root.targets.load();
    // Without the portfolio the current weights are unknown, and claiming 0%
    // held against a 40% target would be a specific and wrong statement.
    expect(root.targets.rows.every((row) => row.actualUnits === null)).toBe(true);
    expect(root.targets.rows.every((row) => row.driftUnits === null)).toBe(true);
  });

  it('is not dirty until an edit actually changes a weight', async () => {
    const root = await loadedStore();
    expect(root.targets.isDirty).toBe(false);
    root.targets.setTarget('AAPL', '40');
    expect(root.targets.isDirty).toBe(false);
    root.targets.setTarget('AAPL', '40.5');
    expect(root.targets.isDirty).toBe(true);
  });

  it('treats clearing a box as removing the target, not as a target of zero', async () => {
    const root = await loadedStore();
    root.targets.clearTarget('MSFT');
    expect(root.targets.isDirty).toBe(true);
    put.mockResolvedValueOnce({
      targets: [{ symbol: 'AAPL', weight: '0.4000' }],
      count: 1,
      sum: '0.4000',
    });
    await root.targets.save();
    expect(put).toHaveBeenCalledWith('/targets', {
      targets: [{ symbol: 'AAPL', weight: '0.4000' }],
    });
  });

  it('sends an explicit zero, because meaning to hold none of something is a target', async () => {
    const root = await loadedStore();
    root.targets.setTarget('MSFT', '0');
    put.mockResolvedValueOnce({
      targets: [
        { symbol: 'AAPL', weight: '0.4000' },
        { symbol: 'MSFT', weight: '0.0000' },
      ],
      count: 2,
      sum: '0.4000',
    });
    await root.targets.save();
    expect(put).toHaveBeenCalledWith('/targets', {
      targets: [
        { symbol: 'AAPL', weight: '0.4000' },
        { symbol: 'MSFT', weight: '0.0000' },
      ],
    });
    // A 20% position against a 0% target is twenty points of drift.
    expect(root.targets.rows.find((row) => row.symbol === 'MSFT')?.driftUnits).toBe(2000);
  });

  it('refuses a set that adds up to more than the whole portfolio', async () => {
    const root = await loadedStore();
    root.targets.setTarget('AAPL', '80');
    root.targets.setTarget('MSFT', '30');
    expect(root.targets.totalUnits).toBe(110 * UNITS_PER_PERCENT);
    expect(root.targets.unallocatedUnits).toBe(-10 * UNITS_PER_PERCENT);
    expect(root.targets.blockingIssue).toContain('110%');
    expect(root.targets.canSave).toBe(false);
  });

  it('allows a set that covers only part of the portfolio', async () => {
    const root = await loadedStore();
    root.targets.setTarget('AAPL', '30');
    expect(root.targets.blockingIssue).toBeNull();
    expect(root.targets.canSave).toBe(true);
    expect(root.targets.unallocatedUnits).toBe(45 * UNITS_PER_PERCENT);
  });

  it('names the row whose text is not a weight', async () => {
    const root = await loadedStore();
    root.targets.setTarget('MSFT', 'a lot');
    expect(root.targets.rows.find((row) => row.symbol === 'MSFT')?.invalid).toBe(true);
    expect(root.targets.blockingIssue).toContain('MSFT');
    expect(root.targets.canSave).toBe(false);
  });

  it('keeps the edits on screen when a save fails', async () => {
    const root = await loadedStore();
    root.targets.setTarget('AAPL', '35');
    put.mockRejectedValueOnce(new ApiRequestError('Targets rejected.', 422, 'unknown_symbol'));
    await root.targets.save();
    expect(root.targets.rows.find((row) => row.symbol === 'AAPL')?.targetText).toBe('35');
    expect(root.targets.isDirty).toBe(true);
    expect(root.targets.error).toBe('Targets rejected.');
  });

  it('re-renders from the saved response rather than from what was typed', async () => {
    const root = await loadedStore();
    root.targets.setTarget('AAPL', '35');
    // The server is the authority on what was stored, down to the rounding.
    put.mockResolvedValueOnce({
      targets: [
        { symbol: 'AAPL', weight: '0.3500' },
        { symbol: 'MSFT', weight: '0.2500' },
      ],
      count: 2,
      sum: '0.6000',
    });
    await root.targets.save();
    expect(root.targets.isDirty).toBe(false);
    expect(root.targets.saved?.get('AAPL')).toBe(3500);
    expect(root.targets.savedAt).not.toBeNull();
  });

  it('discards edits back to the stored set, including rows that were added', async () => {
    const root = await loadedStore([holding('AAPL', 50), holding('MSFT', 20), holding('NVDA', 30)]);
    root.targets.setTarget('NVDA', '10');
    root.targets.setTarget('AAPL', '1');
    root.targets.discard();
    expect(root.targets.isDirty).toBe(false);
    expect(root.targets.rows.find((row) => row.symbol === 'NVDA')?.targetText).toBe('');
    expect(root.targets.rows.find((row) => row.symbol === 'AAPL')?.targetText).toBe('40');
  });

  it('spreads evenly over held rows only, and leaves the remainder untargeted', async () => {
    const root = await loadedStore([
      holding('AAPL', 50),
      holding('MSFT', 20),
      holding('NVDA', 30),
    ]);
    root.targets.spreadEvenly();
    // Three rows into ten thousand units leaves one over; it stays unallocated
    // rather than being pushed onto whichever row happened to be last.
    expect(root.targets.rows.filter((row) => row.held).map((row) => row.targetText)).toEqual([
      '33.33',
      '33.33',
      '33.33',
    ]);
    expect(root.targets.unallocatedUnits).toBe(1);
    expect(root.targets.blockingIssue).toBeNull();
  });
});
