/** A stand-in for the AI service, driven by the same fixture prices as the real one. */

import type { AiClient } from '@traders/shared/ai';

const PRICES: Record<string, { price: number; previous: number; currency: string; assetClass: string }> = {
  AAPL: { price: 23214, previous: 22979, currency: 'USD', assetClass: 'equity' },
  VOO: { price: 51208, previous: 51022, currency: 'USD', assetClass: 'etf' },
  'BTC-USD': { price: 5841233, previous: 5712010, currency: 'USD', assetClass: 'crypto' },
  'SAP.DE': { price: 19640, previous: 19405, currency: 'EUR', assetClass: 'equity' },
};

const FX: Record<string, string> = { EURUSD: '1.1043', USDUSD: '1' };

export interface FakeAiOptions {
  /** Symbols to pretend no provider can price. */
  unpriceable?: string[];
  /** Currency pairs to pretend are unavailable, e.g. ['EURUSD']. */
  missingFx?: string[];
  /** Symbols to return as ambiguous, with candidates. */
  ambiguous?: Record<string, string[]>;
}

export function createFakeAi(options: FakeAiOptions = {}): AiClient {
  const unpriceable = new Set((options.unpriceable ?? []).map((s) => s.toUpperCase()));
  const missingFx = new Set(options.missingFx ?? []);

  const client = {
    async quotes(symbols: string[]) {
      const quotes = [];
      const missing: string[] = [];
      for (const raw of symbols) {
        const symbol = raw.toUpperCase();
        const entry = PRICES[symbol];
        if (!entry || unpriceable.has(symbol)) {
          missing.push(symbol);
          continue;
        }
        quotes.push({
          symbol,
          price_minor: entry.price,
          currency: entry.currency,
          as_of: '2026-09-14T12:00:00Z',
          source: 'fake',
          delay_seconds: 0,
          previous_close_minor: entry.previous,
          day_change_pct: Number((((entry.price - entry.previous) / entry.previous) * 100).toFixed(4)),
          stale: false,
        });
      }
      return { quotes, missing };
    },

    async resolveInstrument(query: string) {
      const symbol = query.toUpperCase();
      const candidates = options.ambiguous?.[symbol];
      if (candidates) {
        return {
          query,
          resolved: null,
          candidates: candidates.map((candidate) => ({
            symbol: candidate,
            name: candidate,
            asset_class: 'equity',
            exchange: 'TEST',
            currency: 'USD',
            source: 'fake',
          })),
          confidence: 0.5,
          reason: 'ambiguous',
        };
      }
      const entry = PRICES[symbol];
      if (!entry || unpriceable.has(symbol)) {
        return { query, resolved: null, candidates: [], confidence: 0, reason: 'unknown symbol' };
      }
      return {
        query,
        resolved: {
          symbol,
          name: symbol,
          asset_class: entry.assetClass,
          exchange: 'TEST',
          currency: entry.currency,
          source: 'fake',
        },
        candidates: [],
        confidence: 1,
        reason: 'exact match',
      };
    },

    async fxRate(base: string, quote: string) {
      const key = `${base.toUpperCase()}${quote.toUpperCase()}`;
      if (missingFx.has(key)) throw new Error(`no FX rate for ${key}`);
      const rate = base.toUpperCase() === quote.toUpperCase() ? '1' : FX[key];
      if (!rate) throw new Error(`no FX rate for ${key}`);
      return { base, quote, rate, as_of: '2026-09-14T12:00:00Z', source: 'fake' };
    },

    async health() {
      return { status: 'ok' as const, service: 'ai-service', version: 'test', checks: {} };
    },
  };

  return client as unknown as AiClient;
}
