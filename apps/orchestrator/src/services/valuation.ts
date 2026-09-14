/**
 * Portfolio valuation.
 *
 * Rules that matter here:
 *  - Money arithmetic happens in integer minor units and rounds exactly once.
 *  - A holding nobody can price gets `valueMinor: null` and is listed in
 *    `summary.unpricedSymbols`. It is never valued at zero and never hidden -
 *    a silently missing position is worse than a visibly missing price.
 *  - Cost basis is stored per unit; total cost is quantity x per-unit cost.
 */

import { AiClient, type Quote } from '@traders/shared/ai';
import {
  convertMinor,
  scaleMinor,
  type AllocationSlice,
  type AssetClass,
  type HoldingView,
  type PortfolioResponse,
  type PortfolioSummary,
} from '@traders/shared';

import type { HoldingRow } from '../db/queries.js';
import { logger } from '../logger.js';

const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  equity: 'Stocks',
  etf: 'ETFs',
  crypto: 'Crypto',
  fx: 'FX',
  index: 'Indices',
  unknown: 'Unclassified',
};

export interface ValuationContext {
  baseCurrency: string;
  ai: AiClient;
  requestId?: string;
}

interface PricedHolding {
  row: HoldingRow;
  quote: Quote | null;
  fxRate: string | null;
  valueMinor: number | null;
  costMinor: number | null;
  previousValueMinor: number | null;
}

/** Fetch every FX rate the valuation needs, once per currency pair. */
async function loadFxRates(
  currencies: Set<string>,
  context: ValuationContext,
): Promise<Map<string, string>> {
  const base = context.baseCurrency.toUpperCase();
  const rates = new Map<string, string>([[base, '1']]);
  await Promise.all(
    [...currencies]
      .map((currency) => currency.toUpperCase())
      .filter((currency) => currency !== base)
      .map(async (currency) => {
        try {
          const rate = await context.ai.fxRate(currency, base, context.requestId);
          rates.set(currency, rate.rate);
        } catch (error) {
          // A missing rate must not zero out a position: leave it unset and let
          // the caller mark the holding unpriced.
          logger().warn({ currency, base, err: error }, 'fx rate unavailable');
        }
      }),
  );
  return rates;
}

