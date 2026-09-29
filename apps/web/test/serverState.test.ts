/**
 * The query cache's policies: what is retried, and what sign-out leaves behind.
 */

import { describe, expect, it, vi } from 'vitest';

import type { PortfolioResponse } from '@traders/shared';

const post = vi.fn();

vi.mock('../src/api/client.ts', () => ({
  api: { get: vi.fn(), post, postForm: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  ApiRequestError: class ApiRequestError extends Error {
    constructor(
      message: string,
      readonly status = 500,
      readonly code = 'error',
    ) {
      super(message);
    }
  },
}));

const { ApiRequestError } = await import('../src/api/client.ts');
const { QUERY_MAX_RETRIES, shouldRetry } = await import('../src/queries/queryClient.ts');
const { queryKeys } = await import('../src/queries/queryKeys.ts');
const { RootStore } = await import('../src/stores/RootStore.ts');

const somePortfolio = { holdings: [], summary: { baseCurrency: 'USD' } } as unknown as PortfolioResponse;

describe('retry policy', () => {
  it('retries what a retry might fix, up to the limit', () => {
    const unreachable = new ApiRequestError('Cannot reach the server.', 0, 'network_error');
    const serverFault = new ApiRequestError('boom', 503, 'unavailable');
    expect(shouldRetry(0, unreachable)).toBe(true);
    expect(shouldRetry(0, serverFault)).toBe(true);
    expect(shouldRetry(QUERY_MAX_RETRIES, serverFault)).toBe(false);
  });

  it('never retries an answer: a 401 or a 422 will say the same thing again', () => {
    expect(shouldRetry(0, new ApiRequestError('signed out', 401, 'unauthenticated'))).toBe(false);
    expect(shouldRetry(0, new ApiRequestError('refused', 422, 'invalid'))).toBe(false);
  });
});

describe('sign-out', () => {
  it("clears every cached response, so one account's data never appears under another", async () => {
    const root = new RootStore();
    root.queryClient.setQueryData(queryKeys.portfolio, somePortfolio);
    root.queryClient.setQueryData(queryKeys.observations, []);
    expect(root.portfolioCache.data).toBe(somePortfolio);

    post.mockResolvedValue(undefined);
    await root.auth.logout();

    expect(root.queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(root.portfolioCache.data).toBeUndefined();
  });

  it('still mirrors the next account once the old cache is gone', () => {
    const root = new RootStore();
    root.queryClient.setQueryData(queryKeys.portfolio, somePortfolio);
    root.queryClient.clear();

    const next = { ...somePortfolio };
    root.queryClient.setQueryData(queryKeys.portfolio, next);
    expect(root.portfolioCache.data).toBe(next);
  });
});
