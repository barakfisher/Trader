/**
 * The AI client is the boundary between TypeScript and a service written in
 * another language, so these tests are about what happens when the far side
 * misbehaves: the happy path must keep working, and every kind of malformed
 * response must become a loud AiServiceError rather than an `undefined` that
 * turns into NaN three layers up.
 *
 * `fetch` is stubbed throughout; nothing here touches a network or a service.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AiClient, AiServiceError, HEALTH_TIMEOUT_MS } from '../src/ai/client.js';

const OPTIONS = { baseUrl: 'http://ai.test', internalApiKey: 'test-key' };

function validQuote(overrides: Record<string, unknown> = {}) {
  return {
    as_of: '2026-09-15T14:00:00Z',
    currency: 'USD',
    day_change_pct: 1.25,
    delay_seconds: 900,
    previous_close_minor: 22930,
    price_minor: 23214,
    source: 'fixture',
    stale: false,
    symbol: 'AAPL',
    ...overrides,
  };
}

/** Stub fetch with a single JSON response, as the service would send it. */
function respondWith(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

async function captureError(promise: Promise<unknown>): Promise<AiServiceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AiServiceError);
    return error as AiServiceError;
  }
  throw new Error('expected the call to reject');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AiClient valid responses', () => {
  it('parses a quote response and returns the parsed data', async () => {
    respondWith({ quotes: [validQuote()], missing: ['NOPE'] });
    const result = await new AiClient(OPTIONS).quotes(['AAPL', 'NOPE']);
    expect(result.quotes[0]!.price_minor).toBe(23214);
    expect(result.missing).toEqual(['NOPE']);
  });

  it('accepts a quote response without the optional fields', async () => {
    respondWith({
      quotes: [validQuote({ day_change_pct: null, previous_close_minor: null, delay_seconds: 0 })],
    });
    const result = await new AiClient(OPTIONS).quotes(['AAPL']);
    expect(result.quotes[0]!.day_change_pct).toBeNull();
    expect(result.missing).toBeUndefined();
  });

  it('parses an instrument resolution with candidates', async () => {
    respondWith({
      query: 'apple',
      confidence: 0.4,
      reason: 'multiple listings',
      candidates: [
        {
          symbol: 'AAPL',
          name: 'Apple Inc.',
          asset_class: 'equity',
          currency: 'USD',
          exchange: 'NASDAQ',
          source: 'fixture',
        },
      ],
    });
    const result = await new AiClient(OPTIONS).resolveInstrument('apple');
    expect(result.candidates?.[0]!.symbol).toBe('AAPL');
    expect(result.resolved).toBeUndefined();
  });

  it('parses an fx rate and a health response', async () => {
    respondWith({
      as_of: '2026-09-15T14:00:00Z',
      base: 'ILS',
      quote: 'USD',
      rate: '0.2681',
      source: 'fixture',
    });
    expect((await new AiClient(OPTIONS).fxRate('ILS', 'USD')).rate).toBe('0.2681');

    respondWith({
      service: 'ai-service',
      status: 'degraded',
      version: '0.1.0',
      checks: { db: 'ok' },
    });
    const health = await new AiClient(OPTIONS).health();
    expect(health.status).toBe('degraded');
    expect(health.checks).toEqual({ db: 'ok' });
  });
});

describe('AiClient health', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('gives up on a hung service after HEALTH_TIMEOUT_MS, not the client default', async () => {
    vi.useFakeTimers();
    // A service that accepts the connection and never answers.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            );
          }),
      ),
    );
    const pending = captureError(new AiClient({ ...OPTIONS, timeoutMs: 60_000 }).health());
    await vi.advanceTimersByTimeAsync(HEALTH_TIMEOUT_MS);
    const error = await pending;
    expect(error.status).toBe(504);
    expect(error.message).toContain(`${HEALTH_TIMEOUT_MS}ms`);
  });
});

describe('AiClient malformed responses', () => {
  it('rejects a quote that is missing price_minor', async () => {
    const quote = validQuote();
    delete (quote as Record<string, unknown>).price_minor;
    respondWith({ quotes: [quote] });

    const error = await captureError(new AiClient(OPTIONS).quotes(['AAPL']));
    expect(error.status).toBe(502);
    // The issues travel as the error body so the log names the offending field
    // instead of only saying "invalid".
    expect(JSON.stringify(error.body)).toContain('price_minor');
  });

  it('rejects a null where the contract forbids one', async () => {
    respondWith({ quotes: [validQuote({ price_minor: null })] });
    const error = await captureError(new AiClient(OPTIONS).quotes(['AAPL']));
    expect(error.status).toBe(502);
  });

  it('rejects a price that is not an integer number of minor units', async () => {
    respondWith({ quotes: [validQuote({ price_minor: 232.14 })] });
    expect((await captureError(new AiClient(OPTIONS).quotes(['AAPL']))).status).toBe(502);
  });

  it('rejects an fx rate that would not parse as a decimal', async () => {
    // `Number('n/a')` is NaN, and NaN silently propagates through convertMinor.
    respondWith({
      as_of: '2026-09-15T14:00:00Z',
      base: 'ILS',
      quote: 'USD',
      rate: 'n/a',
      source: 'fixture',
    });
    expect((await captureError(new AiClient(OPTIONS).fxRate('ILS', 'USD'))).status).toBe(502);
  });

  it('rejects an unknown enum value rather than passing it through', async () => {
    respondWith({ service: 'ai-service', status: 'on fire', version: '0.1.0' });
    expect((await captureError(new AiClient(OPTIONS).health())).status).toBe(502);
  });

  it('rejects an empty body where an object is expected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 200 })),
    );
    expect((await captureError(new AiClient(OPTIONS).health())).status).toBe(502);
  });
});

describe('AiClient transport failures', () => {
  it('keeps the existing error shape for an HTTP error, ahead of validation', async () => {
    respondWith({ detail: 'symbol required' }, 422);
    const error = await captureError(new AiClient(OPTIONS).quotes(['AAPL']));
    expect(error.status).toBe(422);
    expect(error.message).toContain('AI service 422');
    expect(error.body).toEqual({ detail: 'symbol required' });
  });

  it('reports an unreachable service as 503', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const error = await captureError(new AiClient(OPTIONS).health());
    expect(error.status).toBe(503);
    expect(error.message).toContain('unreachable');
  });

  it('aborts and reports 504 when the service does not answer in time', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const abort = new Error('aborted');
              abort.name = 'AbortError';
              reject(abort);
            });
          }),
      ),
    );
    const error = await captureError(new AiClient({ ...OPTIONS, timeoutMs: 5 }).health());
    expect(error.status).toBe(504);
    expect(error.message).toContain('timed out');
  });
});
