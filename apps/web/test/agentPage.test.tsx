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
  AgentMandate,
  AgentsResponse,
  AgentView,
  HoldingView,
  TradePreview,
} from '@traders/shared';
import { MAX_AGENTS_PER_USER_CEILING } from '@traders/shared';

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
  scanSchedule: { everyHours: null, preOpen: true, postClose: false },
  maxDecisions: 1,
  runningScan: null,
  llmBudgetMicroUsd: 500_000,
  llmSpentTodayMicroUsd: 108_022,
  scanCost: { microUsd: 36_000, basis: 'measured' },
  waitingForBrief: true,
  mandate: null,
  instructionsConflicts: null,
  scheduling: { enabled: true, nextAt: '2026-10-08T13:00:00Z' },
};

const MANDATE: AgentMandate = {
  riskLevel: null,
  horizon: null,
  thesisStyle: null,
  maxPositionBps: null,
  cashBufferBps: null,
  maxHoldings: null,
  allowEtfs: true,
  marketCaps: [],
  sectors: [],
  industries: [],
  etfCategories: [],
  blockedSymbols: [],
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
    feesPaidMinor: 1_500,
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
        uncostedSymbols: [],
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
  trades: [
    {
      decision: 'buy' as const,
      symbol: 'NVDA',
      quantity: '2',
      thesis: 'NVDA trades at 237.14.',
      fundedBy: [],
      refused: false,
      problems: [],
      proposal: { id: 'p-1', state: 'pending' as const },
      fillId: null,
    },
  ],
  problems: [],
  cashUnjustified: false,
  error: null,
};

const SCANS: AgentScansResponse = {
  scans: [
    SCAN_SUMMARY,
    { ...SCAN_SUMMARY, id: 's-2', outcome: 'no_trade', trades: [], costMicroUsd: 14_600, cashUnjustified: true },
  ],
  nextBefore: null,
};

const SCAN_DETAIL: AgentScanDetail = {
  ...SCAN_SUMMARY,
  briefing: { cash: '10000.00', holdings: [], movers: { day_gainers: [{ symbol: 'NVDA' }], day_losers: [] } },
  transcript: [
    { role: 'assistant', text: 'NVDA moved; checking its quote.', toolCalls: [{ id: 'c1', name: 'get_quote', arguments: { symbol: 'NVDA' } }] },
    { role: 'tool', callId: 'c1', name: 'get_quote', result: { price: '237.14' } },
    { role: 'assistant', text: '{"decision": "buy", "quantity": "9"}', toolCalls: [] },
    { role: 'returned', problems: ['NVDA would be 2134.26 at cost, over the 10% position limit'] },
    { role: 'assistant', text: '{"decision": "buy", "thesis": "NVDA trades at 237.14."}', toolCalls: [] },
  ],
  thesis: null,
};

function serveAgent(agent: AgentView = AGENT, accountBody: AgentAccountResponse = account()) {
  serve({
    [`/agents/${AGENT_ID}`]: agent,
    [`/agents/${AGENT_ID}/account`]: accountBody,
    [`/agents/${AGENT_ID}/activity`]: ACTIVITY,
    [`/agents/${AGENT_ID}/performance`]: PERFORMANCE,
    [`/agents/${AGENT_ID}/scans`]: SCANS,
    [`/agents/${AGENT_ID}/scans/${SCAN_ID}`]: SCAN_DETAIL,
    // The review's cards (D340): none here; a scan re-reads them, and waits for it.
    [`/agents/${AGENT_ID}/suggestions`]: { suggestions: [] },
    // The list carries the agent limit, which the state controls read (D199).
    '/agents': { agents: [agent], agentLimit: { used: 1, max: 3, total: 1 } },
    // The app bar's inbox count: a scan re-reads it, and waits for it.
    '/proposals': { proposals: [] },
  });
}

function renderAgent(path = `/agents/${AGENT_ID}`) {
  // jsdom has no layout; the router restores scroll on navigation.
  window.scrollTo = () => {};
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  const result = renderWithServerState(<App router={router} />);
  act(() => {
    result.root.auth.user = { id: 'u', baseCurrency: 'USD', timezone: 'Asia/Jerusalem' } as never;
    result.root.auth.initialised = true;
  });
  return result;
}

