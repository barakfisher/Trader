// @vitest-environment jsdom
/**
 * The observations feed, rendered: which of its four states the reader sees.
 *
 * "Nothing to report" is a finding - the engine looked and found nothing - so
 * it may appear only after a load has succeeded. Before the first answer, or
 * after a failure, the same empty list means something else entirely.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

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
const { applyLanguage } = await import('../src/i18n/index.ts');
const { FEED_PAGE_SIZE } = await import('../src/queries/observations.ts');
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
  localized: {},
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
      '/observations': () =>
        Promise.resolve({ observations: [finding, second], total: 2, nextCursor: null }),
      '/portfolio': noPortfolio,
    });
    renderWithServerState(<ObservationsFeed />);

    const headlines = await screen.findAllByText(/NVDA moved|VOO allocation/);
    expect(headlines.map((node) => node.textContent)).toEqual([finding.headline, second.headline]);
    expect(get).toHaveBeenCalledWith(`/observations?limit=${FEED_PAGE_SIZE}`);
  });

  it('shows a finding in the page language, and the English where it has no translation', async () => {
    const hebrew = {
      headline: 'מחיר \u2066NVDA\u2069 השתנה ב־\u2066-8.5%\u2069 ל־\u2066118.45 USD\u2069',
      explanation: 'מחיר \u2066NVDA\u2069 עבר מ־\u2066129.45 USD\u2069 ל־\u2066118.45 USD\u2069.',
    };
    const untranslated = { ...finding, id: 'obs-2', headline: 'VOO allocation fell below target weight' };
    serve({
      '/observations': () =>
        Promise.resolve({
          observations: [{ ...finding, localized: { he: hebrew } }, untranslated],
          total: 2,
          nextCursor: null,
        }),
      '/portfolio': noPortfolio,
    });
    try {
      renderWithServerState(<ObservationsFeed />);
      await screen.findByText(finding.headline);
      // After the store has started: it applies the session's language, English
      // here. Switching re-renders the text without a refetch.
      act(() => applyLanguage('he'));
      const translated = await screen.findByText(hebrew.headline);
      expect(translated.getAttribute('lang')).toBe('he');
      expect(screen.getByText(hebrew.explanation).getAttribute('lang')).toBe('he');
      // No translation: the English, still marked as English.
      expect(screen.getByText(untranslated.headline).getAttribute('lang')).toBe('en');
      expect(screen.queryByText(finding.headline)).toBeNull();
    } finally {
      applyLanguage('en');
    }
  });

  it('says "nothing to report" only once a load has succeeded with nothing', async () => {
    let answer: (value: { observations: Observation[]; total: number; nextCursor: null }) => void =
      () => {};
    serve({
      '/observations': () => new Promise((resolve) => (answer = resolve)),
      '/portfolio': noPortfolio,
    });
    renderWithServerState(<ObservationsFeed />);

    expect(screen.getByText('Loading observations…')).toBeTruthy();
    expect(screen.queryByText('Nothing to report')).toBeNull();

    answer({ observations: [], total: 0, nextCursor: null });
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
      '/observations': () => Promise.resolve({ observations: [finding], total: 1, nextCursor: null }),
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

  it('shows one page, says how many there are, and continues after the last one shown', async () => {
    const second = { ...finding, id: 'obs-2', headline: 'SMR is -30.6% from its 30-day high' };
    serve({
      '/observations?limit=10&before=obs-1': () =>
        Promise.resolve({ observations: [second], total: 2, nextCursor: null }),
      '/observations': () => Promise.resolve({ observations: [finding], total: 2, nextCursor: 'obs-1' }),
      '/portfolio': noPortfolio,
    });
    renderWithServerState(<ObservationsFeed filters={{}} onFiltersChange={() => {}} />);

    expect(await screen.findByText('1 of 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 more' }));

    expect(await screen.findByText(second.headline)).toBeTruthy();
    expect(screen.getByText('2 of 2')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /more/ })).toBeNull();
  });

  it('asks for the filtered feed, and says when a filter matches nothing', async () => {
    serve({
      '/observations': () => Promise.resolve({ observations: [], total: 0, nextCursor: null }),
      '/portfolio': noPortfolio,
    });
    const change = vi.fn();
    renderWithServerState(
      <ObservationsFeed filters={{ severity: 'high', symbol: 'NVDA' }} onFiltersChange={change} />,
    );

    expect(await screen.findByText('No findings match these filters')).toBeTruthy();
    expect(screen.queryByText('Nothing to report')).toBeNull();
    expect(get).toHaveBeenCalledWith('/observations?limit=10&severity=high&symbol=NVDA');

    fireEvent.click(screen.getByRole('button', { name: 'Notable and high' }));
    expect(change).toHaveBeenLastCalledWith({ severity: 'notable', symbol: 'NVDA' });
    fireEvent.click(screen.getByRole('button', { name: 'Show every finding' }));
    expect(change).toHaveBeenLastCalledWith({});
  });
});
