// @vitest-environment jsdom
/**
 * The real holdings table sorts as the address asks (M10 decision 21): a header
 * click asks for the next order, the sorted column says so to a screen reader,
 * and P&L is two columns, money and percent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

import type { HoldingView, PortfolioResponse, ResearchResponse, SentimentRating } from '@traders/shared';

const get = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>('../src/api/client.ts');
  return { ...actual, api: { get, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() } };
});

const { HoldingsTable } = await import('../src/components/HoldingsTable.tsx');
const { renderPage } = await import('./serverStateHarness.tsx');

function holding(symbol: string, valueMinor: number | null, pnlPct: number | null): HoldingView {
  return {
    id: `h-${symbol}`,
    instrument: { id: `i-${symbol}`, symbol, name: `${symbol} Inc`, assetClass: 'equity', exchange: null, currency: 'USD' },
    quantity: '1',
    costBasisMinor: 1000,
    costCurrency: 'USD',
    openedAt: null,
    notes: null,
    quote:
      valueMinor === null
        ? null
        : { priceMinor: valueMinor, currency: 'USD', asOf: '2026-10-23T10:00:00Z', source: 'fixture', delaySeconds: 0, dayChangePct: 0, stale: false },
    valueMinor,
    costMinor: 1000,
    pnlMinor: valueMinor === null ? null : valueMinor - 1000,
    pnlPct,
    weightPct: null,
    fxRate: null,
  };
}

const PORTFOLIO = {
  summary: { baseCurrency: 'USD' },
  holdings: [holding('BBB', 3000, 200), holding('AAA', null, null), holding('CCC', 1500, 50)],
  allocationByInstrument: [],
  allocationByAssetClass: [],
} as unknown as PortfolioResponse;

const symbolsInOrder = () =>
  screen.getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[0]!.textContent?.slice(0, 3));

beforeEach(() => {
  vi.clearAllMocks();
  get.mockImplementation(async (path: string) => (path === '/portfolio' ? PORTFOLIO : new Promise(() => {})));
});
afterEach(cleanup);

describe('the real holdings table', () => {
  it("keeps the server's order with no sort, and marks no column sorted", async () => {
    renderPage(<HoldingsTable />);
    await screen.findByText('BBB Inc');
    expect(symbolsInOrder()).toEqual(['BBB', 'AAA', 'CCC']);
    expect(screen.getAllByRole('columnheader').filter((th) => th.getAttribute('aria-sort') !== 'none' && th.hasAttribute('aria-sort'))).toEqual([]);
  });

  it('orders by the address, with an unpriced holding last, and says which column sorts it', async () => {
    renderPage(<HoldingsTable sort={{ key: 'value', direction: 'asc' }} onSort={() => {}} />);
    await screen.findByText('BBB Inc');
    expect(symbolsInOrder()).toEqual(['CCC', 'BBB', 'AAA']);
    const value = screen.getByRole('columnheader', { name: /Value/ });
    expect(value.getAttribute('aria-sort')).toBe('ascending');
  });

  it('asks for the next order on a header click', async () => {
    const onSort = vi.fn();
    renderPage(<HoldingsTable sort={{ key: 'value', direction: 'desc' }} onSort={onSort} />);
    await screen.findByText('BBB Inc');
    fireEvent.click(screen.getByRole('button', { name: 'Value' }));
    expect(onSort).toHaveBeenLastCalledWith({ key: 'value', direction: 'asc' });
    fireEvent.click(screen.getByRole('button', { name: 'P&L %' }));
    expect(onSort).toHaveBeenLastCalledWith({ key: 'pnlPct', direction: 'desc' });
  });

  it('shows P&L as money and as percent, each in its own column', async () => {
    renderPage(<HoldingsTable />);
    await screen.findByText('BBB Inc');
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent);
    expect(headers).toContain('P&L');
    expect(headers).toContain('P&L %');
    const bbb = screen.getAllByRole('row')[1]!;
    const cells = within(bbb).getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells).toContain('$20.00');
    expect(cells.some((text) => text?.includes('200'))).toBe(true);
  });
});

function rated(symbol: string, rating: SentimentRating) {
  return {
    instrumentId: `i-${symbol}`,
    symbol,
    name: null,
    latest: { rating, rationale: '', findings: [], agentName: 'Analyst', ratedAt: '2026-10-23T20:01:00Z', stale: false },
    lastAttempt: null,
  };
}

function withResearch(agent: ResearchResponse['agent']) {
  const research = { agent, run: null, holdings: [rated('BBB', 'bearish'), rated('CCC', 'bullish')] } as unknown as ResearchResponse;
  get.mockImplementation(async (path: string) =>
    path === '/portfolio' ? PORTFOLIO : path === '/research' ? research : new Promise(() => {}),
  );
}

describe('the Sentiment column', () => {
  it('sorts Bullish first, an unrated holding last, and asks for it on a header click', async () => {
    withResearch({ id: 'a1', name: 'Analyst', state: 'active' } as ResearchResponse['agent']);
    const onSort = vi.fn();
    renderPage(<HoldingsTable sort={{ key: 'sentiment', direction: 'desc' }} onSort={onSort} />);
    const header = await screen.findByRole('columnheader', { name: /Sentiment/ });
    expect(header.getAttribute('aria-sort')).toBe('descending');
    expect(symbolsInOrder()).toEqual(['CCC', 'BBB', 'AAA']);
    fireEvent.click(screen.getByRole('button', { name: 'Sentiment' }));
    expect(onSort).toHaveBeenLastCalledWith({ key: 'sentiment', direction: 'asc' });
  });

  it('is not a column, or a sort choice, until an agent researches the portfolio', async () => {
    withResearch(null);
    renderPage(<HoldingsTable />);
    await screen.findByText('BBB Inc');
    // Settled, not merely not yet loaded: the research answer has arrived and says no agent.
    await waitFor(() => expect(get.mock.calls.some(([path]) => path === '/research')).toBe(true));
    await act(async () => {});
    expect(screen.queryByRole('columnheader', { name: /Sentiment/ })).toBeNull();
  });
});
