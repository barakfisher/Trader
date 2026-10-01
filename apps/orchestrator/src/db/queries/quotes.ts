import { query } from '../pool.js';

export interface QuoteToStore {
  instrumentId: string;
  asOf: string;
  priceMinor: number;
  currency: string;
  source: string;
  delaySeconds: number;
}

/** Append quotes to the time series. Re-recording the same instant is a no-op. */
export async function recordQuotes(quotes: QuoteToStore[]): Promise<void> {
  if (quotes.length === 0) return;
  const values: string[] = [];
  const params: unknown[] = [];
  quotes.forEach((quote) => {
    const base = params.length;
    params.push(
      quote.instrumentId,
      quote.asOf,
      quote.priceMinor,
      quote.currency,
      quote.source,
      quote.delaySeconds,
    );
    values.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`,
    );
  });
  await query(
    `INSERT INTO quotes (instrument_id, as_of, price_minor, currency, source, delay_seconds)
     VALUES ${values.join(', ')}
     ON CONFLICT (instrument_id, as_of) DO NOTHING`,
    params,
  );
}
