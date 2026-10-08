// @vitest-environment jsdom
/**
 * The dashboard's layout (UX5): the summary, the two charts, then the holdings
 * card - which carries its own actions. Add holding opens a drawer, Targets is
 * the page, Import and Export sit behind "⋯"; none of them is in the app bar.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';

import type { HoldingView, PortfolioResponse } from '@traders/shared';

const get = vi.fn();
const post = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>(
    '../src/api/client.ts',
  );
  return { ...actual, api: { get, post, put: vi.fn(), delete: vi.fn(), postForm: vi.fn() } };
});

const { App } = await import('../src/App.tsx');
const { createAppRouter } = await import('../src/router.tsx');
const { renderWithServerState } = await import('./serverStateHarness.tsx');

const AAPL: HoldingView = {
  id: 'h-aapl',
  instrument: { id: 'i-aapl', symbol: 'AAPL', name: 'Apple Inc.', assetClass: 'equity', exchange: 'NASDAQ', currency: 'USD' },
  quantity: '25',
  costBasisMinor: 18540,
  costCurrency: 'USD',
  openedAt: null,
  notes: null,
  quote: {
    priceMinor: 32940,
    currency: 'USD',
    asOf: '2026-09-30T07:00:00Z',
    source: 'yfinance',
    delaySeconds: 900,
    dayChangePct: -2.69,
    stale: false,
  },
  valueMinor: 823500,
  costMinor: 463500,
  pnlMinor: 360000,
  pnlPct: 77.67,
  weightPct: 100,
  fxRate: null,
};

const PORTFOLIO: PortfolioResponse = {
  summary: {
    baseCurrency: 'USD',
    totalValueMinor: 823500,
    totalCostMinor: 463500,
    pnlMinor: 360000,
    pnlPct: 77.67,
    dayChangeMinor: 0,
    dayChangePct: 0,
    holdingsCount: 1,
    pricedCount: 1,
    unpricedSymbols: [],
    degraded: false,
    asOf: '2026-09-30T07:00:00Z',
  },
  holdings: [AAPL],
  allocationByInstrument: [{ key: 'instrument:AAPL', label: 'AAPL', valueMinor: 823500, weightPct: 100 }],
  allocationByAssetClass: [{ key: 'equity', label: 'Stocks', valueMinor: 823500, weightPct: 100 }],
};

function renderAt(path: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  const result = renderWithServerState(<App router={router} />);
  act(() => {
    result.root.auth.user = { id: 'u', baseCurrency: 'USD', timezone: 'Asia/Jerusalem' } as never;
    result.root.auth.initialised = true;
  });
  return { ...result, router };
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockImplementation((path: string) => {
    if (path === '/portfolio') return Promise.resolve(PORTFOLIO);
    // Adding a holding waits for every portfolio read to refresh, the curve's included.
    if (path.startsWith('/portfolio/snapshots')) return Promise.resolve({ snapshots: [] });
    return new Promise(() => {});
  });
  window.scrollTo = () => {};
  // jsdom has no layout, so no ResizeObserver; the charts' containers need one to mount.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

const holdingsCard = async () =>
  (await screen.findByRole('heading', { name: 'Holdings (1)' })).closest('section') as HTMLElement;

it('reads summary, the two charts, then the holdings - with no add form beside them', async () => {
  renderAt('/');
  await holdingsCard();
  const order = screen
    .getAllByRole('heading', { level: 2 })
    .map((heading) => heading.textContent)
    .filter((text) => ['Value over time', 'Allocation', 'Holdings (1)'].includes(text ?? ''));
  expect(order).toEqual(['Value over time', 'Allocation', 'Holdings (1)']);
  expect(screen.queryByRole('heading', { name: 'Add a holding' })).toBeNull();
});

it('keeps Targets and Import out of the app bar', async () => {
  renderAt('/');
  const nav = await screen.findByRole('navigation', { name: 'Main' });
  expect(within(nav).queryByRole('link', { name: /Targets/ })).toBeNull();
  expect(within(nav).queryByRole('button', { name: /Import/ })).toBeNull();
});

it('links Targets from the holdings card to its page', async () => {
  renderAt('/');
  const card = await holdingsCard();
  expect(within(card).getByRole('link', { name: /Targets/ }).getAttribute('href')).toBe('/targets');
});

it('adds a holding in a drawer that takes focus, gives it back, and closes when the holding is in', async () => {
  post.mockResolvedValue(AAPL);
  renderAt('/');
  const card = await holdingsCard();
  const add = within(card).getByRole('button', { name: /Add holding/ });
  add.focus();
  fireEvent.click(add);

  const drawer = screen.getByRole('dialog', { name: 'Add a holding' });
  expect(document.activeElement).toBe(within(drawer).getAllByRole('textbox')[0]);

  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(add);

  fireEvent.click(add);
  const again = screen.getByRole('dialog', { name: 'Add a holding' });
  const [symbol, quantity] = within(again).getAllByRole('textbox');
  fireEvent.change(symbol!, { target: { value: 'msft' } });
  fireEvent.change(quantity!, { target: { value: '3' } });
  fireEvent.click(within(again).getByRole('button', { name: /Add holding/ }));
  await waitFor(() => expect(post).toHaveBeenCalledWith('/holdings', expect.objectContaining({ symbol: 'MSFT', quantity: '3' })));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('opens Import from "⋯", and shows Export as not yet available', async () => {
  renderAt('/');
  const card = await holdingsCard();
  fireEvent.click(within(card).getByRole('button', { name: 'More actions' }));
  expect((within(card).getByRole('button', { name: 'Export JSON' }) as HTMLButtonElement).disabled).toBe(true);

  fireEvent.click(within(card).getByRole('button', { name: 'Import' }));
  expect(await screen.findByRole('heading', { name: 'Import holdings' })).toBeTruthy();
  // Choosing an item closes the menu.
  expect(within(card).getByRole('button', { name: 'More actions' }).getAttribute('aria-expanded')).toBe('false');
});
