// @vitest-environment jsdom
/**
 * A holding's page, rendered at its address with the app's router.
 *
 * Pinned: a stale link says "no such holding" and asks nothing about it; the
 * figures are the portfolio's own row; findings are asked for by symbol; the
 * news says it is one page of a larger week; an empty chart and an empty week
 * say which empty they are; and the dashboard's symbol links here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';

import type {
  HoldingHistoryResponse,
  HoldingNewsResponse,
  HoldingView,
  PortfolioResponse,
} from '@traders/shared';

const get = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>(
    '../src/api/client.ts',
  );
  return { ...actual, api: { get, post: vi.fn(), put: vi.fn(), delete: vi.fn(), postForm: vi.fn() } };
});

const { App } = await import('../src/App.tsx');
const { createAppRouter } = await import('../src/router.tsx');
const { renderWithServerState } = await import('./serverStateHarness.tsx');

const HOLDING_ID = 'f2c094ed-4c04-4c6e-8216-ddc55b8aeb6b';

const NVDA: HoldingView = {
  id: HOLDING_ID,
  instrument: {
    id: 'i-nvda',
    symbol: 'NVDA',
    name: 'NVIDIA Corporation',
    assetClass: 'equity',
    exchange: 'NASDAQ',
    currency: 'USD',
  },
  quantity: '40.000000000000000000',
  costBasisMinor: 9875,
  costCurrency: 'USD',
  openedAt: null,
  notes: null,
  quote: {
    priceMinor: 22721,
    currency: 'USD',
    asOf: '2026-09-29T20:00:00Z',
    source: 'yfinance',
    delaySeconds: 900,
    dayChangePct: -0.99,
    stale: false,
  },
  valueMinor: 908840,
  costMinor: 395000,
  pnlMinor: 513840,
  pnlPct: 130.09,
  weightPct: 12.4,
  fxRate: null,
};

const PORTFOLIO: PortfolioResponse = {
  summary: {
    baseCurrency: 'USD',
    totalValueMinor: 908840,
    totalCostMinor: 395000,
    pnlMinor: 513840,
    pnlPct: 130.09,
    dayChangeMinor: null,
    dayChangePct: null,
    holdingsCount: 1,
    pricedCount: 1,
    unpricedSymbols: [],
    degraded: false,
    asOf: '2026-09-30T07:00:00Z',
  },
  holdings: [NVDA],
  allocationByInstrument: [],
  allocationByAssetClass: [],
};

const HISTORY: HoldingHistoryResponse = {
  holdingId: HOLDING_ID,
  symbol: 'NVDA',
  days: 365,
  closes: [
    { day: '2026-09-28', priceMinor: 22886, currency: 'USD', asOf: '2026-09-28T20:00:00.000Z' },
    { day: '2026-09-29', priceMinor: 22721, currency: 'USD', asOf: '2026-09-29T20:00:00.000Z' },
  ],
};

const NEWS: HoldingNewsResponse = {
  holdingId: HOLDING_ID,
  symbol: 'NVDA',
  days: 7,
  total: 331,
  articles: [
    {
      id: 'a-1',
      url: 'https://example.com/nvda',
      source: 'example.com',
      title: 'Nvidia ships a chip',
      publishedAt: '2026-09-29T08:00:00.000Z',
      fetchedAt: '2026-09-29T08:15:00.000Z',
      instruments: [
        { symbol: 'NVDA', matchMethod: 'company_name', matchedText: 'Nvidia', salience: '0.9000' },
      ],
      sentiment: null,
    },
  ],
  collection: { lastRunAt: '2026-09-30T06:00:00.000Z', status: 'ok', failedProviders: [] },
};

/** Answers each read by path; anything unlisted never answers. */
function serve(routes: Record<string, unknown>) {
  get.mockImplementation((path: string) => {
    const key = Object.keys(routes).find((prefix) => path.startsWith(prefix));
    return key === undefined ? new Promise(() => {}) : Promise.resolve(routes[key]);
  });
}

