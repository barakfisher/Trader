// @vitest-environment jsdom
/**
 * The consolidated holdings view (Stage 3, PR 6; D32-D35): the scope the
 * address carries, the headline's two figures that are never one, and the
 * per-agent split a row expands to.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';

import type { ConsolidatedHoldingsResponse, PortfolioSummary } from '@traders/shared';

const { ConsolidatedHeadline, ConsolidatedHoldings } = await import('../src/components/ConsolidatedHoldings.tsx');
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
  degraded: false,
  asOf: '2026-10-05T12:00:00Z',
};

function response(overrides: Partial<ConsolidatedHoldingsResponse> = {}): ConsolidatedHoldingsResponse {
  return {
    currency: 'USD',
    real: REAL,
    simulated: { agentCount: 2, cashMinor: 1400000, holdingsValueMinor: 100000, netWorthMinor: 1500000, unpricedSymbols: [] },
    agents: [],
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

afterEach(cleanup);

describe('the scope in the address', () => {
  it('is the real portfolio unless it names all or an agent, and drops anything else', () => {
    expect(holdingsScopeFrom({})).toEqual({ kind: 'real' });
    expect(holdingsScopeFrom({ holdings: 'all' })).toEqual({ kind: 'all' });
    expect(holdingsScopeFrom({ holdings: MOMENTUM.toUpperCase() })).toEqual({ kind: 'agent', agentId: MOMENTUM });
    expect(holdingsScopeFrom({ holdings: "'; drop table" })).toEqual({ kind: 'real' });
    expect(holdingsSearchValue({ kind: 'real' })).toBeUndefined();
    expect(holdingsSearchValue({ kind: 'agent', agentId: MOMENTUM })).toBe(MOMENTUM);
  });
});

describe('the headline under All (D34)', () => {
  it('shows real and simulated as two figures and never their sum', async () => {
    renderPage(<ConsolidatedHeadline data={response()} />);
    expect(await screen.findByText('$48,000.00')).toBeTruthy();
    expect(screen.getByText('$15,000.00')).toBeTruthy();
    expect(screen.getByText('2 agents · of which cash $14,000.00')).toBeTruthy();
    expect(screen.queryByText('$63,000.00')).toBeNull();
  });

  it('withholds the simulated figure when something is unpriced, and names it', async () => {
    renderPage(
      <ConsolidatedHeadline
        data={response({
          simulated: { agentCount: 1, cashMinor: 5000, holdingsValueMinor: null, netWorthMinor: null, unpricedSymbols: ['NOPE'] },
        })}
      />,
    );
    expect(await screen.findByText(/Not shown: NOPE could not be priced/)).toBeTruthy();
  });
});

describe('a consolidated row', () => {
  it('splits real and simulated, and expands to each holder with a paused agent badged', async () => {
    renderPage(<ConsolidatedHoldings data={response()} />);
    expect(await screen.findByText('NVDA')).toBeTruthy();
    expect(screen.getByText('40 sh')).toBeTruthy();
    expect(screen.getByText('5 sh')).toBeTruthy();
    expect(screen.queryByText('Momentum')).toBeNull();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    // The primary is named from the catalogue; the agent links to its page, where it trades.
    expect(screen.getByText('Main portfolio').closest('a')?.getAttribute('href')).toBe('/holdings/h-1');
    expect(screen.getByText('Momentum').closest('a')?.getAttribute('href')).toBe(`/agents/${MOMENTUM}`);
    expect(screen.getByText('Paused')).toBeTruthy();
  });
});

describe('pending trade proposals (D35, D63)', () => {
  it('badges a held ticker and lists the trade when the row expands', async () => {
    renderPage(<ConsolidatedHoldings data={response({ pendingTrades: [pendingTrade('p-1', 'NVDA')] })} />);
    expect(await screen.findByText('1 pending')).toBeTruthy();
    // Held, so not in the list above the table.
    expect(screen.queryByText(/waiting for you/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('Momentum proposes to buy 2 NVDA at $238.68')).toBeTruthy();
    expect(screen.getByText('Review').closest('a')?.getAttribute('href')).toBe('/proposals/p-1');
  });

  it('lists a trade on a ticker nobody holds above the table', async () => {
    renderPage(<ConsolidatedHoldings data={response({ pendingTrades: [pendingTrade('p-2', 'INTC')] })} />);
    expect(await screen.findByText('1 trade waiting for you')).toBeTruthy();
    expect(screen.getByText('Momentum proposes to buy 2 INTC at $238.68')).toBeTruthy();
    expect(screen.queryByText('1 pending')).toBeNull();
  });
});
