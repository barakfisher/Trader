import { describe, expect, it } from 'vitest';

import type { HoldingRow } from '../src/db/queries.js';
import { valuePortfolio } from '../src/services/valuation.js';
import { createFakeAi } from './fakeAi.js';

function holding(overrides: Partial<HoldingRow> & { symbol: string; quantity: string }): HoldingRow {
  return {
    id: `id-${overrides.symbol}`,
    user_id: 'user-1',
    instrument_id: `inst-${overrides.symbol}`,
    cost_basis_minor: null,
    currency: 'USD',
    opened_at: null,
    notes: null,
    name: overrides.symbol,
    asset_class: 'equity',
    exchange: 'TEST',
    instrument_currency: 'USD',
    ...overrides,
  } as HoldingRow;
}

describe('valuePortfolio', () => {
  const context = { baseCurrency: 'USD', ai: createFakeAi() };

  it('values a single holding from per-unit cost basis', async () => {
    const result = await valuePortfolio(
      [holding({ symbol: 'AAPL', quantity: '10', cost_basis_minor: '18540' })],
      context,
    );
    // 10 shares at 232.14 = 2321.40; cost 10 x 185.40 = 1854.00
    expect(result.summary.totalValueMinor).toBe(232140);
    expect(result.summary.totalCostMinor).toBe(185400);
    expect(result.summary.pnlMinor).toBe(46740);
    expect(result.summary.pnlPct).toBeCloseTo(25.2104, 3);
    expect(result.holdings[0]!.weightPct).toBe(100);
  });

  it('handles fractional crypto quantities without drift', async () => {
    const result = await valuePortfolio(
      [holding({ symbol: 'BTC-USD', quantity: '0.42', cost_basis_minor: '4125000', asset_class: 'crypto' })],
      context,
    );
    // 0.42 x 58412.33 = 24533.1786 -> 2453318 minor units (rounded once)
    expect(result.summary.totalValueMinor).toBe(2453318);
    expect(result.summary.totalCostMinor).toBe(1732500);
  });

  it('converts a non-USD holding into the base currency', async () => {
    const result = await valuePortfolio(
      [
        holding({
          symbol: 'SAP.DE',
          quantity: '20',
          cost_basis_minor: '17230',
          currency: 'EUR',
          instrument_currency: 'EUR',
        }),
      ],
      context,
    );
    // 20 x 196.40 EUR = 3928 EUR -> x 1.1043 = 4337.69 USD
    expect(result.summary.totalValueMinor).toBe(433769);
    expect(result.holdings[0]!.fxRate).toBe('1.1043');
    expect(result.summary.baseCurrency).toBe('USD');
  });

  it('reports an unpriceable holding instead of valuing it at zero', async () => {
    const ai = createFakeAi({ unpriceable: ['VOO'] });
    const result = await valuePortfolio(
      [
        holding({ symbol: 'AAPL', quantity: '10' }),
        holding({ symbol: 'VOO', quantity: '5', asset_class: 'etf' }),
      ],
      { baseCurrency: 'USD', ai },
    );
    const voo = result.holdings.find((h) => h.instrument.symbol === 'VOO')!;
    expect(voo.valueMinor).toBeNull();
    expect(voo.weightPct).toBeNull();
    expect(result.summary.unpricedSymbols).toEqual(['VOO']);
    expect(result.summary.pricedCount).toBe(1);
    expect(result.summary.degraded).toBe(true);
    // The priced holding still counts for 100% of the *known* value.
    expect(result.summary.totalValueMinor).toBe(232140);
  });

  it('marks a holding unpriced when its FX rate is unavailable', async () => {
    const ai = createFakeAi({ missingFx: ['EURUSD'] });
    const result = await valuePortfolio(
      [holding({ symbol: 'SAP.DE', quantity: '20', currency: 'EUR', instrument_currency: 'EUR' })],
      { baseCurrency: 'USD', ai },
    );
    expect(result.holdings[0]!.valueMinor).toBeNull();
    expect(result.summary.degraded).toBe(true);
  });

  it('groups allocation by asset class', async () => {
    const result = await valuePortfolio(
      [
        holding({ symbol: 'AAPL', quantity: '10' }),
        holding({ symbol: 'VOO', quantity: '5', asset_class: 'etf' }),
        holding({ symbol: 'BTC-USD', quantity: '0.1', asset_class: 'crypto' }),
      ],
      context,
    );
    // Sorted by value: 0.1 BTC (5841.23) > 5 VOO (2560.40) > 10 AAPL (2321.40).
    expect(result.allocationByAssetClass.map((slice) => slice.key)).toEqual(['crypto', 'etf', 'equity']);
    const total = result.allocationByAssetClass.reduce((sum, slice) => sum + slice.weightPct, 0);
    expect(total).toBeCloseTo(100, 2);
  });

  it('returns an empty summary for an empty portfolio without calling the AI service', async () => {
    const result = await valuePortfolio([], {
      baseCurrency: 'USD',
      ai: { quotes: () => Promise.reject(new Error('must not be called')) } as never,
    });
    expect(result.summary.holdingsCount).toBe(0);
    expect(result.holdings).toEqual([]);
  });

  it('degrades to an unpriced portfolio when the AI service is down', async () => {
    const ai = { quotes: () => Promise.reject(new Error('connection refused')), fxRate: async () => ({ base: 'USD', quote: 'USD', rate: '1', as_of: '', source: 'fake' }) } as never;
    const result = await valuePortfolio([holding({ symbol: 'AAPL', quantity: '10' })], {
      baseCurrency: 'USD',
      ai,
    });
    expect(result.summary.unpricedSymbols).toEqual(['AAPL']);
    expect(result.holdings).toHaveLength(1);
  });

  it("sends each holding's asset class and exchange with the quote request", async () => {
    // Without them the AI service judges SAP.DE by New York hours and spots
    // crypto only by a `-USD` suffix; the instruments table already knows both.
    let sent: unknown;
    const ai = {
      quotes: async (_symbols: string[], _requestId?: string, markets?: unknown) => {
        sent = markets;
        return { quotes: [], missing: [] };
      },
      fxRate: async () => ({ base: 'EUR', quote: 'USD', rate: '1.1', as_of: '', source: 'fake' }),
    } as never;
    await valuePortfolio(
      [
        holding({ symbol: 'sap.de', quantity: '1', exchange: 'XETRA', currency: 'EUR' }),
        holding({ symbol: 'BTC-USD', quantity: '1', asset_class: 'crypto', exchange: 'CCC' }),
      ],
      { baseCurrency: 'USD', ai },
    );
    expect(sent).toEqual({
      'SAP.DE': { asset_class: 'equity', exchange: 'XETRA' },
      'BTC-USD': { asset_class: 'crypto', exchange: 'CCC' },
    });
  });
});
