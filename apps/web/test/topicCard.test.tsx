// @vitest-environment jsdom
/**
 * The topic card, rendered: the instruments, tone and news are read separately,
 * so one failing never hides the others, and an answer for a topic that is no
 * longer open never lands on the one that is.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';

const get = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>(
    '../src/api/client.ts',
  );
  return { ...actual, api: { get, post: vi.fn(), put: vi.fn(), delete: vi.fn(), postForm: vi.fn() } };
});

const { ApiRequestError } = await import('../src/api/client.ts');
const { TopicsPage } = await import('../src/pages/TopicsPage.tsx');
const { renderPage } = await import('./serverStateHarness.tsx');

const LIMITS = {
  maxActiveTopics: 10,
  maxInstrumentsPerTopic: 3,
  maxLabelLength: 200,
  maxOpenProposals: 3,
  rejectionCooldownDays: 90,
  proposalTtlDays: 14,
};

const detail = (id: string, label: string) => ({
  id,
  label,
  status: 'active',
  confirmedAt: null,
  instruments: [],
});
const news = (topicId: string, title: string) => ({
  topicId,
  days: 7,
  articles: [
    {
      id: `${topicId}-1`,
      title,
      url: 'https://example.com/a',
      source: 'example.com',
      publishedAt: '2026-09-28T10:00:00Z',
      fetchedAt: '2026-09-28T10:05:00Z',
      instruments: [],
    },
  ],
  collection: null,
});

describe('the topic card', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('shows the news when the tone could not be read', async () => {
    get.mockImplementation(async (path: string) => {
      if (path === '/topics') return { topics: [{ id: 't1', label: 'uranium', status: 'active' }], limits: LIMITS };
      if (path === '/topics/t1') return detail('t1', 'uranium');
      if (path === '/topics/t1/news') return news('t1', 'Uranium prices climb');
      throw new ApiRequestError('sentiment is down', 502, 'upstream_failure');
    });
    const { root } = renderPage(<TopicsPage />);
    act(() => root.topics.open('t1'));

    expect(await screen.findByText('Uranium prices climb')).toBeTruthy();
    expect(await screen.findByText('sentiment is down')).toBeTruthy();
  });

  it('never shows a late answer for a topic that is no longer open', async () => {
    let releaseA: (value: unknown) => void = () => {};
    get.mockImplementation(async (path: string) => {
      if (path === '/topics') return { topics: [], limits: LIMITS };
      if (path === '/topics/a') return detail('a', 'alpha');
      if (path === '/topics/a/news') return new Promise((resolve) => (releaseA = resolve));
      if (path === '/topics/b') return detail('b', 'beta');
      if (path === '/topics/b/news') return news('b', 'Beta headline');
      return new Promise(() => {});
    });
    const { root } = renderPage(<TopicsPage />);

    act(() => root.topics.open('a'));
    await screen.findByText('alpha');
    act(() => root.topics.open('b'));
    expect(await screen.findByText('Beta headline')).toBeTruthy();

    await act(async () => releaseA(news('a', 'Alpha headline')));
    expect(screen.queryByText('Alpha headline')).toBeNull();
    expect(screen.getByText('Beta headline')).toBeTruthy();
  });
});
