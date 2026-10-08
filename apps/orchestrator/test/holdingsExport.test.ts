/**
 * Export -> import round-trips (UX6): the file `holdingsExport` writes is read
 * by the import wizard's own parser back into the stored values - the same
 * quantity, the same integer cost per unit in the same currency, the same date
 * and notes. Run through the real importer, so a change to either side that
 * breaks the other fails here.
 */

import { describe, expect, it } from 'vitest';

import { holdingsExport, plainQuantity, type HoldingView } from '@traders/shared';

import { buildImportRows } from '../src/services/importer.js';
import { createFakeAi } from './fakeAi.js';

type Stored = Pick<HoldingView, 'instrument' | 'quantity' | 'costBasisMinor' | 'costCurrency' | 'openedAt' | 'notes'>;

const instrument = (symbol: string) =>
  ({ id: `i-${symbol}`, symbol, name: symbol, assetClass: 'equity', exchange: null, currency: 'USD' }) as HoldingView['instrument'];

/** As the database hands them over: `numeric(38, 18)` quantities, minor-unit costs. */
const STORED: Stored[] = [
  {
    instrument: instrument('AAPL'),
    quantity: '25.000000000000000000',
    costBasisMinor: 18540,
    costCurrency: 'USD',
    openedAt: '2026-01-15',
    notes: 'long term, "core"',
  },
  {
    instrument: instrument('BTC-USD'),
    quantity: '0.012345678900000000',
    costBasisMinor: null,
    costCurrency: 'USD',
    openedAt: null,
    notes: null,
  },
  // A cost in a currency with no minor unit: 15000 JPY is "15000", not "150.00".
  {
    instrument: instrument('VOO'),
    quantity: '3.500000000000000000',
    costBasisMinor: 15000,
    costCurrency: 'JPY',
    openedAt: null,
    notes: null,
  },
];

describe('holdings export', () => {
  it('re-imports to the stored values, through the import wizard\'s parser', async () => {
    const file = JSON.stringify(holdingsExport(STORED, new Date('2026-10-08T12:00:00Z')), null, 2);
    const rows = await buildImportRows({
      content: file,
      filename: 'traders-holdings-2026-10-08.json',
      defaultCurrency: 'USD',
      ai: createFakeAi(),
    });

    expect(rows.map((row) => row.status)).toEqual(['ok', 'ok', 'ok']);
    expect(
      rows.map((row) => ({
        symbol: row.symbol,
        quantity: row.quantity,
        costBasisMinor: row.costBasisMinor,
        currency: row.currency,
        openedAt: row.openedAt,
        notes: row.notes,
      })),
    ).toEqual(
      STORED.map((holding) => ({
        symbol: holding.instrument.symbol,
        quantity: plainQuantity(holding.quantity),
        costBasisMinor: holding.costBasisMinor,
        currency: holding.costCurrency,
        openedAt: holding.openedAt,
        notes: holding.notes,
      })),
    );
  });

  it('drops only trailing zeros from a quantity: the same number, as typed', () => {
    expect(plainQuantity('25.000000000000000000')).toBe('25');
    expect(plainQuantity('0.012345678900000000')).toBe('0.0123456789');
    expect(plainQuantity('100')).toBe('100');
    expect(plainQuantity('10.500')).toBe('10.5');
  });

  it('writes the cost from the stored integer, digit for digit', () => {
    const [aapl] = holdingsExport([{ ...STORED[0]!, costBasisMinor: 18541 }], new Date()).holdings;
    expect(aapl!.cost_basis).toBe('185.41');
  });
});
