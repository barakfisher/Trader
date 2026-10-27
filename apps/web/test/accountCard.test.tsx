// @vitest-environment jsdom
/**
 * The main portfolio's account card (D328-D330): holdings plus the cash at the
 * broker, the money put in under it - and, until the cash is set, a card that
 * says so instead of a $0 nobody entered.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

import type { PortfolioSummary, PrimaryCashResponse } from '@traders/shared';

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();

vi.mock('../src/api/client.ts', () => ({
  api: { get, post, put, postForm: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  ApiRequestError: class extends Error {},
  errorMessage: (_error: unknown, fallback: string) => fallback,
}));

const { AccountCard } = await import('../src/components/AccountCard.tsx');
const { renderWithServerState } = await import('./serverStateHarness.tsx');

const SUMMARY: PortfolioSummary = {
  baseCurrency: 'USD',
  totalValueMinor: 300_000,
  totalCostMinor: 250_000,
  pnlMinor: 50_000,
  pnlPct: 20,
  dayChangeMinor: 0,
  dayChangePct: 0,
  holdingsCount: 2,
  pricedCount: 2,
  unpricedSymbols: [],
  uncostedSymbols: [],
  degraded: false,
  asOf: '2026-10-27T10:00:00Z',
};

const OPEN: PrimaryCashResponse = {
  state: 'open',
  currency: 'USD',
  cashMinor: 120_000,
  depositsMinor: 100_000,
  openingHoldingsCostMinor: 250_000,
  investedMinor: 350_000,
  feesPaidMinor: 1_500,
};

let cash: PrimaryCashResponse = OPEN;
beforeEach(() => {
  vi.clearAllMocks();
  cash = OPEN;
  get.mockImplementation(async (path: string) => {
    if (path === '/portfolio/cash') return cash;
    throw new Error(`unexpected GET ${path}`);
  });
});
afterEach(cleanup);

describe('the account card', () => {
  it('adds the cash to the holdings, and shows the money put in and the gain on it', async () => {
    renderWithServerState(<AccountCard summary={SUMMARY} />);
    // $3,000 at market + $1,200 cash.
    expect(await screen.findByText('$4,200.00')).toBeTruthy();
    expect(screen.getByText('$1,200.00')).toBeTruthy();
    expect(screen.getByText('$3,500.00')).toBeTruthy();
    // $4,200 - $3,500 put in.
    expect(screen.getByText('$700.00')).toBeTruthy();
  });

  it('says the cash is not set, never $0, and sets it from the drawer', async () => {
    cash = { state: 'unset' };
    post.mockResolvedValue(OPEN);
    renderWithServerState(<AccountCard summary={SUMMARY} />);
    expect(await screen.findByText(/the cash at your broker is not set/)).toBeTruthy();
    expect(screen.queryByText('$0.00')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Set cash/ }));
    const drawer = screen.getByRole('dialog', { name: 'Cash at the broker' });
    fireEvent.change(within(drawer).getByPlaceholderText('0.00'), { target: { value: '1200' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Set cash' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/portfolio/cash', { amount: '1200' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('deposits, and corrects the balance to what the broker shows', async () => {
    post.mockResolvedValue(OPEN);
    put.mockResolvedValue(OPEN);
    renderWithServerState(<AccountCard summary={SUMMARY} />);
    fireEvent.click(await screen.findByRole('button', { name: /Cash/ }));
    const drawer = screen.getByRole('dialog', { name: 'Cash at the broker' });
    expect(within(drawer).getByText('$15.00')).toBeTruthy();

    const [deposit, correct] = within(drawer).getAllByPlaceholderText('0.00');
    fireEvent.change(correct!, { target: { value: '1180.25' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Set balance' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/portfolio/cash', { amount: '1180.25' }));

    fireEvent.click(await screen.findByRole('button', { name: /Cash/ }));
    const again = screen.getByRole('dialog', { name: 'Cash at the broker' });
    const [depositAgain] = within(again).getAllByPlaceholderText('0.00');
    expect(deposit).toBeTruthy();
    fireEvent.change(depositAgain!, { target: { value: '0' } });
    // A $0 deposit is not offered.
    expect((within(again).getByRole('button', { name: 'Record deposit' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(depositAgain!, { target: { value: '250' } });
    fireEvent.click(within(again).getByRole('button', { name: 'Record deposit' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/portfolio/cash/deposits', { amount: '250' }));
  });

  it('leaves out the gain when a holding is unpriced, and says so', async () => {
    renderWithServerState(<AccountCard summary={{ ...SUMMARY, degraded: true, unpricedSymbols: ['XYZ'] }} />);
    expect(await screen.findByText(/Some holdings are unpriced/)).toBeTruthy();
    expect(screen.queryByText('Gain on it')).toBeNull();
  });
});
