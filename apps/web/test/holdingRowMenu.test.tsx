// @vitest-environment jsdom
/**
 * A main-portfolio holding's "⋮" (D332-D334): Buy and Sell open the trade form
 * as a record of a trade made at the broker - at the user's price first - once
 * the cash is set; Edit and Remove are corrections.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

const get = vi.fn();
const post = vi.fn();

vi.mock('../src/api/client.ts', () => ({
  api: { get, post, put: vi.fn(), postForm: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  ApiRequestError: class extends Error {},
  errorMessage: (_error: unknown, fallback: string) => fallback,
}));

const { HoldingRowMenu } = await import('../src/components/HoldingRowMenu.tsx');
const { renderWithServerState } = await import('./serverStateHarness.tsx');

const PRIMARY = '90000000-0000-0000-0000-000000000001';
let cashState: 'open' | 'unset' = 'open';

beforeEach(() => {
  vi.clearAllMocks();
  cashState = 'open';
  get.mockImplementation(async (path: string) => {
    if (path === '/agents') return { agents: [{ id: PRIMARY, isPrimary: true, name: 'Main portfolio', state: 'active' }] };
    if (path === '/portfolio/cash') {
      return cashState === 'unset'
        ? { state: 'unset' }
        : { state: 'open', currency: 'USD', cashMinor: 100_000, depositsMinor: 100_000, openingHoldingsCostMinor: 0, investedMinor: 100_000, feesPaidMinor: 0 };
    }
    throw new Error(`unexpected GET ${path}`);
  });
});
afterEach(cleanup);

function open(onEdit = vi.fn(), onRemove = vi.fn()) {
  renderWithServerState(<HoldingRowMenu symbol="AAPL" onEdit={onEdit} onRemove={onRemove} />);
  return { onEdit, onRemove };
}

const menuButton = () => screen.getByRole('button', { name: 'Actions for AAPL' });

describe('a holding’s actions', () => {
  it('records a buy at the price the user got, on the main portfolio', async () => {
    post.mockResolvedValue({
      symbol: 'AAPL', name: 'Apple', side: 'buy', quantity: '2', priceSource: 'user', priceMinor: 20_000,
      quoteAsOf: null, quoteDelaySeconds: null, notionalMinor: 40_000, feeMinor: 750, cashChangeMinor: -40_750,
      cashMinor: 100_000, cashAfterMinor: 59_250, heldQuantity: '0', heldAfterQuantity: '2', currency: 'USD', warnings: [],
    });
    open();
    await waitFor(() => expect(get).toHaveBeenCalledWith('/portfolio/cash'));
    fireEvent.click(menuButton());
    await waitFor(() => expect((screen.getByRole('button', { name: 'Buy' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Buy' }));

    const form = screen.getByRole('dialog', { name: 'Record a trade' });
    expect(within(form).getByText(/Nothing is sent to your broker/)).toBeTruthy();
    // "My price" is chosen: the record is of a trade already made.
    expect((within(form).getByLabelText('My price') as HTMLInputElement).checked).toBe(true);
    fireEvent.change(within(form).getAllByRole('textbox')[1]!, { target: { value: '2' } });
    fireEvent.change(within(form).getByLabelText('Price per share (USD)'), { target: { value: '200' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Preview' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(`/agents/${PRIMARY}/trades/preview`, {
        symbol: 'AAPL',
        side: 'buy',
        quantity: '2',
        price: '200',
      }),
    );
  });

  it('offers Buy and Sell only once the cash is set, and says where to set it', async () => {
    cashState = 'unset';
    open();
    await waitFor(() => expect(get).toHaveBeenCalledWith('/portfolio/cash'));
    fireEvent.click(menuButton());
    await screen.findByText(/Set the cash on the Account card/);
    expect((screen.getByRole('button', { name: 'Buy' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Sell' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('edits and removes as corrections, and closes on Escape', async () => {
    const { onEdit, onRemove } = open();
    fireEvent.click(menuButton());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onEdit).toHaveBeenCalled();
    fireEvent.click(menuButton());
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onRemove).toHaveBeenCalled();
    fireEvent.click(menuButton());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });
});
