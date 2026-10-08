// @vitest-environment jsdom
/**
 * A simulated agent's page with Stage 3's ledger (D21, D22, D27-D31).
 *
 * Pinned: the account shows cash, net worth and profit against deposits, and
 * no totals when a holding is unpriced; a trade is previewed before it can be
 * confirmed, and the confirm carries the previewed price and the preview's
 * idempotency key; editing the trade discards the preview; a moved price is
 * explained with the new figure; a holding's Sell opens the panel on it; cash
 * is added by amount; the activity timeline shows each movement with the
 * balance after it; and an archived agent offers no trade.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';

import type {
  ActivityResponse,
  AgentAccountResponse,
  AgentPerformanceResponse,
  AgentScanDetail,
  AgentScansResponse,
  AgentView,
  HoldingView,
  TradePreview,
} from '@traders/shared';

const get = vi.fn();
const post = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>('../src/api/client.ts');
  return { ...actual, api: { get, post, put: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() } };
});

const { ApiRequestError } = await import('../src/api/client.ts');
const { App } = await import('../src/App.tsx');
const { createAppRouter } = await import('../src/router.tsx');
const { renderWithServerState } = await import('./serverStateHarness.tsx');

const AGENT_ID = '90000000-0000-0000-0000-0000000000a1';

const AGENT: AgentView = {
  id: AGENT_ID,
  name: 'Momentum',
  isPrimary: false,
  persona: null,
  budgetMinor: 1_000_000,
  cashMinor: 832_542,
  currency: 'USD',
  state: 'active',
  holdingsCount: 1,
  createdAt: '2026-10-05T10:00:00Z',
  scanSchedule: 'pre_open',
  llmBudgetMicroUsd: 500_000,
  llmSpentTodayMicroUsd: 108_022,
  scanCost: { microUsd: 36_000, basis: 'measured' },
  waitingForPersona: true,
};

const AAPL: HoldingView = {
  id: 'h-aapl',
  instrument: { id: 'i-aapl', symbol: 'AAPL', name: 'Apple', assetClass: 'equity', exchange: 'NMS', currency: 'USD' },
  quantity: '5.000000000000000000',
  costBasisMinor: 33_458,
  costCurrency: 'USD',
  openedAt: '2026-10-05',
  notes: null,
  quote: null,
  valueMinor: 168_000,
  costMinor: 167_290,
  pnlMinor: 710,
  pnlPct: 0.42,
  weightPct: 100,
  fxRate: null,
};

function account(overrides: Partial<AgentAccountResponse> = {}): AgentAccountResponse {
  return {
    currency: 'USD',
    cashMinor: 832_542,
    depositsMinor: 1_000_000,
    holdingsValueMinor: 168_000,
    netWorthMinor: 1_000_542,
    pnlMinor: 542,
    pnlPct: 0.0542,
    portfolio: {
      summary: {
        baseCurrency: 'USD',
        totalValueMinor: 168_000,
        totalCostMinor: 167_290,
        pnlMinor: 710,
        pnlPct: 0.42,
        dayChangeMinor: null,
        dayChangePct: null,
        holdingsCount: 1,
        pricedCount: 1,
        unpricedSymbols: [],
        degraded: false,
        asOf: '2026-10-05T16:45:00Z',
      },
      holdings: [AAPL],
      allocationByInstrument: [],
      allocationByAssetClass: [],
    },
    ...overrides,
  };
}

const ACTIVITY: ActivityResponse = {
  currency: 'USD',
  entries: [
    {
      id: 'm-2',
      kind: 'buy',
      amountMinor: -167_458,
      balanceAfterMinor: 832_542,
      createdAt: '2026-10-05T16:40:00Z',
      fill: {
        id: 'f-1',
        symbol: 'AAPL',
        side: 'buy',
        quantity: '5',
        priceMinor: 33_458,
        notionalMinor: 167_290,
        feeMinor: 168,
        currency: 'USD',
        priceSource: 'quote',
        quoteAsOf: '2026-10-05T16:30:00Z',
        quoteDelaySeconds: 900,
        source: 'manual_user_override',
        createdAt: '2026-10-05T16:40:00Z',
      },
    },
    {
      id: 'm-1',
      kind: 'opening_deposit',
      amountMinor: 1_000_000,
      balanceAfterMinor: 1_000_000,
      createdAt: '2026-10-05T10:00:00Z',
      fill: null,
    },
  ],
};

const PREVIEW: TradePreview = {
  symbol: 'AAPL',
  name: 'Apple',
  side: 'buy',
  quantity: '2',
  priceSource: 'quote',
  priceMinor: 33_500,
  quoteAsOf: '2026-10-05T16:45:00Z',
  quoteDelaySeconds: 900,
  notionalMinor: 67_000,
  feeMinor: 150,
  cashChangeMinor: -67_150,
  cashMinor: 832_542,
  cashAfterMinor: 765_392,
  heldQuantity: '5',
  heldAfterQuantity: '7',
  currency: 'USD',
  warnings: [],
};

function serve(routes: Record<string, unknown>) {
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
  get.mockImplementation((path: string) => {
    const key = keys.find((prefix) => path === prefix || path.startsWith(`${prefix}?`));
    return key === undefined ? new Promise(() => {}) : Promise.resolve(routes[key]);
  });
}

/** $10,000 deposited, at one close: the agent up $100, SPY up $250 on the same money. */
const PERFORMANCE: AgentPerformanceResponse = {
  currency: 'USD',
  benchmarkSymbol: 'SPY',
  series: [{ day: '2026-10-02', netWorthMinor: 1_010_000, benchmarkMinor: 1_025_000, depositsMinor: 1_000_000 }],
  comparison: {
    day: '2026-10-02',
    depositsMinor: 1_000_000,
    netWorthMinor: 1_010_000,
    pnlMinor: 10_000,
    returnPct: 1,
    benchmarkMinor: 1_025_000,
    benchmarkPnlMinor: 25_000,
    benchmarkReturnPct: 2.5,
    differencePts: -1.5,
  },
  pendingDepositsMinor: 0,
  score: {
    agentDecisions: 0,
    windows: [30, 60, 90].map((days) => ({ days, decisions: 0, sells: 0, wins: 0, winRatePct: null, realisedPnlMinor: 0 })),
    unrealisedPnlMinor: 0,
  },
};

