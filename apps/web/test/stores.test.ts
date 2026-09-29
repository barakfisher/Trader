/**
 * Store-level tests: the selection rules and failure handling that decide what
 * the user can actually do. The API client is mocked, so these are fast and
 * need no backend.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ImportPreview, PortfolioResponse } from '@traders/shared';

const get = vi.fn();
const post = vi.fn();
const postForm = vi.fn();
const patch = vi.fn();
const del = vi.fn();

vi.mock('../src/api/client.ts', () => ({
  api: { get, post, postForm, patch, delete: del },
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
const { baseCurrencyOf, hasStaleQuotes, pricesAsOf } = await import('../src/lib/portfolioView.ts');
const { queryKeys } = await import('../src/queries/queryKeys.ts');

const preview: ImportPreview = {
  previewId: 'preview-1',
  filename: 'p.csv',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  counts: { ok: 1, ambiguous: 1, unresolved: 1, invalid: 0, duplicate: 0 },
  rows: [
    {
      line: 2,
      raw: {},
      status: 'ok',
      symbol: 'AAPL',
      resolvedInstrument: { symbol: 'AAPL', name: 'Apple', assetClass: 'equity', exchange: null, currency: 'USD' },
      candidates: [],
      quantity: '10',
      costBasisMinor: 18540,
      currency: 'USD',
      openedAt: null,
      notes: null,
      issues: [],
    },
    {
      line: 3,
      raw: {},
      status: 'ambiguous',
      symbol: 'SHELL',
      resolvedInstrument: null,
      candidates: [
        { symbol: 'SHEL', name: 'Shell plc', assetClass: 'equity', exchange: 'NYSE', currency: 'USD' },
        { symbol: 'SHEL.L', name: 'Shell plc', assetClass: 'equity', exchange: 'LSE', currency: 'GBP' },
      ],
      quantity: '5',
      costBasisMinor: null,
      currency: 'USD',
      openedAt: null,
      notes: null,
      issues: [],
    },
    {
      line: 4,
      raw: {},
      status: 'unresolved',
      symbol: 'NOSUCH',
      resolvedInstrument: null,
      candidates: [],
      quantity: '1',
      costBasisMinor: null,
      currency: 'USD',
      openedAt: null,
      notes: null,
      issues: [{ field: 'symbol', message: 'no market data provider could price this symbol' }],
    },
  ],
};

const portfolio: PortfolioResponse = {
  summary: {
    baseCurrency: 'USD',
    totalValueMinor: 232140,
    totalCostMinor: 185400,
    pnlMinor: 46740,
    pnlPct: 25.21,
    dayChangeMinor: 2350,
    dayChangePct: 1.02,
    holdingsCount: 1,
    pricedCount: 1,
    unpricedSymbols: [],
    degraded: false,
    asOf: new Date().toISOString(),
  },
  holdings: [],
  allocationByInstrument: [],
  allocationByAssetClass: [],
};

describe('ImportStore', () => {
  let store: InstanceType<typeof RootStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new RootStore();
  });

  it('pre-selects only the rows that are unambiguously importable', async () => {
    postForm.mockResolvedValue(preview);
    await store.import.upload(new File(['x'], 'p.csv'));
    expect([...store.import.selected]).toEqual([2]);
    expect(store.import.readyLines).toEqual([2]);
  });

  it('will not import an ambiguous row until a candidate is chosen', async () => {
    postForm.mockResolvedValue(preview);
    await store.import.upload(new File(['x'], 'p.csv'));

    store.import.toggleRow(3);
    // Selected, but still not ready: no candidate picked yet.
    expect(store.import.selected.has(3)).toBe(true);
    expect(store.import.readyLines).not.toContain(3);

    store.import.setOverride(3, 'SHEL');
    expect(store.import.readyLines).toContain(3);
  });

  it('never treats an unresolved row as importable', async () => {
    postForm.mockResolvedValue(preview);
    await store.import.upload(new File(['x'], 'p.csv'));
    store.import.toggleRow(4);
    expect(store.import.readyLines).not.toContain(4);
    expect(store.import.blockedRows.map((row) => row.line)).toEqual([4]);
  });

  it('sends only ready lines and the chosen overrides on commit', async () => {
    postForm.mockResolvedValue(preview);
    post.mockResolvedValue({ created: 2, updated: 0, skipped: 1, failed: [] });
    const invalidate = vi.spyOn(store.queryClient, 'invalidateQueries');

    await store.import.upload(new File(['x'], 'p.csv'));
    store.import.setOverride(3, 'SHEL.L');
    await store.import.commit();

    expect(post).toHaveBeenCalledWith('/imports/commit', {
      previewId: 'preview-1',
      mode: 'merge',
      lines: [2, 3],
      symbolOverrides: { 3: 'SHEL.L' },
    });
    expect(store.import.result?.created).toBe(2);
    // The imported holdings reach every screen showing the portfolio.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.portfolio });
  });

  it('surfaces an upload failure instead of leaving a blank dialog', async () => {
    postForm.mockRejectedValue(new ApiRequestError('file is not valid CSV', 422, 'unparseable_file'));
    await store.import.upload(new File(['x'], 'p.csv'));
    expect(store.import.error).toBe('file is not valid CSV');
    expect(store.import.preview).toBeNull();
  });
});

function holdingWithQuote(symbol: string, asOf: string, stale = false) {
  return {
    id: symbol,
    instrument: { id: symbol, symbol, name: symbol, assetClass: 'equity' as const, exchange: null, currency: 'USD' },
    quantity: '1',
    costBasisMinor: 1000,
    costCurrency: 'USD',
    openedAt: null,
    notes: null,
    quote: {
      priceMinor: 1100,
      currency: 'USD',
      asOf,
      source: 'yfinance',
      delaySeconds: 900,
      dayChangePct: 1,
      stale,
    },
    valueMinor: 1100,
    costMinor: 1000,
    pnlMinor: 100,
    pnlPct: 10,
    weightPct: 100,
    fxRate: '1',
  };
}

describe('portfolio view', () => {
  it('reports the oldest observation time, not the fetch time', () => {
    // A portfolio fetched "just now" can be built entirely from prices that were
    // true twenty minutes ago; the header must say the latter.
    const view = {
      ...portfolio,
      holdings: [
        holdingWithQuote('AAPL', '2026-09-15T10:15:00Z'),
        holdingWithQuote('VOO', '2026-09-15T10:00:00Z'),
      ],
    };
    expect(pricesAsOf(view)).toBe('2026-09-15T10:00:00Z');
  });

  it('has no observation time when nothing could be priced, or nothing has loaded', () => {
    expect(pricesAsOf({ ...portfolio, holdings: [] })).toBeNull();
    expect(pricesAsOf(undefined)).toBeNull();
  });

  it('flags when any displayed price came from the cache', () => {
    const view = {
      ...portfolio,
      holdings: [
        holdingWithQuote('AAPL', '2026-09-15T10:15:00Z'),
        holdingWithQuote('VOO', '2026-09-15T10:00:00Z', true),
      ],
    };
    expect(hasStaleQuotes(view)).toBe(true);
    expect(hasStaleQuotes(portfolio)).toBe(false);
  });

  it("takes the portfolio's base currency, then the account's", () => {
    expect(baseCurrencyOf({ ...portfolio, summary: { ...portfolio.summary, baseCurrency: 'EUR' } })).toBe('EUR');
    expect(baseCurrencyOf(undefined, 'GBP')).toBe('GBP');
    expect(baseCurrencyOf(undefined)).toBe('USD');
  });
});
