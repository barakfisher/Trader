// @vitest-environment jsdom
/**
 * Writes to the portfolio, rendered: a refused write changes nothing and says
 * why; an accepted one refreshes every screen reading the portfolio.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

import type { PortfolioResponse } from '@traders/shared';

const get = vi.fn();
const post = vi.fn();

vi.mock('../src/api/client.ts', () => {
  class ApiRequestError extends Error {
    constructor(
      message: string,
      readonly status = 500,
      readonly code = 'error',
    ) {
      super(message);
    }
  }
  return {
    api: { get, post, postForm: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    ApiRequestError,
    errorMessage: (error: unknown, fallback: string) =>
      error instanceof ApiRequestError ? error.message : fallback,
  };
});

const { ApiRequestError } = await import('../src/api/client.ts');
const { AddHoldingForm } = await import('../src/components/AddHoldingForm.tsx');
const { SummaryCards } = await import('../src/components/SummaryCards.tsx');
const { renderWithServerState } = await import('./serverStateHarness.tsx');

function portfolioWorth(totalValueMinor: number): PortfolioResponse {
  return {
    summary: {
      baseCurrency: 'USD',
      totalValueMinor,
      totalCostMinor: 50000,
      pnlMinor: totalValueMinor - 50000,
      pnlPct: 0,
      dayChangeMinor: 0,
      dayChangePct: 0,
      holdingsCount: 1,
      pricedCount: 1,
      unpricedSymbols: [],
      degraded: false,
      asOf: '2026-09-29T10:00:00Z',
    },
    holdings: [],
    allocationByInstrument: [],
    allocationByAssetClass: [],
  };
}

function fillAndSubmit(symbol: string) {
  fireEvent.change(screen.getByPlaceholderText('AAPL'), { target: { value: symbol } });
  fireEvent.change(screen.getByPlaceholderText('10'), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: /add holding/i }));
}

describe('adding a holding', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('refreshes the portfolio on every screen once the server accepts it', async () => {
    get.mockResolvedValueOnce(portfolioWorth(100000)).mockResolvedValueOnce(portfolioWorth(250000));
    post.mockResolvedValue({ id: 'h-1' });
    renderWithServerState(
      <>
        <SummaryCards />
        <AddHoldingForm />
      </>,
    );
    expect(await screen.findByText('$1,000.00')).toBeTruthy();

    fillAndSubmit('MSFT');

    expect(await screen.findByText('$2,500.00')).toBeTruthy();
    expect(post).toHaveBeenCalledWith('/holdings', {
      symbol: 'MSFT',
      quantity: '1',
      costBasis: null,
      openedAt: null,
    });
    // The form empties only on success, so a refusal leaves the typing to fix.
    await waitFor(() => expect((screen.getByPlaceholderText('AAPL') as HTMLInputElement).value).toBe(''));
  });

  it('reports a refusal, keeps the typing, and does not refetch', async () => {
    get.mockResolvedValue(portfolioWorth(100000));
    post.mockRejectedValue(
      new ApiRequestError('no market data provider could price "NOSUCH"', 422, 'unresolved_symbol'),
    );
    renderWithServerState(
      <>
        <SummaryCards />
        <AddHoldingForm />
      </>,
    );
    await screen.findByText('$1,000.00');

    fillAndSubmit('NOSUCH');

    expect(await screen.findByText(/could price "NOSUCH"/)).toBeTruthy();
    expect((screen.getByPlaceholderText('AAPL') as HTMLInputElement).value).toBe('NOSUCH');
    expect(get).toHaveBeenCalledTimes(1);
  });
});
