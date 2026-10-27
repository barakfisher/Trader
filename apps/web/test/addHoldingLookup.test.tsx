// @vitest-environment jsdom
/**
 * The add-holding form's lookup, rendered (D324-D326): local suggestions first,
 * the market search only when the local list has none, and a cost prefilled from
 * the latest price that never overwrites what the user typed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

import type { InstrumentQuoteResponse } from '@traders/shared';

const get = vi.fn();

vi.mock('../src/api/client.ts', () => ({
  api: { get, post: vi.fn(), postForm: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  ApiRequestError: class extends Error {},
  errorMessage: (_error: unknown, fallback: string) => fallback,
}));

const { AddHoldingForm } = await import('../src/components/AddHoldingForm.tsx');
const { renderWithServerState } = await import('./serverStateHarness.tsx');

const QUOTES: Record<string, InstrumentQuoteResponse> = {
  AAPL: { symbol: 'AAPL', priceMinor: 23214, currency: 'USD', asOf: new Date().toISOString() },
  MSFT: { symbol: 'MSFT', priceMinor: 41000, currency: 'USD', asOf: new Date().toISOString() },
  NOPRICE: { symbol: 'NOPRICE', priceMinor: null, currency: null, asOf: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  get.mockImplementation(async (path: string) => {
    if (path === '/instruments') {
      return {
        instruments: [
          { symbol: 'AAPL', name: 'Apple Inc.', assetClass: 'equity', exchange: 'NMS' },
          { symbol: 'MSFT', name: 'Microsoft Corporation', assetClass: 'equity', exchange: 'NMS' },
        ],
      };
    }
    if (path.startsWith('/instruments/search')) {
      return {
        query: 'teva',
        matches: [{ symbol: 'TEVA.TA', name: 'Teva Pharmaceutical Industries', assetClass: 'equity', exchange: 'Tel Aviv' }],
      };
    }
    const quote = /^\/instruments\/([^/]+)\/quote$/.exec(path);
    if (quote) return QUOTES[decodeURIComponent(quote[1]!)] ?? { ...QUOTES.NOPRICE, symbol: quote[1] };
    throw new Error(`unexpected GET ${path}`);
  });
});
afterEach(cleanup);

const symbolField = () => screen.getByPlaceholderText('Symbol or company name') as HTMLInputElement;
const costField = () => screen.getByPlaceholderText(/185\.40|Fetching/) as HTMLInputElement;
const searches = () => get.mock.calls.filter(([path]) => String(path).startsWith('/instruments/search'));

async function choose(typed: string, option: RegExp) {
  fireEvent.change(symbolField(), { target: { value: typed } });
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

describe('the add-holding lookup', () => {
  it('suggests from the local list without asking the market', async () => {
    renderWithServerState(<AddHoldingForm />);
    await waitFor(() => expect(get).toHaveBeenCalledWith('/instruments'));
    fireEvent.change(symbolField(), { target: { value: 'micro' } });
    expect(await screen.findByRole('option', { name: /MSFT/ })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(searches()).toHaveLength(0);
  });

  it('asks the market search once typing pauses and the local list has no match', async () => {
    renderWithServerState(<AddHoldingForm />);
    await waitFor(() => expect(get).toHaveBeenCalledWith('/instruments'));
    await choose('teva', /TEVA\.TA/);
    expect(symbolField().value).toBe('TEVA.TA');
    // The chosen symbol is not searched again, and no "not found" follows it.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(searches()).toEqual([['/instruments/search?q=teva']]);
    expect(screen.queryByText(/No listing found/)).toBeNull();
  });

  it('offers the market search after local matches, for listings the local list lacks', async () => {
    renderWithServerState(<AddHoldingForm />);
    await waitFor(() => expect(get).toHaveBeenCalledWith('/instruments'));
    fireEvent.change(symbolField(), { target: { value: 'micro' } });
    fireEvent.click(await screen.findByRole('option', { name: /Search the market for “MICRO”/ }));
    await waitFor(() => expect(searches()).toEqual([['/instruments/search?q=micro']]));
    expect(await screen.findByRole('option', { name: /TEVA\.TA/ })).toBeTruthy();
    expect(symbolField().value).toBe('MICRO');
  });

  it('prefills the cost from the latest price and follows a changed symbol', async () => {
    renderWithServerState(<AddHoldingForm />);
    await choose('aap', /AAPL/);
    await waitFor(() => expect(costField().value).toBe('232.14'));
    expect(screen.getByText(/Latest price \u2066\$232\.14\u2069/)).toBeTruthy();

    await choose('msf', /MSFT/);
    await waitFor(() => expect(costField().value).toBe('410.00'));
  });

  it('never overwrites a cost the user typed', async () => {
    renderWithServerState(<AddHoldingForm />);
    await choose('aap', /AAPL/);
    await waitFor(() => expect(costField().value).toBe('232.14'));
    fireEvent.change(costField(), { target: { value: '150' } });

    await choose('msf', /MSFT/);
    await waitFor(() => expect(get).toHaveBeenCalledWith('/instruments/MSFT/quote'));
    expect(costField().value).toBe('150');
  });

  it('leaves the cost empty, not zero, when no price is known', async () => {
    renderWithServerState(<AddHoldingForm />);
    fireEvent.change(symbolField(), { target: { value: 'NOPRICE' } });
    fireEvent.blur(symbolField());
    expect(await screen.findByText(/No price is available/)).toBeTruthy();
    expect(costField().value).toBe('');
  });

  it('defaults the opening date to today and refuses a future one', () => {
    const { container } = renderWithServerState(<AddHoldingForm />);
    const date = container.querySelector('input[type="date"]') as HTMLInputElement;
    expect(date.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(date.max).toBe(date.value);
  });
});
