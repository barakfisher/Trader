/**
 * The holdings as a file the import wizard reads back (UX6).
 *
 * The shape is the importer's, not a new one: `{ holdings: [...] }` with its
 * canonical field names (`apps/orchestrator/src/services/importer.ts`), so an
 * export re-imports with no mapping. The extra top-level keys say what the file
 * is; the importer ignores keys it does not know.
 *
 * Built from the stored values, never the displayed ones:
 * - `quantity` is the stored decimal string, only its trailing zeros dropped
 *   (`numeric(38, 18)` prints `25.000000000000000000`) - the same number.
 * - `cost_basis` is the stored cost **per unit**, per holding, as the importer
 *   reads it: a decimal at the currency's exponent, from the integer minor
 *   units by `minorToDecimalString` - exact, so `parseToMinor` reads back the
 *   same integer. Not minor units on the wire: the importer reads a decimal,
 *   and a second spelling of the same figure would be one more thing to
 *   disagree. Never the formatted, rounded figure the table shows.
 * - `currency` is the cost's currency, which is what the importer applies it to.
 */

import { minorToDecimalString } from './money.js';
import type { HoldingView } from './types.js';

export const HOLDINGS_EXPORT_FORMAT = 'traders.holdings';
export const HOLDINGS_EXPORT_VERSION = 1;

export interface ExportedHolding {
  symbol: string;
  quantity: string;
  /** Per unit, in `currency`; absent when no cost was recorded. */
  cost_basis?: string;
  currency: string;
  /** YYYY-MM-DD. */
  opened_at?: string;
  notes?: string;
}

export interface HoldingsExport {
  format: typeof HOLDINGS_EXPORT_FORMAT;
  version: typeof HOLDINGS_EXPORT_VERSION;
  exportedAt: string;
  holdings: ExportedHolding[];
}

/** `"25.000000000000000000"` -> `"25"`, `"0.125000"` -> `"0.125"`: the same number, as typed. */
export function plainQuantity(quantity: string): string {
  return quantity.includes('.') ? quantity.replace(/0+$/, '').replace(/\.$/, '') : quantity;
}

type ExportableHolding = Pick<
  HoldingView,
  'instrument' | 'quantity' | 'costBasisMinor' | 'costCurrency' | 'openedAt' | 'notes'
>;

export function holdingsExport(holdings: ExportableHolding[], exportedAt: Date): HoldingsExport {
  return {
    format: HOLDINGS_EXPORT_FORMAT,
    version: HOLDINGS_EXPORT_VERSION,
    exportedAt: exportedAt.toISOString(),
    holdings: holdings.map((holding) => ({
      symbol: holding.instrument.symbol,
      quantity: plainQuantity(holding.quantity),
      ...(holding.costBasisMinor === null
        ? {}
        : { cost_basis: minorToDecimalString(holding.costBasisMinor, holding.costCurrency) }),
      currency: holding.costCurrency,
      ...(holding.openedAt ? { opened_at: holding.openedAt.slice(0, 10) } : {}),
      ...(holding.notes ? { notes: holding.notes } : {}),
    })),
  };
}