const SCAN_ID = 'b0000000-0000-0000-0000-000000000001';

const SCAN_SUMMARY = {
  id: SCAN_ID,
  trigger: 'manual' as const,
  startedAt: '2026-10-07T15:00:00Z',
  finishedAt: '2026-10-07T15:00:12Z',
  outcome: 'trade' as const,
  steps: 1,
  costMicroUsd: 41_000,
  model: 'anthropic/claude-sonnet-5.5',
  decision: 'buy' as const,
  symbol: 'NVDA',
  quantity: '2',
  problems: [],
  error: null,
  proposal: { id: 'p-1', state: 'pending' as const },
  fillId: null,
};

const SCANS: AgentScansResponse = {
  scans: [SCAN_SUMMARY, { ...SCAN_SUMMARY, id: 's-2', outcome: 'no_trade', decision: 'none', symbol: null, quantity: null, proposal: null, costMicroUsd: 14_600 }],
  nextBefore: null,
};

const SCAN_DETAIL: AgentScanDetail = {
  ...SCAN_SUMMARY,
  briefing: { cash: '10000.00', holdings: [], movers: { day_gainers: [{ symbol: 'NVDA' }], day_losers: [] } },
  transcript: [
    { role: 'assistant', text: 'NVDA moved; checking its quote.', toolCalls: [{ id: 'c1', name: 'get_quote', arguments: { symbol: 'NVDA' } }] },
    { role: 'tool', callId: 'c1', name: 'get_quote', result: { price: '237.14' } },
    { role: 'assistant', text: '{"decision": "buy", "thesis": "NVDA trades at 237.14."}', toolCalls: [] },
  ],
  thesis: 'NVDA trades at 237.14.',
};

function serveAgent(agent: AgentView = AGENT, accountBody: AgentAccountResponse = account()) {
  serve({
    [`/agents/${AGENT_ID}`]: agent,
    [`/agents/${AGENT_ID}/account`]: accountBody,
    [`/agents/${AGENT_ID}/activity`]: ACTIVITY,
    [`/agents/${AGENT_ID}/performance`]: PERFORMANCE,
    [`/agents/${AGENT_ID}/scans`]: SCANS,
    [`/agents/${AGENT_ID}/scans/${SCAN_ID}`]: SCAN_DETAIL,
    // The app bar's inbox count: a scan re-reads it, and waits for it.
    '/proposals': { proposals: [] },
  });
}