export async function valuePortfolio(
  rows: HoldingRow[],
  context: ValuationContext,
): Promise<PortfolioResponse> {
  const base = context.baseCurrency.toUpperCase();
  const asOf = new Date().toISOString();

  if (rows.length === 0) {
    return {
      summary: emptySummary(base, asOf),
      holdings: [],
      allocationByInstrument: [],
      allocationByAssetClass: [],
    };
  }

  const symbols = [...new Set(rows.map((row) => row.symbol.toUpperCase()))];
  let quotes = new Map<string, Quote>();
  let missing: string[] = [];
  try {
    const response = await context.ai.quotes(symbols, context.requestId);
    quotes = new Map(response.quotes.map((quote) => [quote.symbol.toUpperCase(), quote]));
    missing = response.missing ?? [];
  } catch (error) {
    // Total AI-service failure degrades to an unpriced portfolio rather than an
    // error page: the user still sees their holdings and cost basis.
    logger().error({ err: error }, 'quote fetch failed; serving unpriced portfolio');
    missing = symbols;
  }

  const currencies = new Set<string>();
  rows.forEach((row) => currencies.add(row.currency));
  quotes.forEach((quote) => currencies.add(quote.currency));
  const fxRates = await loadFxRates(currencies, context);

  const priced: PricedHolding[] = rows.map((row) => {
    const quote = quotes.get(row.symbol.toUpperCase()) ?? null;
    const quoteCurrency = quote?.currency?.toUpperCase() ?? null;
    const quoteRate = quoteCurrency ? fxRates.get(quoteCurrency) : undefined;

    let valueMinor: number | null = null;
    let previousValueMinor: number | null = null;
    if (quote && quoteCurrency && quoteRate) {
      const positionMinor = scaleMinor(quote.price_minor, row.quantity);
      valueMinor = convertMinor(positionMinor, quoteCurrency, base, quoteRate);
      if (quote.previous_close_minor) {
        previousValueMinor = convertMinor(
          scaleMinor(quote.previous_close_minor, row.quantity),
          quoteCurrency,
          base,
          quoteRate,
        );
      }
    }

    const costCurrency = row.currency.toUpperCase();
    const costRate = fxRates.get(costCurrency);
    const perUnitCostMinor = row.cost_basis_minor === null ? null : Number(row.cost_basis_minor);
    const costMinor =
      perUnitCostMinor !== null && costRate
        ? convertMinor(scaleMinor(perUnitCostMinor, row.quantity), costCurrency, base, costRate)
        : null;

    return {
      row,
      quote,
      fxRate: quoteCurrency ? (fxRates.get(quoteCurrency) ?? null) : null,
      valueMinor,
      costMinor,
      previousValueMinor,
    };
  });

  const totalValueMinor = priced.reduce((sum, item) => sum + (item.valueMinor ?? 0), 0);
  const totalCostMinor = priced.reduce((sum, item) => sum + (item.costMinor ?? 0), 0);
  const totalPreviousMinor = priced.reduce(
    (sum, item) => sum + (item.previousValueMinor ?? item.valueMinor ?? 0),
    0,
  );

  const holdings: HoldingView[] = priced.map((item) => {
    const weightPct =
      item.valueMinor !== null && totalValueMinor > 0
        ? round((item.valueMinor / totalValueMinor) * 100, 4)
        : null;
    const pnlMinor =
      item.valueMinor !== null && item.costMinor !== null ? item.valueMinor - item.costMinor : null;
    return {
      id: item.row.id,
      instrument: {
        id: item.row.instrument_id,
        symbol: item.row.symbol,
        name: item.row.name,
        assetClass: item.row.asset_class,
        exchange: item.row.exchange,
        currency: item.row.instrument_currency,
      },
      quantity: item.row.quantity,
      costBasisMinor: item.row.cost_basis_minor === null ? null : Number(item.row.cost_basis_minor),
      costCurrency: item.row.currency,
      openedAt: item.row.opened_at ? toDateString(item.row.opened_at) : null,
      notes: item.row.notes,
      quote: item.quote
        ? {
            priceMinor: item.quote.price_minor,
            currency: item.quote.currency,
            asOf: item.quote.as_of,
            source: item.quote.source,
            delaySeconds: item.quote.delay_seconds ?? 0,
            dayChangePct: item.quote.day_change_pct ?? null,
            stale: item.quote.stale ?? false,
          }
        : null,
      valueMinor: item.valueMinor,
      costMinor: item.costMinor,
      pnlMinor,
      pnlPct:
        pnlMinor !== null && item.costMinor && item.costMinor > 0
          ? round((pnlMinor / item.costMinor) * 100, 4)
          : null,
      weightPct,
      fxRate: item.fxRate,
    };
  });

  const unpricedSymbols = priced
    .filter((item) => item.valueMinor === null)
    .map((item) => item.row.symbol);
  const anyStale = priced.some((item) => item.quote?.stale);

  const pnlMinor = totalValueMinor - totalCostMinor;
  const dayChangeMinor = totalPreviousMinor > 0 ? totalValueMinor - totalPreviousMinor : null;

  const summary: PortfolioSummary = {
    baseCurrency: base,
    totalValueMinor,
    totalCostMinor,
    pnlMinor,
    pnlPct: totalCostMinor > 0 ? round((pnlMinor / totalCostMinor) * 100, 4) : null,
    dayChangeMinor,
    dayChangePct:
      dayChangeMinor !== null && totalPreviousMinor > 0
        ? round((dayChangeMinor / totalPreviousMinor) * 100, 4)
        : null,
    holdingsCount: rows.length,
    pricedCount: rows.length - unpricedSymbols.length,
    unpricedSymbols: [...new Set([...unpricedSymbols, ...missing])].sort(),
    degraded: unpricedSymbols.length > 0 || anyStale,
    asOf,
  };

  return {
    summary,
    holdings,
    allocationByInstrument: allocationByInstrument(holdings, totalValueMinor),
    allocationByAssetClass: allocationByAssetClass(holdings, totalValueMinor),
  };
}

function allocationByInstrument(
  holdings: HoldingView[],
  totalValueMinor: number,
): AllocationSlice[] {
  return holdings
    .filter((holding) => holding.valueMinor !== null && holding.valueMinor > 0)
    .map((holding) => ({
      key: holding.instrument.symbol,
      label: holding.instrument.symbol,
      valueMinor: holding.valueMinor as number,
      weightPct: totalValueMinor > 0 ? round(((holding.valueMinor as number) / totalValueMinor) * 100, 4) : 0,
    }))
    .sort((a, b) => b.valueMinor - a.valueMinor);
}

function allocationByAssetClass(
  holdings: HoldingView[],
  totalValueMinor: number,
): AllocationSlice[] {
  const buckets = new Map<AssetClass, number>();
  holdings.forEach((holding) => {
    if (holding.valueMinor === null) return;
    const current = buckets.get(holding.instrument.assetClass) ?? 0;
    buckets.set(holding.instrument.assetClass, current + holding.valueMinor);
  });
  return [...buckets.entries()]
    .map(([assetClass, valueMinor]) => ({
      key: assetClass,
      label: ASSET_CLASS_LABELS[assetClass],
      valueMinor,
      weightPct: totalValueMinor > 0 ? round((valueMinor / totalValueMinor) * 100, 4) : 0,
    }))
    .sort((a, b) => b.valueMinor - a.valueMinor);
}

function emptySummary(baseCurrency: string, asOf: string): PortfolioSummary {
  return {
    baseCurrency,
    totalValueMinor: 0,
    totalCostMinor: 0,
    pnlMinor: 0,
    pnlPct: null,
    dayChangeMinor: null,
    dayChangePct: null,
    holdingsCount: 0,
    pricedCount: 0,
    unpricedSymbols: [],
    degraded: false,
    asOf,
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function toDateString(value: Date | string): string {
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}