function renderAt(path: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  const result = renderWithServerState(<App router={router} />);
  act(() => {
    result.root.auth.user = { id: 'u', baseCurrency: 'USD', timezone: 'Asia/Jerusalem' } as never;
    result.root.auth.initialised = true;
  });
  return { ...result, router };
}

const requested = () => get.mock.calls.map(([path]) => path as string);

describe('the holding page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.scrollTo = () => {};
    // jsdom has no layout, so no ResizeObserver; the chart's container needs one to mount.
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });
  afterEach(cleanup);

  it("shows the portfolio's own figures, its closes, its findings and a page of its news", async () => {
    serve({
      '/portfolio': PORTFOLIO,
      [`/holdings/${HOLDING_ID}/history`]: HISTORY,
      [`/holdings/${HOLDING_ID}/news`]: NEWS,
      '/observations': { observations: [] },
      '/targets': { targets: [{ symbol: 'NVDA', name: null, weight: '0.2000' }] },
    });

    renderAt(`/holdings/${HOLDING_ID}`);

    expect(await screen.findByRole('heading', { name: 'NVDA' })).toBeTruthy();
    expect(screen.getByText('$9,088.40')).toBeTruthy(); // value, from the portfolio row
    expect(screen.getByText('$98.75 per unit')).toBeTruthy();
    expect(await screen.findByText('20%')).toBeTruthy(); // the stated target
    expect(await screen.findByText(/2 daily closes from 28 Sept 2026 to 29 Sept 2026/)).toBeTruthy();
    expect(await screen.findByText('newest 1 of 331')).toBeTruthy();
    expect(screen.getByText(/matched by name “Nvidia”/)).toBeTruthy();
    expect(await screen.findByText(/recorded no price move/)).toBeTruthy();
    expect(requested()).toContain('/observations?limit=50&symbol=NVDA');
  });

  it('says a stale link is no holding, and asks nothing about it', async () => {
    serve({ '/portfolio': PORTFOLIO });

    renderAt('/holdings/00000000-0000-0000-0000-000000000000');

    expect(await screen.findByText('No such holding')).toBeTruthy();
    expect(requested().some((path) => path.startsWith('/holdings/'))).toBe(false);
    expect(requested().some((path) => path.startsWith('/observations'))).toBe(false);
  });

  it('says which empty an empty chart and an empty week are', async () => {
    serve({
      '/portfolio': PORTFOLIO,
      [`/holdings/${HOLDING_ID}/history`]: { ...HISTORY, closes: [] },
      [`/holdings/${HOLDING_ID}/news`]: { ...NEWS, total: 0, articles: [] },
      '/observations': { observations: [] },
      '/targets': { targets: [] },
    });

    renderAt(`/holdings/${HOLDING_ID}`);

    expect(await screen.findByText(/No stored closing price yet/)).toBeTruthy();
    expect(await screen.findByText(/No news about NVDA in the last 7 days/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'none set' })).toBeTruthy();
  });

  it('reports a failed chart as a failure, with a retry, not as an empty chart', async () => {
    serve({ '/portfolio': PORTFOLIO, '/targets': { targets: [] } });
    get.mockImplementation((path: string) =>
      path.startsWith(`/holdings/${HOLDING_ID}/history`)
        ? Promise.reject(new Error('502'))
        : path === '/portfolio'
          ? Promise.resolve(PORTFOLIO)
          : new Promise(() => {}),
    );

    renderAt(`/holdings/${HOLDING_ID}`);

    expect(await screen.findByText('Could not load the price history.')).toBeTruthy();
    expect(screen.queryByText(/No stored closing price/)).toBeNull();
  });

  it("is reached from the dashboard by the holding's symbol", async () => {
    serve({ '/portfolio': PORTFOLIO });
    renderAt('/');
    const link = await screen.findByRole('link', { name: 'NVDA' });
    expect(link.getAttribute('href')).toBe(`/holdings/${HOLDING_ID}`);
  });
});
