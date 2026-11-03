// @vitest-environment jsdom
/**
 * A holding row's "⋮" (D332-D334, D366-D369): Buy and Sell open the trade form
 * as a record of a trade made at the broker - at the user's price first - once
 * the cash is set; Edit and Remove are corrections. Every row has every
 * action, and one that does not apply is disabled with its reason: Buy without
 * free cash, Sell and the corrections on a row the real portfolio does not
 * hold, research without an active research agent. Ask fills the question in;
 * Research rates the one stock after a confirmation.
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
const { renderPage } = await import('./serverStateHarness.tsx');
const { t } = await import('../src/i18n/index.ts');

const PRIMARY = '90000000-0000-0000-0000-000000000001';
const INSTRUMENT = '10000000-0000-0000-0000-000000000001';
const ANALYST = { id: '90000000-0000-0000-0000-0000000000a1', name: 'Analyst', state: 'active' };
let cashState: 'open' | 'unset' | 'empty' = 'open';
let researchAgent: typeof ANALYST | null = ANALYST;

beforeEach(() => {
  vi.clearAllMocks();
  cashState = 'open';
  researchAgent = ANALYST;
  get.mockImplementation(async (path: string) => {
    if (path === '/agents') return { agents: [{ id: PRIMARY, isPrimary: true, name: 'Main portfolio', state: 'active' }] };
    if (path === '/portfolio/cash') {
      if (cashState === 'unset') return { state: 'unset' };
      const cashMinor = cashState === 'empty' ? 0 : 100_000;
      return { state: 'open', currency: 'USD', cashMinor, depositsMinor: 100_000, openingHoldingsCostMinor: 0, investedMinor: 100_000, feesPaidMinor: 0 };
    }
    if (path === '/research') return { agent: researchAgent, run: null, holdings: [] };
    if (path === '/settings/model-access') return { block: null };
    return new Promise(() => {});
  });
});
afterEach(cleanup);

/** A row the real portfolio holds; `held: false` is a row only an agent holds. */
function open({ held = true } = {}) {
  const onEdit = vi.fn();
  const onRemove = vi.fn();
  const rendered = renderPage(
    <HoldingRowMenu
      symbol="AAPL"
      instrumentId={INSTRUMENT}
      onEdit={held ? onEdit : undefined}
      onRemove={held ? onRemove : undefined}
    />,
  );
  return { onEdit, onRemove, root: rendered.root };
}

const item = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

const menuButton = () => screen.getByRole('button', { name: 'Actions for AAPL' });

describe('a holding’s actions', () => {
  it('records a buy at the price the user got, on the main portfolio', async () => {
    post.mockResolvedValue({
      symbol: 'AAPL', name: 'Apple', side: 'buy', quantity: '2', priceSource: 'user', priceMinor: 20_000,
      quoteAsOf: null, quoteDelaySeconds: null, notionalMinor: 40_000, feeMinor: 750, cashChangeMinor: -40_750,
      cashMinor: 100_000, cashAfterMinor: 59_250, heldQuantity: '0', heldAfterQuantity: '2', currency: 'USD', warnings: [],
    });
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for AAPL' }));
    await waitFor(() => expect(item('Buy').disabled).toBe(false));
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
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for AAPL' }));
    await screen.findByText(/Set the cash on the Account card/);
    expect((screen.getByRole('button', { name: 'Buy' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Sell' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('edits and removes as corrections, and closes on Escape', async () => {
    const { onEdit, onRemove } = open();
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for AAPL' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onEdit).toHaveBeenCalled();
    fireEvent.click(menuButton());
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onRemove).toHaveBeenCalled();
    fireEvent.click(menuButton());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('disables Buy without free cash, and says how to add some', async () => {
    cashState = 'empty';
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for AAPL' }));
    await screen.findByText(t('holdings.menu.noFreeCash'));
    expect(item('Buy').disabled).toBe(true);
    expect(item('Sell').disabled).toBe(false);
  });

  it('on a row only an agent holds, buys but never sells or corrects, and says why', async () => {
    open({ held: false });
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for AAPL' }));
    await waitFor(() => expect(item('Buy').disabled).toBe(false));
    expect(item('Sell').disabled).toBe(true);
    expect(item('Edit').disabled).toBe(true);
    expect(item('Remove').disabled).toBe(true);
    expect(screen.getByText(t('holdings.menu.notHeld'))).toBeTruthy();
    expect(screen.getByText(t('holdings.menu.agentOnly'))).toBeTruthy();
  });

  it('asks about the stock with the question filled in, not sent', async () => {
    const { root } = open({ held: false });
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for AAPL' }));
    fireEvent.click(item(t('holdings.menu.ask')));
    expect(root.ask.draft).toBe(t('holdings.menu.askDraft', { symbol: 'AAPL' }));
    expect(post).not.toHaveBeenCalled();
  });

  it('researches the one stock after a confirmation', async () => {
    post.mockResolvedValue({ run_id: 'r1', holdings: 1 });
    open({ held: false });
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for AAPL' }));
    await waitFor(() => expect(item(t('holdings.menu.research')).disabled).toBe(false));
    fireEvent.click(item(t('holdings.menu.research')));
    const dialog = screen.getByRole('dialog', { name: t('holdings.researchStock.title', { symbol: 'AAPL' }) });
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: t('holdings.researchStock.confirm') }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/research/runs', { instrumentId: INSTRUMENT }));
  });

  it('disables research until a research agent is chosen, and says where', async () => {
    researchAgent = null;
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for AAPL' }));
    await screen.findByText(t('holdings.menu.researchBlocked.noAgent'));
    expect(item(t('holdings.menu.research')).disabled).toBe(true);
  });
});
