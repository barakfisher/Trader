// @vitest-environment jsdom
/**
 * The holdings on a phone: one card per holding, not an 880 px table in a
 * 341 px box - and the same edit and remove as the table's row, with targets a
 * thumb can hit.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

import type { HoldingView, PortfolioResponse } from '@traders/shared';

const get = vi.fn();
const patch = vi.fn();
const del = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>(
    '../src/api/client.ts',
  );
  return { ...actual, api: { get, post: vi.fn(), put: vi.fn(), patch, delete: del, postForm: vi.fn() } };
});

const { HoldingsTable } = await import('../src/components/HoldingsTable.tsx');
const { renderPage } = await import('./serverStateHarness.tsx');

const AAPL: HoldingView = {
  id: 'h-aapl',
  instrument: {
    id: 'i-aapl',
    symbol: 'AAPL',
    name: 'Apple Inc.',
    assetClass: 'equity',
    exchange: 'NASDAQ',
    currency: 'USD',
  },
  quantity: '25.000000000000000000',
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
  weightPct: 8.3,
  fxRate: null,
};

const PORTFOLIO = { summary: { baseCurrency: 'USD' }, holdings: [AAPL] } as unknown as PortfolioResponse;

/** A holding's actions are behind its "⋮" (D334): open it, then choose. */
async function choose(symbol: string, action: 'Edit' | 'Remove') {
  fireEvent.click(await screen.findByRole('button', { name: `Actions for ${symbol}` }));
  fireEvent.click(screen.getByRole('button', { name: action }));
}

function narrowScreen(narrow: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: narrow,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockImplementation(async (path: string) => {
    if (path === '/agents') return { agents: [] };
    if (path === '/portfolio/cash') return { state: 'unset' };
    if (path === '/research') return { agent: null, run: null, holdings: [] };
    return PORTFOLIO;
  });
});
afterEach(() => {
  cleanup();
  // jsdom has none; leaving one behind would make every later test a phone.
  delete (window as { matchMedia?: unknown }).matchMedia;
});

it('shows a card per holding on a phone, and no table', async () => {
  narrowScreen(true);
  renderPage(<HoldingsTable />);

  expect(await screen.findByText('$8,235.00')).toBeTruthy();
  expect(document.querySelector('table')).toBeNull();
  expect(screen.getByText(/25 ×/)).toBeTruthy();
  expect(screen.getByText(/8\.3% of portfolio/)).toBeTruthy();
  expect(screen.getAllByRole('link', { name: 'AAPL' })).toHaveLength(1);
});

/** A research agent's latest rating of AAPL, as `GET /research` answers it. */
function ratedAapl(stale: boolean) {
  const answer = get.getMockImplementation()!;
  get.mockImplementation(async (path: string) =>
    path === '/research'
      ? {
          agent: { id: 'a-1', name: 'Warren', state: 'active' },
          run: null,
          holdings: [
            {
              instrumentId: 'i-aapl',
              symbol: 'AAPL',
              latest: { rating: 'bullish', agentName: 'Warren', ratedAt: '2026-11-03T12:00:00Z', stale },
            },
          ],
        }
      : answer(path),
  );
}

it("keeps a rating's word, agent and date on the card, linked to the research (guardrail 3)", async () => {
  narrowScreen(true);
  ratedAapl(false);
  renderPage(<HoldingsTable />);

  const rating = await screen.findByRole('link', { name: /Bullish, by Warren/ });
  expect(rating.textContent).toContain('Bullish');
  expect(rating.textContent).toContain('Warren');
  expect(rating.textContent).toMatch(/Nov/);
  expect(rating.getAttribute('href')).toContain('/research');
});

it('marks a stale rating on the card', async () => {
  narrowScreen(true);
  ratedAapl(true);
  renderPage(<HoldingsTable />);

  const rating = await screen.findByRole('link', { name: /Bullish, by Warren/ });
  expect(rating.textContent).toContain('stale');
});

