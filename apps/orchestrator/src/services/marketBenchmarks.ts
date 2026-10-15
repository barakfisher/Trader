/**
 * The indices a holding's move is set beside (decision 149).
 *
 * The move rules judge each holding alone, so on a red day every high-beta
 * holding alerts and none of the alerts says the market fell too. The scan
 * hands these instruments to the AI service, which picks, per holding, the one
 * whose daily returns have tracked it best and adds what it did that day to the
 * move's evidence. A crypto pair is set beside Bitcoin only, and an equity
 * beside the three US indices only.
 *
 * Measured before it was built (2026-10-15, 136 replayed alerts on the real
 * portfolio): SPY alone would have understated the day for this portfolio -
 * on 2026-10-14 SPY fell 1.08% while QQQ and IWM fell about 2% - so the choice
 * is by fit, not one index for everything.
 *
 * Their prices have to be where the scan reads them, on the same days as the
 * holdings'. The hourly backfill stores their daily closes; `recordBenchmarkQuotes`
 * stores a live quote on every scan, because a holding's move is often measured
 * on an intraday price, and a benchmark with no price that day is not mentioned.
 */

import type { AiClient } from '@traders/shared/ai';

import { findInstrumentsBySymbols, recordQuotes, type InstrumentRow } from '../db/queries.js';
import { logger } from '../logger.js';
import { marketsOf } from './valuation.js';

/** S&P 500, Nasdaq-100, Russell 2000, and Bitcoin for crypto pairs. */
export const MARKET_BENCHMARK_SYMBOLS = ['SPY', 'QQQ', 'IWM', 'BTC-USD'] as const;

export type MarketBenchmarkSymbol = (typeof MARKET_BENCHMARK_SYMBOLS)[number];

export function isMarketBenchmark(symbol: unknown): symbol is MarketBenchmarkSymbol {
  return (MARKET_BENCHMARK_SYMBOLS as readonly unknown[]).includes(symbol);
}

/**
 * The benchmark instruments, with a live quote recorded for each.
 *
 * A failed quote fetch costs the market line for an intraday move and nothing
 * else: the benchmarks are still returned, so a move measured on closes is still
 * set beside the market's close. A benchmark missing from `instruments` is
 * simply not offered.
 */
export async function recordBenchmarkQuotes(ai: AiClient, requestId?: string): Promise<InstrumentRow[]> {
  const instruments = await findInstrumentsBySymbols([...MARKET_BENCHMARK_SYMBOLS]);
  if (instruments.length === 0) return [];
  try {
    const response = await ai.quotes(
      instruments.map((row) => row.symbol),
      requestId,
      marketsOf(instruments),
    );
    const bySymbol = new Map(instruments.map((row) => [row.symbol.toUpperCase(), row]));
    await recordQuotes(
      response.quotes.flatMap((quote) => {
        const instrument = bySymbol.get(quote.symbol.toUpperCase());
        // A stale quote is an old observation; the backfill already holds it.
        if (instrument === undefined || quote.stale === true) return [];
        return [
          {
            instrumentId: instrument.id,
            asOf: quote.as_of,
            priceMinor: quote.price_minor,
            currency: quote.currency,
            source: quote.source,
            delaySeconds: quote.delay_seconds ?? 0,
          },
        ];
      }),
    );
  } catch (error) {
    logger().warn({ err: error }, 'benchmark quotes not recorded; market line uses stored closes only');
  }
  return instruments;
}
