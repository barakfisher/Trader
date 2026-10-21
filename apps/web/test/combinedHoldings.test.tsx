// @vitest-environment jsdom
/**
 * The dashboard's combined holdings (D229-D232): the scope the address
 * carries, the rows a scope adds up, who holds each one, the four cards and
 * their breakdown by source, cost basis that is missing rather than zero, and
 * an agent's trade approved from its row - never in one click.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';

import type { ConsolidatedHoldingsResponse, PortfolioSummary } from '@traders/shared';

const get = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>('../src/api/client.ts');
  return { ...actual, api: { get, post: vi.fn(), put: vi.fn(), delete: vi.fn(), postForm: vi.fn() } };
});

const { CombinedHoldingsTable } = await import('../src/components/CombinedHoldingsTable.tsx');
const { SummaryCards } = await import('../src/components/SummaryCards.tsx');
const { combinedHoldings, scopeSummary, summarySources } = await import('../src/lib/combinedHoldings.ts');
const { holdingsScopeFrom, holdingsSearchValue } = await import('../src/lib/holdingsScope.ts');
const { renderPage } = await import('./serverStateHarness.tsx');

const PRIMARY = '90000000-0000-0000-0000-000000000001';
const MOMENTUM = '90000000-0000-0000-0000-0000000000a1';

const REAL: PortfolioSummary = {
  baseCurrency: 'USD',
  totalValueMinor: 4800000,
  totalCostMinor: 4000000,
  pnlMinor: 800000,
  pnlPct: 20,
  dayChangeMinor: null,
  dayChangePct: null,
  holdingsCount: 10,
  pricedCount: 10,
  unpricedSymbols: [],
  uncostedSymbols: [],
  degraded: false,
  asOf: '2026-10-05T12:00:00Z',
};

const MOMENTUM_SUMMARY: PortfolioSummary = {
  ...REAL,
  totalValueMinor: 100000,
  totalCostMinor: 95000,
  pnlMinor: 5000,
  pnlPct: 5.2632,
  dayChangeMinor: 2000,
  dayChangePct: 2.0408,
  holdingsCount: 1,
  pricedCount: 1,
};

function response(overrides: Partial<ConsolidatedHoldingsResponse> = {}): ConsolidatedHoldingsResponse {
  return {
    currency: 'USD',
    real: REAL,
    simulated: {
      agentCount: 1,
      cashMinor: 1400000,
      holdingsValueMinor: 100000,
      netWorthMinor: 1500000,
      unpricedSymbols: [],
      summary: MOMENTUM_SUMMARY,
    },
    agents: [
      {
        agentId: MOMENTUM,
        name: 'Momentum',
        state: 'paused',
        currency: 'USD',
        cashMinor: 1400000,
        depositsMinor: 1500000,
        holdingsValueMinor: 100000,
        netWorthMinor: 1500000,
        pnlMinor: 0,
        pnlPct: 0,
        unpricedSymbols: [],
        summary: MOMENTUM_SUMMARY,
      },
    ],
    rows: [
      {
        instrument: { id: 'i-NVDA', symbol: 'NVDA', name: 'NVIDIA', assetClass: 'equity', exchange: 'NMS', currency: 'USD' },
        quote: null,
        real: { quantity: '40.000000000000000000', valueMinor: 800000 },
        simulated: { quantity: '5.000000000000000000', valueMinor: 100000 },
        positions: [
          {
            agentId: PRIMARY, agentName: 'Main portfolio', isPrimary: true, state: 'active', holdingId: 'h-1',
            quantity: '40.000000000000000000', costBasisMinor: 15000, costCurrency: 'USD',
            valueMinor: 800000, costMinor: 600000, pnlMinor: 200000, pnlPct: 33.3,
          },
          {
            agentId: MOMENTUM, agentName: 'Momentum', isPrimary: false, state: 'paused', holdingId: 'h-2',
            quantity: '5.000000000000000000', costBasisMinor: 19000, costCurrency: 'USD',
            valueMinor: 100000, costMinor: 95000, pnlMinor: 5000, pnlPct: 5.26,
          },
        ],
      },
    ],
    pendingTrades: [],
    ...overrides,
  };
}

const pendingTrade = (proposalId: string, symbol: string) => ({
  proposalId,
  agentId: MOMENTUM,
  agentName: 'Momentum',
  side: 'buy' as const,
  symbol,
  quantity: '2',
  agentPriceMinor: 23868,
  currency: 'USD',
  expiresAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
});

beforeEach(() => {
  vi.clearAllMocks();
  // Nothing in these tests needs a server answer; a pending read is a spinner.
  get.mockImplementation(() => new Promise(() => {}));
});
afterEach(cleanup);

const ALL = { kind: 'all' } as const;

describe('the scope in the address (D229)', () => {
  it('is everything unless it names real, simulated or an agent, and drops anything else', () => {
    expect(holdingsScopeFrom({})).toEqual({ kind: 'all' });
    // A link made before D229 still opens the same view.
    expect(holdingsScopeFrom({ holdings: 'all' })).toEqual({ kind: 'all' });
    expect(holdingsScopeFrom({ holdings: 'real' })).toEqual({ kind: 'real' });
    expect(holdingsScopeFrom({ holdings: 'simulated' })).toEqual({ kind: 'simulated' });
    expect(holdingsScopeFrom({ holdings: MOMENTUM.toUpperCase() })).toEqual({ kind: 'agent', agentId: MOMENTUM });
    expect(holdingsScopeFrom({ holdings: "'; drop table" })).toEqual({ kind: 'all' });
    expect(holdingsSearchValue({ kind: 'all' })).toBeUndefined();
    expect(holdingsSearchValue({ kind: 'real' })).toBe('real');
    expect(holdingsSearchValue({ kind: 'agent', agentId: MOMENTUM })).toBe(MOMENTUM);
  });
});

describe('the rows a scope adds up', () => {
  it('adds every holder under All, and keeps each position', () => {
    const [row] = combinedHoldings(response(), ALL).rows;
    expect(row!.quantity).toBe('45.000000000000000000');
    expect(row!.valueMinor).toBe(900000);
    expect(row!.costMinor).toBe(695000);
    expect(row!.pnlMinor).toBe(205000);
    expect(row!.weightPct).toBe(100);
    expect(row!.positions).toHaveLength(2);
  });

  it('keeps only the scope\'s positions, and drops a row nobody in it holds', () => {
    expect(combinedHoldings(response(), { kind: 'real' }).rows[0]!.valueMinor).toBe(800000);
    expect(combinedHoldings(response(), { kind: 'agent', agentId: MOMENTUM }).rows[0]!.quantity).toBe(
      '5.000000000000000000',
    );
    expect(combinedHoldings(response(), { kind: 'agent', agentId: PRIMARY }).rows).toEqual([]);
  });

  it('measures P&L only where there is a cost basis, and flags the row (D230)', () => {
    const data = response();
    const real = data.rows[0]!.positions[0]!;
    data.rows[0]!.positions[0] = { ...real, costBasisMinor: null, costMinor: null, pnlMinor: null, pnlPct: null };
    const [row] = combinedHoldings(data, ALL).rows;
    expect(row!.uncosted).toBe(true);
    // The agent's 5 shares alone: never the real 40 shares' whole value as profit.
    expect(row!.costMinor).toBe(95000);
    expect(row!.pnlMinor).toBe(5000);
    expect(combinedHoldings(data, { kind: 'real' }).rows[0]!.pnlMinor).toBeNull();
  });
});

describe('the cards\' figures (D231)', () => {
  it('add the real portfolio and every agent under All, and only the agents under Simulated', () => {
    const data = response();
    const all = scopeSummary(data, summarySources(data, ALL));
    expect(all.totalValueMinor).toBe(4900000);
    expect(all.totalCostMinor).toBe(4095000);
    expect(all.pnlMinor).toBe(805000);
    // Real has no day change on record; the agent's alone is the change.
    expect(all.dayChangeMinor).toBe(2000);
    expect(scopeSummary(data, summarySources(data, { kind: 'simulated' }))).toEqual(MOMENTUM_SUMMARY);
  });
});

describe('the holdings table', () => {
  it('badges each holder and links it where its position is managed', async () => {
    renderPage(<CombinedHoldingsTable data={response()} scope={ALL} />);
    const holders = await screen.findByRole('list', { name: 'Holders' });
    expect(within(holders).getByText('Real').closest('a')?.getAttribute('href')).toBe('/holdings/h-1');
    expect(within(holders).getByText('Momentum').closest('a')?.getAttribute('href')).toBe(`/agents/${MOMENTUM}`);
    expect(within(holders).getByText(/Paused/)).toBeTruthy();
  });

  it('opens the split by holder from the quantity', async () => {
    renderPage(<CombinedHoldingsTable data={response()} scope={ALL} />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Breakdown of NVDA by holder' }))[0]!);
    const tooltip = screen.getByRole('tooltip');
    expect(within(tooltip).getByText('$8,000.00 (40 units)')).toBeTruthy();
    expect(within(tooltip).getByText('$1,000.00 (5 units)')).toBeTruthy();
    expect(within(tooltip).getByText('$9,000.00 (45 units)')).toBeTruthy();
  });

  it('asks for a cost basis instead of showing a profit (D230)', async () => {
    const data = response();
    const real = data.rows[0]!.positions[0]!;
    data.rows[0]!.positions = [{ ...real, costBasisMinor: null, costMinor: null, pnlMinor: null, pnlPct: null }];
    renderPage(<CombinedHoldingsTable data={data} scope={{ kind: 'real' }} />);
    expect(await screen.findByText('Set cost basis')).toBeTruthy();
    expect(screen.queryByText(/\$8,000\.00 \(/)).toBeNull();
  });
});

describe('an agent\'s pending trade (D232)', () => {
  it('is approved from its row through the proposal\'s own card, not in one click', async () => {
    renderPage(<CombinedHoldingsTable data={response({ pendingTrades: [pendingTrade('p-1', 'NVDA')] })} scope={ALL} />);
    expect(await screen.findByText('1 pending')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review and approve: Momentum proposes to buy NVDA' }));
    const drawer = screen.getByRole('dialog', { name: 'Approve a trade' });
    expect(within(drawer).getByText('Loading the proposal…')).toBeTruthy();
    expect(get).toHaveBeenCalledWith('/proposals/p-1');
  });

  it('lists a trade on a ticker nobody holds under the table, with its Approve', async () => {
    renderPage(<CombinedHoldingsTable data={response({ pendingTrades: [pendingTrade('p-2', 'INTC')] })} scope={ALL} />);
    expect(await screen.findByText('1 trade waiting for you')).toBeTruthy();
    expect(screen.getByText(/Momentum proposes to buy 2 INTC at \$238\.68/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review and approve: Momentum proposes to buy INTC' })).toBeTruthy();
    expect(screen.queryByText('1 pending')).toBeNull();
  });

  it('is not shown under Real only', () => {
    expect(combinedHoldings(response({ pendingTrades: [pendingTrade('p-1', 'NVDA')] }), { kind: 'real' }).rows[0]!.pending).toEqual([]);
  });
});

describe('the four cards', () => {
  it('open the breakdown by source and the waiting trades when they add sources', async () => {
    const data = response({ pendingTrades: [pendingTrade('p-1', 'NVDA')] });
    const sources = summarySources(data, ALL);
    renderPage(<SummaryCards summary={scopeSummary(data, sources)} sources={sources} pendingTrades={data.pendingTrades} />);
    fireEvent.click(await screen.findByRole('button', { name: /Total value/ }));
    const drawer = screen.getByRole('dialog', { name: 'Breakdown by source' });
    expect(within(drawer).getByText('Main portfolio')).toBeTruthy();
    expect(within(drawer).getByText('Momentum')).toBeTruthy();
    expect(within(drawer).getByText('Combined')).toBeTruthy();
    expect(within(drawer).getAllByText('$49,000.00').length).toBeGreaterThan(0);
    expect(within(drawer).getByText('Uninvested paper cash: $14,000.00')).toBeTruthy();
    expect(within(drawer).getByText(/Momentum proposes to buy 2 NVDA/)).toBeTruthy();
  });

  it('are plain figures for one source with nothing waiting', async () => {
    renderPage(<SummaryCards summary={REAL} />);
    expect(await screen.findByText('$48,000.00')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Total value/ })).toBeNull();
  });

  it('show P&L as missing, and say why, when nothing has a cost basis (D230)', async () => {
    renderPage(
      <SummaryCards summary={{ ...REAL, totalCostMinor: 0, pnlMinor: null, pnlPct: null, uncostedSymbols: ['AAPL'] }} />,
    );
    expect(await screen.findByText('1 holding without cost basis')).toBeTruthy();
    expect(screen.getByText('AAPL')).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});
