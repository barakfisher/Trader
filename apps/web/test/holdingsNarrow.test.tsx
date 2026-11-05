// @vitest-environment jsdom
/**
 * The holdings on a phone: one card per holding, not an 880 px table in a
 * 341 px box - and the same edit and remove as the table's row, with targets a
 * thumb can hit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
const { formatPercent } = await import('../src/i18n/format.ts');
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

/** The change's figure and the word "today" are separate elements of one paragraph. */
const paragraphReading = (text: string) => (_: string, element: Element | null) =>
  element?.tagName === 'P' && element.textContent === text;

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
  // The holding's page is inside the open card, not on the symbol (D384).
  expect(screen.queryByRole('link', { name: 'AAPL' })).toBeNull();
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

it("shows today's change on the card, not the total P&L", async () => {
  narrowScreen(true);
  renderPage(<HoldingsTable />);

  await screen.findByText('$8,235.00');
  expect(screen.getByText(paragraphReading(`${formatPercent(AAPL.quote!.dayChangePct)} today`))).toBeTruthy();
  // The total is there for when the card opens; closed, nothing can read it.
  expect(screen.getByText(/\$3,600\.00/).closest('[aria-hidden="true"]')).not.toBeNull();
});

describe('opening a card (D384)', () => {
  const MSFT: HoldingView = {
    ...AAPL,
    id: 'h-msft',
    instrument: { ...AAPL.instrument, id: 'i-msft', symbol: 'MSFT', name: 'Microsoft' },
  };
  const toggle = (symbol: string) => screen.getByRole('button', { name: `Details for ${symbol}` });
  const twoHoldings = () => {
    const answer = get.getMockImplementation()!;
    get.mockImplementation(async (path: string) =>
      path === '/portfolio' ? { ...PORTFOLIO, holdings: [AAPL, MSFT] } : answer(path),
    );
  };

  it('says the total P&L, the cost and the way to the holding page once tapped', async () => {
    narrowScreen(true);
    renderPage(<HoldingsTable />);
    await screen.findByText('$8,235.00');
    const page = 'Holding page for AAPL';
    expect(screen.queryByRole('link', { name: page })).toBeNull();

    fireEvent.click(toggle('AAPL'));

    expect(toggle('AAPL').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('link', { name: page }).getAttribute('href')).toBe(`/holdings/${AAPL.id}`);
    expect(screen.getByText(/\$3,600\.00/).closest('[aria-hidden="true"]')).toBeNull();
    expect(screen.getAllByRole('term').map((term) => term.textContent)).toEqual(['P&L', 'Cost', 'Price updated']);

    fireEvent.click(toggle('AAPL'));
    expect(toggle('AAPL').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('link', { name: page })).toBeNull();
  });

  it('keeps one card open at a time', async () => {
    narrowScreen(true);
    twoHoldings();
    renderPage(<HoldingsTable />);
    await screen.findByText('MSFT');

    fireEvent.click(toggle('AAPL'));
    fireEvent.click(toggle('MSFT'));

    expect(toggle('AAPL').getAttribute('aria-expanded')).toBe('false');
    expect(toggle('MSFT').getAttribute('aria-expanded')).toBe('true');
  });

  it('cannot close a card that is being edited', async () => {
    narrowScreen(true);
    renderPage(<HoldingsTable />);
    await screen.findByText('$8,235.00');
    fireEvent.click(toggle('AAPL'));

    fireEvent.click(screen.getByRole('button', { name: 'Actions for AAPL' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    expect(screen.queryByRole('button', { name: 'Details for AAPL' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Holding page for AAPL' })).toBeTruthy();
  });

  it('cannot close a card that is asking to confirm a removal', async () => {
    narrowScreen(true);
    renderPage(<HoldingsTable />);
    await screen.findByText('$8,235.00');

    fireEvent.click(screen.getByRole('button', { name: 'Actions for AAPL' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(screen.queryByRole('button', { name: 'Details for AAPL' })).toBeNull();
  });

  it('asks the server for nothing to open a card', async () => {
    narrowScreen(true);
    renderPage(<HoldingsTable />);
    await screen.findByText('$8,235.00');
    const asked = get.mock.calls.length;

    fireEvent.click(toggle('AAPL'));

    await screen.findByRole('link', { name: 'Holding page for AAPL' });
    expect(get.mock.calls.length).toBe(asked);
  });

  it('says a dash for a figure it does not have, never a zero', async () => {
    narrowScreen(true);
    const answer = get.getMockImplementation()!;
    get.mockImplementation(async (path: string) =>
      path === '/portfolio'
        ? { ...PORTFOLIO, holdings: [{ ...AAPL, quote: null, valueMinor: null, costMinor: null, pnlMinor: null, pnlPct: null }] }
        : answer(path),
    );
    renderPage(<HoldingsTable />);
    await screen.findByText('AAPL');

    fireEvent.click(toggle('AAPL'));

    const figures = screen.getAllByRole('definition').map((figure) => figure.textContent);
    expect(figures[0]).toBe('—');
    expect(figures[1]).toMatch(/^—/);
  });

  it('is a table on a wide screen, with nothing to open', async () => {
    narrowScreen(false);
    renderPage(<HoldingsTable />);
    await screen.findByText('$8,235.00');
    expect(screen.queryByRole('button', { name: 'Details for AAPL' })).toBeNull();
    expect(screen.getByRole('link', { name: 'AAPL' })).toBeTruthy();
  });
});

it('says a dash for an unpriced holding, never a zero change', async () => {
  narrowScreen(true);
  const answer = get.getMockImplementation()!;
  get.mockImplementation(async (path: string) =>
    path === '/portfolio'
      ? { ...PORTFOLIO, holdings: [{ ...AAPL, quote: null, valueMinor: null, pnlMinor: null, pnlPct: null }] }
      : answer(path),
  );
  renderPage(<HoldingsTable />);

  expect(await screen.findByText(paragraphReading('— today'))).toBeTruthy();
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