/** Render the agent and open one of its tabs. */
async function renderAgentTab(tab: 'Performance' | 'Scans' | 'Settings') {
  renderAgent();
  fireEvent.click(await screen.findByRole('tab', { name: tab }));
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
    await renderAgentTab('Performance');
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

  it('keeps performance, scans and settings behind their own tabs, not on the page until asked for', async () => {
    renderAgent();
    expect(await screen.findByRole('tab', { name: 'Holdings', selected: true })).toBeTruthy();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Holdings',
      'Performance',
      'Activity',
      'Scans',
      'Settings',
    ]);
    expect(screen.queryByText('SPY with the same deposits')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Run a scan now' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'When it scans' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(screen.getByRole('group', { name: 'When it scans' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run a scan now' })).toBeNull();
  });

  /** The agents list, which carries the limit; the agent page reads it from there (D199). */
  function serveAtLimit(agent: AgentView, agentLimit: AgentsResponse['agentLimit']) {
    serve({
      [`/agents/${AGENT_ID}`]: agent,
      [`/agents/${AGENT_ID}/account`]: account(),
      '/agents': { agents: [agent], agentLimit },
      '/proposals': { proposals: [] },
    });
  }

  it('refuses a resume at the limit and says why, but still pauses and archives (D199)', async () => {
    serveAtLimit({ ...AGENT, state: 'paused' }, { used: 3, max: 3, total: 3 });
    await renderAgentTab('Settings');
    expect(await screen.findByText('3 of 3 active: pause another agent to resume this one.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Resume' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Archive' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('restores an agent paused at the limit, and active with room (D199)', async () => {
    const patch = (await import('../src/api/client.ts')).api.patch as ReturnType<typeof vi.fn>;
    patch.mockResolvedValue(AGENT);
    serveAtLimit({ ...AGENT, state: 'archived' }, { used: 3, max: 3, total: 3 });
    await renderAgentTab('Settings');
    expect(await screen.findByText('3 of 3 active: a restored agent comes back paused.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith(`/agents/${AGENT_ID}`, { state: 'paused' }));
    cleanup();

    patch.mockClear();
    serveAtLimit({ ...AGENT, state: 'archived' }, { used: 2, max: 3, total: 2 });
    await renderAgentTab('Settings');
    // With room, loaded or not, a restore asks for active; the server holds the limit.
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith(`/agents/${AGENT_ID}`, { state: 'active' }));
  });

  it('refuses a restore at the ceiling and says why, whatever the active count (D202)', async () => {
    serveAtLimit({ ...AGENT, state: 'archived' }, { used: 3, max: 3, total: MAX_AGENTS_PER_USER_CEILING });
    await renderAgentTab('Settings');
    expect(
      await screen.findByText(
        `You have ${MAX_AGENTS_PER_USER_CEILING} agents, the most anyone may keep: archive another to restore this one.`,
      ),
    ).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Restore' }) as HTMLButtonElement).disabled).toBe(true);
    // The ceiling's reason, not also the active limit's.
    expect(screen.queryByText(/a restored agent comes back paused/)).toBeNull();
  });

  it('lets the admin resume with any number active (D201)', async () => {
    serveAtLimit({ ...AGENT, state: 'paused' }, { used: 9, max: null, total: null });
    await renderAgentTab('Settings');
    const resume = (await screen.findByRole('button', { name: 'Resume' })) as HTMLButtonElement;
    expect(resume.disabled).toBe(false);
    expect(screen.queryByText(/pause another agent to resume this one/)).toBeNull();
  });

  it('lists every scan with its outcome and cost, and opens one to its steps and answer (D50, D64)', async () => {
    await renderAgentTab('Scans');
    expect(await screen.findByText('Proposed')).toBeTruthy();
    expect(screen.getByText('No trade')).toBeTruthy();
    // D237: only the pass that never explained its idle cash says so.
    expect(screen.getAllByText("Didn't explain idle cash")).toHaveLength(1);
    expect(screen.getByText('Buy 2 NVDA')).toBeTruthy();
    expect(screen.getByText('$0.041 · 1 step')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Buy 2 NVDA/, expanded: false }));
    expect(await screen.findByText('NVDA trades at 237.14.')).toBeTruthy();
    expect(screen.getByText('Started from: cash $10,000.00, 0 holdings, 1 movers of the day')).toBeTruthy();
    expect(screen.getByText('NVDA moved; checking its quote.')).toBeTruthy();
    // A buy the mandate refused, sent back once (D170): the server's reason, marked English.
    const reason = screen.getByText('NVDA would be 2134.26 at cost, over the 10% position limit');
    expect(reason.getAttribute('lang')).toBe('en');
    expect(screen.getByText(/Sent back to the agent/)).toBeTruthy();
    expect(screen.getByText(/Looked up get_quote/)).toBeTruthy();
    expect(screen.getByText('The proposal').closest('a')?.getAttribute('href')).toBe('/proposals/p-1');
    // The final turn is the answer: read once, above; its raw JSON folded, not shown as prose.
    expect(screen.getAllByText('NVDA trades at 237.14.')).toHaveLength(1);
    expect(screen.getByText('Its raw answer')).toBeTruthy();
    expect(screen.getByText('Its answer the rules refused')).toBeTruthy();
  });

  it('shows each trade of a scan, the sell a buy needs, and why one was not proposed (D197)', async () => {
    const trade = SCAN_SUMMARY.trades[0]!;
    const several = {
      ...SCAN_SUMMARY,
      trades: [
        { ...trade, decision: 'sell' as const, symbol: 'MSFT', quantity: '1', thesis: 'MSFT is rich.', proposal: { id: 'p-2', state: 'approved' as const }, fillId: 'f-2' },
        { ...trade, fundedBy: ['MSFT'] },
        { ...trade, symbol: 'TSLA', quantity: '1', thesis: 'TSLA.', refused: true, problems: ['TSLA is not tradable'], proposal: null },
      ],
    };
    serve({
      [`/agents/${AGENT_ID}`]: AGENT,
      [`/agents/${AGENT_ID}/account`]: account(),
      [`/agents/${AGENT_ID}/activity`]: ACTIVITY,
      [`/agents/${AGENT_ID}/performance`]: PERFORMANCE,
      [`/agents/${AGENT_ID}/scans`]: { scans: [several], nextBefore: null },
      [`/agents/${AGENT_ID}/scans/${SCAN_ID}`]: { ...SCAN_DETAIL, ...several },
      '/proposals': { proposals: [] },
    });
    await renderAgentTab('Scans');
    // The row names the trades that became proposals, not the refused one.
    fireEvent.click(await screen.findByRole('button', { name: /Sell 1 MSFT · Buy 2 NVDA/, expanded: false }));
    expect(await screen.findByText('Paid for by selling MSFT: approve that first.')).toBeTruthy();
    expect(screen.getByText('Not proposed: TSLA is not tradable')).toBeTruthy();
    expect(screen.getAllByText('The proposal').map((link) => link.closest('a')?.getAttribute('href'))).toEqual([
      '/proposals/p-2',
      '/proposals/p-1',
    ]);
  });

  it.each(['scans', 'decisions'])("opens a trade proposal's scan from its Evidence checked link (?tab=%s)", async (tab) => {
    // `decisions` is the tab's old name, in links written before it was Scans.
    renderAgent(`/agents/${AGENT_ID}?tab=${tab}&scan=${SCAN_ID}`);
    expect(await screen.findByText('NVDA trades at 237.14.')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Scans', selected: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Buy 2 NVDA/, expanded: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: /No trade/, expanded: false })).toBeTruthy();
  });

  it('waits for a persona, and offers no scan until it has one (D52)', async () => {
    await renderAgentTab('Scans');
    expect(screen.getByText('Waiting for instructions or settings')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Run a scan now' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Give the agent instructions or settings first: it decides by them.')).toBeTruthy();
  });

  it('runs a scan, says what it proposed, and shows its expected cost (D65)', async () => {
    serveAgent({ ...AGENT, persona: 'Patient.', waitingForBrief: false });
    post.mockResolvedValueOnce({
      scan_id: SCAN_ID, outcome: 'trade', steps: 1, cost_micro_usd: 41_000, model: 'm', error: null,
      answer: { trades: [{ decision: 'buy', symbol: 'NVDA', quantity: '2', refused: false }] }, proposal_ids: ['p-1'],
    });
    await renderAgentTab('Scans');
    expect(await screen.findByText(/About \$0\.036 a scan \(measured on 7 Oct 2026/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Run a scan now' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/agents/${AGENT_ID}/scans`, {}));
    expect(await screen.findByText(/Proposed: Buy 2 NVDA\./)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Buy 2 NVDA' }).getAttribute('href')).toBe('/proposals/p-1');
  });

  it('waits for a scheduled scan that is running, and names one about to start (D195)', async () => {
    serveAgent({
      ...AGENT,
      persona: 'Patient.',
      waitingForBrief: false,
      runningScan: { trigger: 'schedule', startedAt: '2026-10-20T14:00:00Z' },
    });
    await renderAgentTab('Scans');
    expect(await screen.findByText('A scheduled scan is running now (since 17:00).')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Run a scan now' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    serveAgent({
      ...AGENT,
      persona: 'Patient.',
      waitingForBrief: false,
      scheduling: { enabled: true, nextAt: new Date(Date.now() + 12 * 60_000 - 1000).toISOString() },
    });
    await renderAgentTab('Scans');
    expect(await screen.findByText(/Next scheduled scan in 12 minutes \(\d\d:\d\d\)/)).toBeTruthy();
    // Shown, not blocked: the choice is the user's.
    expect((screen.getByRole('button', { name: 'Run a scan now' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('says why a scan was refused, in the reader\'s words', async () => {
    serveAgent({ ...AGENT, persona: 'Patient.', waitingForBrief: false });
    post.mockRejectedValueOnce(new ApiRequestError('busy', 409, 'scan_running'));
    await renderAgentTab('Scans');
    fireEvent.click(await screen.findByRole('button', { name: 'Run a scan now' }));
    expect(await screen.findByText('This agent is already scanning.')).toBeTruthy();
  });

  it('saves every N hours with the pre-open scan, showing the times in your zone, the count and the cost a day (D45, D195)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T08:00:00Z'));
    const patch = (await import('../src/api/client.ts')).api.patch as ReturnType<typeof vi.fn>;
    patch.mockResolvedValue(AGENT);
    await renderAgentTab('Settings');
    expect(await screen.findByText('On a trading day: 16:00, your time.')).toBeTruthy();
    expect(screen.getByText(/1 scan a trading day · about \$0\.036 a day\. Next scheduled scan: /)).toBeTruthy();
    expect(screen.getByText(/Spent today: \$0\.108 of \$0\.50/)).toBeTruthy();
    const hours = screen.getByLabelText('Hours between market-hours scans') as HTMLInputElement;
    expect(hours.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('During market hours,'));
    fireEvent.change(hours, { target: { value: '2' } });
    // New York 09:00 (pre-open), 10:00, 12:00, 14:00 is 16:00, 17:00, 19:00, 21:00 in Israel.
    expect(screen.getByText('On a trading day: 16:00, 17:00, 19:00, 21:00, your time.')).toBeTruthy();
    expect(screen.getByText(/4 scans a trading day · about \$0\.144 a day/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Model budget per day (USD)'), { target: { value: '1.25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save scan settings' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(`/agents/${AGENT_ID}`, {
        scanSchedule: { everyHours: 2, preOpen: true, postClose: false },
        maxDecisions: 1,
        llmBudget: '1.25',
      }),
    );
    vi.useRealTimers();
  });

  it('refuses hours outside 1 to 6, and says when nothing is scheduled at all (D195)', async () => {
    await renderAgentTab('Settings');
    fireEvent.click(await screen.findByLabelText('During market hours,'));
    fireEvent.change(screen.getByLabelText('Hours between market-hours scans'), { target: { value: '7' } });
    expect(screen.getByText('A whole number of hours, 1 to 6.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save scan settings' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('During market hours,'));
    fireEvent.click(screen.getByLabelText('Before the open'));
    expect(screen.getByText('No scheduled scans: it scans only when you press Run a scan now.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save scan settings' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('saves how many trades a scan may decide, and says what that asks of you (D197)', async () => {
    const patch = (await import('../src/api/client.ts')).api.patch as ReturnType<typeof vi.fn>;
    patch.mockResolvedValue(AGENT);
    serveAgent({ ...AGENT, mandate: { ...MANDATE, maxHoldings: 3 } });
    await renderAgentTab('Settings');
    const decisions = (await screen.findByLabelText('Decisions per scan, at most')) as HTMLInputElement;
    expect(decisions.value).toBe('1');
    fireEvent.change(decisions, { target: { value: '5' } });
    expect(screen.getByText(/5 means up to 5 messages at once\. It holds at most 3 instruments/)).toBeTruthy();
    fireEvent.change(decisions, { target: { value: '11' } });
    expect(screen.getByText('A whole number, 1 to 10.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save scan settings' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(decisions, { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save scan settings' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(`/agents/${AGENT_ID}`, expect.objectContaining({ maxDecisions: 4 })),
    );
  });

  it("suggests a long horizon's schedule and decisions together (D195, D197)", async () => {
    serveAgent({ ...AGENT, mandate: { ...MANDATE, horizon: 'long' }, scanSchedule: { everyHours: 2, preOpen: false, postClose: false } });
    await renderAgentTab('Settings');
    expect(await screen.findByText(/Long horizon: one scan before the open that looks at the whole portfolio/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use the suggestion' }));
    expect((screen.getByLabelText('Decisions per scan, at most') as HTMLInputElement).value).toBe('3');
    expect((screen.getByLabelText('Before the open') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('During market hours,') as HTMLInputElement).checked).toBe(false);
  });

  it("suggests a schedule from the agent's horizon, and applies it in one press (D195)", async () => {
    serveAgent({ ...AGENT, mandate: { ...MANDATE, horizon: 'short' } });
    await renderAgentTab('Settings');
    expect(await screen.findByText(/Short horizon: frequent scans, one decision each/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use the suggestion' }));
    expect((screen.getByLabelText('Hours between market-hours scans') as HTMLInputElement).value).toBe('2');
    expect((screen.getByLabelText('Before the open') as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByRole('button', { name: 'Use the suggestion' })).toBeNull();
  });

  it("says when this installation does not schedule scans (D71)", async () => {
    serveAgent({ ...AGENT, scheduling: { enabled: false, nextAt: null } });
    await renderAgentTab('Settings');
    expect(await screen.findByText(/Scheduled scans don't run on this installation/)).toBeTruthy();
  });

  it('saves an edited mandate, and says where the agent already stands over a limit (D168)', async () => {
    const patch = (await import('../src/api/client.ts')).api.patch as ReturnType<typeof vi.fn>;
    patch.mockResolvedValue(AGENT);
    const mandate = {
      riskLevel: 4,
      horizon: 'long' as const,
      thesisStyle: null,
      maxPositionBps: 1000,
      cashBufferBps: null,
      maxHoldings: null,
      allowEtfs: true,
      marketCaps: [],
      sectors: [],
      industries: [],
      etfCategories: [],
      blockedSymbols: [],
    };
    // AAPL at 1,672.90 of capital 9,998.32 (cash plus holdings at cost) is over a 10% limit.
    serveAgent({ ...AGENT, persona: 'Patient.', mandate });
    await renderAgentTab('Settings');
    expect(await screen.findByText(/Over its limits now: AAPL above the position limit/)).toBeTruthy();
    // A stored limit counts as typed: the slider proposes nothing over it.
    fireEvent.change(screen.getByLabelText('Risk appetite'), { target: { value: '8' } });
    expect((screen.getByLabelText('Max position (%)') as HTMLInputElement).value).toBe('10');
    fireEvent.change(screen.getByLabelText('Max position (%)'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        `/agents/${AGENT_ID}`,
        expect.objectContaining({
          persona: 'Patient.',
          mandate: expect.objectContaining({ riskLevel: 8, maxPositionBps: 2000, horizon: 'long' }),
        }),
      ),
    );
  });

  it("shows where the instructions contradict the settings, in the reader's words around the user's quote, and dismisses it (D178)", async () => {
    serveAgent({
      ...AGENT,
      persona: 'Day-trade momentum.',
      waitingForBrief: false,
      instructionsConflicts: [{ setting: 'horizon', quote: 'Day-trade momentum.' }],
    });
    await renderAgentTab('Settings');
    const warning = await screen.findByText(/Your instructions say/);
    // The quote's own full stop is dropped where it sits inside the sentence, never stored without it (D183).
    expect(warning.textContent).toBe('Your instructions say Day-trade momentum, which conflicts with the trading horizon.');
    // The user's words are a <q>: the browser quotes them, and they keep their own direction.
    const quote = warning.querySelector('q');
    expect(quote?.textContent).toBe('Day-trade momentum');
    expect(quote?.getAttribute('dir')).toBe('auto');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/agents/${AGENT_ID}/instructions-check/dismiss`));
  });

  it('checks edited instructions after a save, and says so when they fit', async () => {
    const patch = (await import('../src/api/client.ts')).api.patch as ReturnType<typeof vi.fn>;
    patch.mockResolvedValue(AGENT);
    post.mockResolvedValue({ status: 'checked', reason: null, conflicts: [] });
    serveAgent({ ...AGENT, persona: 'Patient.', waitingForBrief: false });
    await renderAgentTab('Settings');
    fireEvent.change(await screen.findByLabelText('Additional instructions'), { target: { value: 'Patient and picky.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/agents/${AGENT_ID}/instructions-check`));
    expect(await screen.findByText('Your instructions fit the settings.')).toBeTruthy();
  });
});