it('draws no dash on a card for a holding with no rating', async () => {
  narrowScreen(true);
  const answer = get.getMockImplementation()!;
  get.mockImplementation(async (path: string) =>
    path === '/research' ? { agent: { id: 'a-1', name: 'Warren', state: 'active' }, run: null, holdings: [] } : answer(path),
  );
  renderPage(<HoldingsTable />);

  await screen.findByText('$8,235.00');
  await waitFor(() => expect(get).toHaveBeenCalledWith('/research'));
  expect(screen.queryByText('—')).toBeNull();
});

it("keeps the menu off the card while the holding is being edited", async () => {
  narrowScreen(true);
  renderPage(<HoldingsTable />);

  await choose('AAPL', 'Edit');
  expect(screen.getByLabelText('Quantity for AAPL')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Actions for AAPL' })).toBeNull();
});

it('keeps the table on a wider screen', async () => {
  narrowScreen(false);
  renderPage(<HoldingsTable />);
  await screen.findByText('$8,235.00');
  expect(document.querySelector('table')).not.toBeNull();
});

it('edits a quantity from the card through the same request as the table', async () => {
  narrowScreen(true);
  patch.mockResolvedValue({ id: 'h-aapl', symbol: 'AAPL' });
  renderPage(<HoldingsTable />);

  await choose('AAPL', 'Edit');
  fireEvent.change(screen.getByLabelText('Quantity for AAPL'), { target: { value: '30' } });
  fireEvent.click(screen.getByRole('button', { name: /Save/ }));

  await waitFor(() => expect(patch).toHaveBeenCalledWith('/holdings/h-aapl', { quantity: '30' }));
});

it('asks before it removes, and removes only on the second press', async () => {
  narrowScreen(true);
  del.mockResolvedValue({ ok: true });
  renderPage(<HoldingsTable />);

  await choose('AAPL', 'Remove');
  expect(screen.getByText('Remove AAPL?')).toBeTruthy();
  expect(del).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(del).toHaveBeenCalledWith('/holdings/h-aapl'));
});

it('edits the cost per unit from the table, starting from the stored value', async () => {
  narrowScreen(false);
  patch.mockResolvedValue({ id: 'h-aapl', symbol: 'AAPL' });
  renderPage(<HoldingsTable />);

  await choose('AAPL', 'Edit');
  const cost = screen.getByLabelText('Cost per unit for AAPL, in USD') as HTMLInputElement;
  expect(cost.value).toBe('185.40');
  fireEvent.change(cost, { target: { value: '190' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  // Always with its currency, so the server never reads it at another exponent.
  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith('/holdings/h-aapl', {
      quantity: AAPL.quantity,
      costBasis: '190',
      currency: 'USD',
    }),
  );
});

it('clears a cost from the card when the field is emptied', async () => {
  narrowScreen(true);
  patch.mockResolvedValue({ id: 'h-aapl', symbol: 'AAPL' });
  renderPage(<HoldingsTable />);

  await choose('AAPL', 'Edit');
  fireEvent.change(screen.getByLabelText('Cost per unit for AAPL, in USD'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: /Save/ }));

  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith('/holdings/h-aapl', {
      quantity: AAPL.quantity,
      costBasis: null,
      currency: 'USD',
    }),
  );
});

it('shows a yen cost as yen, with no decimal places to invent', async () => {
  narrowScreen(false);
  const toyota: HoldingView = {
    ...AAPL,
    id: 'h-tm',
    instrument: { ...AAPL.instrument, id: 'i-tm', symbol: '7203.T', currency: 'JPY' },
    costBasisMinor: 1500,
    costCurrency: 'JPY',
  };
  const answer = get.getMockImplementation()!;
  get.mockImplementation(async (path: string) =>
    path === '/portfolio' ? { ...PORTFOLIO, holdings: [toyota] } : answer(path),
  );
  renderPage(<HoldingsTable />);

  await choose('7203.T', 'Edit');
  expect((screen.getByLabelText('Cost per unit for 7203.T, in JPY') as HTMLInputElement).value).toBe(
    '1500',
  );
});
