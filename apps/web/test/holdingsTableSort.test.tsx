// @vitest-environment jsdom
/**
 * The real holdings table sorts as the address asks (M10 decision 21): a header
 * click asks for the next order, the sorted column says so to a screen reader,
 * and P&L is two columns, money and percent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';

import type { HoldingView, PortfolioResponse } from '@traders/shared';

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
