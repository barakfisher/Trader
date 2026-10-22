/**
 * A request refused by a rate limit (D257) reads as a sentence in the user's
 * language, saying when to try again - whichever route refused it, because the
 * API client says it rather than each caller.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError, RATE_LIMITED, api, retryAfterMinutes } from '../src/api/client.ts';
import { i18n } from '../src/i18n/index.ts';

function refuseWith(retryAfter: string | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: RATE_LIMITED, message: 'too many requests', details: { retryAfterSeconds: 125 } }),
          { status: 429, headers: retryAfter === null ? {} : { 'retry-after': retryAfter } },
        ),
    ),
  );
}

async function refusal(): Promise<ApiRequestError> {
  try {
    await api.post('/assistant/messages', { message: 'x' });
  } catch (error) {
    if (error instanceof ApiRequestError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage('en');
});

describe('a rate-limited request', () => {
  it('says when to try again, in whole minutes, in English', async () => {
    refuseWith('125');
    const error = await refusal();
    expect(error.status).toBe(429);
    expect(error.code).toBe(RATE_LIMITED);
    expect(error.message).toBe(i18n.t('api.rateLimited', { count: 3 }));
    expect(error.message).not.toContain('too many requests');
  });

  it('says it in Hebrew, with Hebrew plural forms', async () => {
    await i18n.changeLanguage('he');
    for (const [header, count] of [['30', 1], ['90', 2], ['600', 10]] as const) {
      refuseWith(header);
      const error = await refusal();
      expect(error.message).toBe(i18n.t('api.rateLimited', { count }));
    }
    refuseWith('90');
    expect((await refusal()).message).toContain('שתי דקות');
  });

  it('reads a missing or unreadable Retry-After as one minute', () => {
    expect(retryAfterMinutes(null)).toBe(1);
    expect(retryAfterMinutes('soon')).toBe(1);
    expect(retryAfterMinutes('61')).toBe(2);
  });
});