function renderAgent() {
  // jsdom has no layout; the router restores scroll on navigation.
  window.scrollTo = () => {};
  const router = createAppRouter(createMemoryHistory({ initialEntries: [`/agents/${AGENT_ID}`] }));
  const result = renderWithServerState(<App router={router} />);
  act(() => {
    result.root.auth.user = { id: 'u', baseCurrency: 'USD', timezone: 'Asia/Jerusalem' } as never;
    result.root.auth.initialised = true;
  });
  return result;
}

async function openTrade() {
  fireEvent.click(await screen.findByRole('button', { name: 'Trade' }));
  return screen.getByRole('dialog');
}

describe('AgentPage with the ledger', () => {
  beforeEach(() => {
    // jsdom has no layout, so no ResizeObserver; the performance chart's container needs one to mount.
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    vi.clearAllMocks();
    serveAgent();
  });
  afterEach(cleanup);

  it('shows cash, holdings at market, net worth and profit against deposits', async () => {
    renderAgent();
    expect(await screen.findByText('Net worth')).toBeTruthy();
    expect(screen.getByText('$8,325.42')).toBeTruthy();
    expect(screen.getByText('$10,005.42')).toBeTruthy();
    expect(screen.getByText(/Net worth minus everything deposited \(\$10,000\.00\)/)).toBeTruthy();
    expect(screen.getByText('AAPL')).toBeTruthy();
    expect(screen.getByText('5 shares · average cost $334.58')).toBeTruthy();
  });

  it('compares the agent with SPY on the same deposits, and has no score before the agent decides (D24, D42)', async () => {
    renderAgent();
    expect(await screen.findByText('SPY with the same deposits')).toBeTruthy();
    expect(screen.getByText('-1.50 pts')).toBeTruthy();
    expect(screen.getByText(/Each deposit buys SPY at the first market close after it, without fees/)).toBeTruthy();
    expect(screen.getByText(/No agent decisions yet/)).toBeTruthy();
  });

  it('shows no totals when a holding is unpriced, and names it', async () => {
    serveAgent(
      AGENT,
      account({
        holdingsValueMinor: null,
        netWorthMinor: null,
        pnlMinor: null,
        pnlPct: null,
        portfolio: { ...account().portfolio, summary: { ...account().portfolio.summary, unpricedSymbols: ['AAPL'] } },
      }),
    );
    renderAgent();
    expect(await screen.findByText('Totals unavailable: AAPL could not be priced.')).toBeTruthy();
    expect(screen.queryByText('$10,005.42')).toBeNull();
  });

  it('previews before confirming, and confirms with the previewed price and one key', async () => {
    post.mockImplementation((path: string) =>
      Promise.resolve(path.endsWith('/preview') ? PREVIEW : { created: true }),
    );
    renderAgent();
    const panel = await openTrade();
    expect(within(panel).queryByRole('button', { name: 'Confirm buy' })).toBeNull();
    fireEvent.change(within(panel).getByLabelText('Symbol'), { target: { value: 'aapl' } });
    fireEvent.change(within(panel).getByLabelText('Shares (whole)'), { target: { value: '2' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Preview' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(`/agents/${AGENT_ID}/trades/preview`, {
        symbol: 'AAPL',
        side: 'buy',
        quantity: '2',
      }),
    );
    expect(await within(panel).findByText('$1.50')).toBeTruthy();
    expect(within(panel).getByText('$7,653.92')).toBeTruthy();

    fireEvent.click(within(panel).getByRole('button', { name: 'Confirm buy' }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    const [path, body] = post.mock.calls[1]!;
    expect(path).toBe(`/agents/${AGENT_ID}/trades`);
    expect(body).toMatchObject({ symbol: 'AAPL', side: 'buy', quantity: '2', shownPriceMinor: 33_500 });
    expect(typeof (body as { idempotencyKey: string }).idempotencyKey).toBe('string');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('discards the preview when the trade is edited', async () => {
    post.mockResolvedValue(PREVIEW);
    renderAgent();
    const panel = await openTrade();
    fireEvent.change(within(panel).getByLabelText('Symbol'), { target: { value: 'AAPL' } });
    fireEvent.change(within(panel).getByLabelText('Shares (whole)'), { target: { value: '2' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Preview' }));
    expect(await within(panel).findByRole('button', { name: 'Confirm buy' })).toBeTruthy();
    fireEvent.change(within(panel).getByLabelText('Shares (whole)'), { target: { value: '3' } });
    expect(within(panel).queryByRole('button', { name: 'Confirm buy' })).toBeNull();
  });

  it('refuses a fractional quantity before asking the server', async () => {
    renderAgent();
    const panel = await openTrade();
    fireEvent.change(within(panel).getByLabelText('Symbol'), { target: { value: 'AAPL' } });
    fireEvent.change(within(panel).getByLabelText('Shares (whole)'), { target: { value: '1.5' } });
    expect((within(panel).getByRole('button', { name: 'Preview' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('explains a moved price with the new figure', async () => {
    post.mockImplementation((path: string) =>
      path.endsWith('/preview')
        ? Promise.resolve(PREVIEW)
        : Promise.reject(
            new ApiRequestError('moved', 409, 'price_moved', { shownPriceMinor: 33_500, livePriceMinor: 34_000 }),
          ),
    );
    renderAgent();
    const panel = await openTrade();
    fireEvent.change(within(panel).getByLabelText('Symbol'), { target: { value: 'AAPL' } });
    fireEvent.change(within(panel).getByLabelText('Shares (whole)'), { target: { value: '2' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Preview' }));
    fireEvent.click(await within(panel).findByRole('button', { name: 'Confirm buy' }));
    expect(
      await within(panel).findByText('The price moved to $340.00 since the preview. Preview again to see the new figures.'),
    ).toBeTruthy();
  });

  it('sends a typed price and shows how far it is from the last quote', async () => {
    post.mockResolvedValue({
      ...PREVIEW,
      priceSource: 'user',
      priceMinor: 99_900,
      quoteAsOf: null,
      warnings: [
        { kind: 'typed_price_far_from_quote', deviationBps: 19_858, referencePriceMinor: 33_458, referenceAsOf: '2026-10-05T16:30:00Z' },
      ],
    });
    renderAgent();
    const panel = await openTrade();
    fireEvent.change(within(panel).getByLabelText('Symbol'), { target: { value: 'AAPL' } });
    fireEvent.change(within(panel).getByLabelText('Shares (whole)'), { target: { value: '2' } });
    fireEvent.click(within(panel).getByLabelText('My price'));
    fireEvent.change(within(panel).getByLabelText('Price per share (USD)'), { target: { value: '999' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Preview' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(`/agents/${AGENT_ID}/trades/preview`, {
        symbol: 'AAPL',
        side: 'buy',
        quantity: '2',
        price: '999',
      }),
    );
    expect((await within(panel).findByRole('alert')).textContent).toContain('+198.6%');
  });

  it("opens the panel on a holding's Sell, set to sell it", async () => {
    renderAgent();
    fireEvent.click(await screen.findByRole('button', { name: 'Sell' }));
    const panel = screen.getByRole('dialog');
    expect((within(panel).getByLabelText('Symbol') as HTMLInputElement).value).toBe('AAPL');
    expect((within(panel).getByLabelText('Sell') as HTMLInputElement).checked).toBe(true);
  });

  it('adds cash by amount', async () => {
    post.mockResolvedValue(AGENT);
    renderAgent();
    fireEvent.click(await screen.findByRole('button', { name: 'Add cash' }));
    fireEvent.change(screen.getByLabelText('Amount (USD)'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/agents/${AGENT_ID}/top-ups`, { amount: '500' }));
  });

  it('lists every movement with the balance it left', async () => {
    renderAgent();
    fireEvent.click(await screen.findByRole('tab', { name: 'Activity' }));
    expect(await screen.findByText('Bought 5 AAPL at $334.58')).toBeTruthy();
    expect(screen.getByText('Opening deposit')).toBeTruthy();
    expect(screen.getByText('Cash after: $8,325.42')).toBeTruthy();
    expect(screen.getByText('Cash after: $10,000.00')).toBeTruthy();
  });

  it('offers no trade, sell or added cash on an archived agent', async () => {
    serveAgent({ ...AGENT, state: 'archived' });
    renderAgent();
    expect(await screen.findByText('Net worth')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Trade' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sell' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add cash' })).toBeNull();
  });

  it('lists every scan with its outcome and cost, and opens one to its steps and answer (D50, D64)', async () => {
    renderAgent();
    fireEvent.click(await screen.findByRole('tab', { name: 'Decisions' }));
    expect(await screen.findByText('Proposed')).toBeTruthy();
    expect(screen.getByText('No trade')).toBeTruthy();
    expect(screen.getByText('Buy 2 NVDA')).toBeTruthy();
    expect(screen.getByText('$0.041 · 1 step')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Buy 2 NVDA/, expanded: false }));
    expect(await screen.findByText('NVDA trades at 237.14.')).toBeTruthy();
    expect(screen.getByText('Started from: cash $10,000.00, 0 holdings, 1 movers of the day')).toBeTruthy();
    expect(screen.getByText('NVDA moved; checking its quote.')).toBeTruthy();
    expect(screen.getByText(/Looked up get_quote/)).toBeTruthy();
    expect(screen.getByText('The proposal').closest('a')?.getAttribute('href')).toBe('/proposals/p-1');
    // The final turn is the answer: read once, above; its raw JSON folded, not shown as prose.
    expect(screen.getAllByText('NVDA trades at 237.14.')).toHaveLength(1);
    expect(screen.getByText('Its raw answer')).toBeTruthy();
  });

  it('waits for a persona, and offers no scan until it has one (D52)', async () => {
    renderAgent();
    expect(await screen.findByText('Waiting for a persona')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Run a scan now' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Give the agent a persona first: it decides by it.')).toBeTruthy();
  });

  it('runs a scan, says what it proposed, and shows its expected cost (D65)', async () => {
    serveAgent({ ...AGENT, persona: 'Patient.', waitingForPersona: false });
    post.mockResolvedValueOnce({
      scan_id: SCAN_ID, outcome: 'trade', steps: 1, cost_micro_usd: 41_000, model: 'm', error: null,
      answer: { decision: 'buy', symbol: 'NVDA', quantity: '2', thesis: 't' }, proposal_id: 'p-1',
    });
    renderAgent();
    expect(await screen.findByText(/About \$0\.036 a scan \(measured on 7 Oct 2026/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Run a scan now' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/agents/${AGENT_ID}/scans`, {}));
    expect(await screen.findByText(/Proposed: Buy 2 NVDA\./)).toBeTruthy();
    expect(screen.getByText('Review the proposal').closest('a')?.getAttribute('href')).toBe('/proposals/p-1');
  });

  it('says why a scan was refused, in the reader\'s words', async () => {
    serveAgent({ ...AGENT, persona: 'Patient.', waitingForPersona: false });
    post.mockRejectedValueOnce(new ApiRequestError('busy', 409, 'scan_running'));
    renderAgent();
    fireEvent.click(await screen.findByRole('button', { name: 'Run a scan now' }));
    expect(await screen.findByText('This agent is already scanning.')).toBeTruthy();
  });

  it('saves the schedule and the model budget, with the cost per day and the note that scheduling is not running yet (D45, D46, D66)', async () => {
    const patch = (await import('../src/api/client.ts')).api.patch as ReturnType<typeof vi.fn>;
    patch.mockResolvedValue(AGENT);
    renderAgent();
    const schedule = (await screen.findByLabelText('When it scans')) as HTMLSelectElement;
    expect(screen.getByText(/About \$0\.036 a trading day/)).toBeTruthy();
    expect(screen.getByText(/Scheduled scans are not running yet/)).toBeTruthy();
    expect(screen.getByText(/Spent today: \$0\.108 of \$0\.50/)).toBeTruthy();
    fireEvent.change(schedule, { target: { value: 'pre_open_post_close' } });
    expect(screen.getByText(/About \$0\.072 a trading day/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Model budget per day (USD)'), { target: { value: '1.25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save scan settings' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(`/agents/${AGENT_ID}`, { scanSchedule: 'pre_open_post_close', llmBudget: '1.25' }),
    );
  });
});
