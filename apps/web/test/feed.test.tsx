// @vitest-environment jsdom
/**
 * The observations feed, rendered: which of its four states the reader sees.
 *
 * "Nothing to report" is a finding - the engine looked and found nothing - so
 * it may appear only after a load has succeeded. Before the first answer, or
 * after a failure, the same empty list means something else entirely.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';

import type { Observation } from '@traders/shared';

const get = vi.fn();

vi.mock('../src/api/client.ts', () => {
  class ApiRequestError extends Error {
    constructor(
      message: string,
      readonly status = 500,
      readonly code = 'error',
    ) {
      super(message);
    }
  }
  return {
    api: { get, post: vi.fn(), postForm: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    ApiRequestError,
    errorMessage: (error: unknown, fallback: string) =>
      error instanceof ApiRequestError ? error.message : fallback,
  };
});

const { ApiRequestError } = await import('../src/api/client.ts');
const { ObservationsFeed } = await import('../src/components/ObservationsFeed.tsx');
const { OBSERVATIONS_PAGE_SIZE } = await import('../src/queries/observations.ts');
const { renderWithServerState } = await import('./serverStateHarness.tsx');

const finding: Observation = {
  id: 'obs-1',
  kind: 'price_move',
  severity: 'high',
  subjectKind: 'instrument',
  subjectRef: 'instrument:NVDA',
  headline: 'NVDA moved -8.5% to 118.45 USD',
  explanation: 'NVDA went from 129.45 USD to 118.45 USD, a change of -8.5%.',
  evidence: { symbol: 'NVDA', currency: 'USD', price_minor: 11845 },
  conceptRefs: [],
  narrationSource: 'template',
  fallbackReason: 'none',
  createdAt: '2026-09-16T14:00:00Z',
};

/** Route the mocked network by path; anything unexpected fails loudly. */
function serve(routes: Record<string, () => Promise<unknown>>) {
  get.mockImplementation((path: string) => {
    const route = Object.keys(routes).find((prefix) => path.startsWith(prefix));
    return route ? routes[route]!() : Promise.reject(new Error(`unexpected GET ${path}`));
  });
}

const noPortfolio = () => Promise.reject(new ApiRequestError('not needed here', 503, 'unavailable'));

describe('ObservationsFeed', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('asks for one page and shows the findings in the order the API sent them', async () => {
    const second = { ...finding, id: 'obs-2', headline: 'VOO allocation fell below target weight' };
    serve({
      '/observations': () => Promise.resolve({ observations: [finding, second] }),
      '/portfolio': noPortfolio,
    });
    renderWithServerState(<ObservationsFeed />);

    const headlines = await screen.findAllByText(/NVDA moved|VOO allocation/);
    expect(headlines.map((node) => node.textContent)).toEqual([finding.headline, second.headline]);
    expect(get).toHaveBeenCalledWith(`/observations?limit=${OBSERVATIONS_PAGE_SIZE}`);
  });

  it('says "nothing to report" only once a load has succeeded with nothing', async () => {
    let answer: (value: { observations: Observation[] }) => void = () => {};
    serve({
      '/observations': () => new Promise((resolve) => (answer = resolve)),
      '/portfolio': noPortfolio,
    });
    renderWithServerState(<ObservationsFeed />);

    expect(screen.getByText('Loading observations…')).toBeTruthy();
    expect(screen.queryByText('Nothing to report')).toBeNull();

    answer({ observations: [] });
    expect(await screen.findByText('Nothing to report')).toBeTruthy();
  });

  it('reports a failure, and never as a quiet day', async () => {
    serve({
      '/observations': () =>
        Promise.reject(new ApiRequestError('Cannot reach the server.', 0, 'network_error')),
      '/portfolio': noPortfolio,
    });
    renderWithServerState(<ObservationsFeed />);

    expect(await screen.findByText('Cannot reach the server.')).toBeTruthy();
    expect(screen.queryByText('Nothing to report')).toBeNull();
  });

  it('keeps the findings on screen when a refresh fails', async () => {
    serve({
      '/observations': () => Promise.resolve({ observations: [finding] }),
      '/portfolio': noPortfolio,
    });
    const { root } = renderWithServerState(<ObservationsFeed />);
    await screen.findByText(finding.headline);

    serve({
      '/observations': () =>
        Promise.reject(new ApiRequestError('Cannot reach the server.', 0, 'network_error')),
      '/portfolio': noPortfolio,
    });
    await root.queryClient.refetchQueries();

    await waitFor(() => expect(screen.getByText('Cannot reach the server.')).toBeTruthy());
    expect(screen.getByText(finding.headline)).toBeTruthy();
    expect(screen.queryByText('Nothing to report')).toBeNull();
  });
});
