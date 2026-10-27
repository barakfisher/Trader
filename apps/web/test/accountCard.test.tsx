// @vitest-environment jsdom
/**
 * The main portfolio's account card (D328-D330, D340-D342): holdings plus the
 * cash at the broker, the money put in under it - and, until the cash is set, a
 * card that says so instead of a $0 nobody entered. Its drawer records a
 * movement for what it is, and corrects the balance to what the broker shows.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

import type { PortfolioSummary, PrimaryCashResponse } from '@traders/shared';

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();

vi.mock('../src/api/client.ts', () => ({
  api: { get, post, put, postForm: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  ApiRequestError: class extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code: string,
    ) {
      super(message);
    }
  },
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
  incomeMinor: 1_230,
  chargesMinor: 400,
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

  const openDrawer = async () => {
    fireEvent.click(await screen.findByRole('button', { name: /Cash/ }));
    return screen.getByRole('dialog', { name: 'Cash at the broker' });
  };

  it('shows the fees, income and charges recorded, and corrects the balance to what the broker shows', async () => {
    put.mockResolvedValue(OPEN);
    renderWithServerState(<AccountCard summary={SUMMARY} />);
    const drawer = await openDrawer();
    expect(within(drawer).getByText('$15.00')).toBeTruthy();
    expect(within(drawer).getByText('$12.30')).toBeTruthy();
    expect(within(drawer).getByText('$4.00')).toBeTruthy();

    const correct = within(drawer).getByLabelText('Cash your broker shows (USD)');
    fireEvent.change(correct, { target: { value: '1180.25' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Set balance' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/portfolio/cash', { amount: '1180.25' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('records each kind of movement as what it is, the amount always positive (D340)', async () => {
    post.mockResolvedValue(OPEN);
    renderWithServerState(<AccountCard summary={SUMMARY} />);
    for (const [label, type, submit] of [
      ['Deposit', 'deposit', 'Record deposit'],
      ['Withdrawal', 'withdrawal', 'Record withdrawal'],
      ['Income', 'income', 'Record income'],
      ['Charge', 'charge', 'Record charge'],
    ] as const) {
      const drawer = await openDrawer();
      fireEvent.click(within(drawer).getByRole('radio', { name: label }));
      const amount = within(drawer).getByLabelText('Amount (USD)');
      fireEvent.change(amount, { target: { value: '0' } });
      // A $0 movement is not offered.
      expect((within(drawer).getByRole('button', { name: submit }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(amount, { target: { value: '12.30' } });
      fireEvent.click(within(drawer).getByRole('button', { name: submit }));
      await waitFor(() => expect(post).toHaveBeenLastCalledWith('/portfolio/cash/movements', { type, amount: '12.30' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
  });

  it('keeps the drawer open and says why when a movement is refused', async () => {
    const { ApiRequestError } = await import('../src/api/client.ts');
    post.mockRejectedValue(new ApiRequestError('no', 422, 'insufficient_cash'));
    renderWithServerState(<AccountCard summary={SUMMARY} />);
    const drawer = await openDrawer();
    fireEvent.click(within(drawer).getByRole('radio', { name: 'Withdrawal' }));
    fireEvent.change(within(drawer).getByLabelText('Amount (USD)'), { target: { value: '99999' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Record withdrawal' }));
    expect(await within(drawer).findByText('There is not that much cash in the account.')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('leaves out the gain when a holding is unpriced, and says so', async () => {
    renderWithServerState(<AccountCard summary={{ ...SUMMARY, degraded: true, unpricedSymbols: ['XYZ'] }} />);
    expect(await screen.findByText(/Some holdings are unpriced/)).toBeTruthy();
    expect(screen.queryByText('Gain on it')).toBeNull();
  });
});
