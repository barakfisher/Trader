/**
 * The topic confirm screen: what it selects, what it sends, and what it says.
 *
 * Three properties matter most. Nothing is ticked for the user. The confirm
 * request carries symbols only, never a reason, because the server decides
 * provenance by resolving again. And "no universe loaded" is never worded as
 * "nothing matches", since the first is about the installation and the second
 * is about the topic.
 *
 * The API client is mocked, as in targets.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();
const del = vi.fn();

vi.mock('../src/api/client.ts', () => ({
  api: { get, post, put, delete: del, patch: vi.fn(), postForm: vi.fn() },
  ApiRequestError: class ApiRequestError extends Error {
    constructor(
      message: string,
      readonly status = 500,
      readonly code = 'error',
      readonly details?: unknown,
    ) {
      super(message);
    }
  },
}));

const { RootStore } = await import('../src/stores/RootStore.ts');
const { ApiRequestError } = await import('../src/api/client.ts');
const {
  coverageNote,
  fundShare,
  heldByText,
  newsEmptyMessage,
  sentimentSummary,
  signedScore,
  verdictMessage,
} = await import('../src/lib/topicPresentation.ts');

const LIMITS = {
  maxActiveTopics: 10,
  maxInstrumentsPerTopic: 3,
  maxLabelLength: 200,
  maxOpenProposals: 3,
  rejectionCooldownDays: 90,
};

function candidate(symbol: string) {
  return {
    instrument_id: `id-${symbol}`,
    symbol,
    name: `${symbol} Corp`,
    asset_class: 'equity',
    sector: null,
    industry: null,
    similarity: 0.5,
    size_minor: 100_000_000_000,
    size_currency: 'USD',
    confidence: 'confident' as const,
    rationale: `${symbol} mines uranium.`,
    held_by: [],
  };
}

function resolution(symbols: string[], verdict = 'confident') {
  return {
    topic: 'uranium',
    verdict,
    best_similarity: 0.5,
    refuse_below: 0.32,
    confident_above: 0.45,
    interpretations: symbols.length ? [{ label: 'Uranium', candidates: symbols.map(candidate) }] : [],
    ambiguous: false,
    universe: { state: 'ready', profiles: 10, embedded: 10 },
    embedding_model: 'm',
    vector_is_semantic: true,
  };
}

async function loadedStore(topics: unknown[] = []) {
  const root = new RootStore();
  get.mockResolvedValueOnce({ topics, limits: LIMITS });
  await root.topics.load();
  return root.topics;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the confirm screen', () => {
  it('ticks nothing for the user', async () => {
    const topics = await loadedStore();
    topics.startNew();
    const composer = topics.composer!;
    composer.setLabel('uranium');
    post.mockResolvedValueOnce(resolution(['CCJ', 'NXE']));

    await composer.resolve();

    expect(post).toHaveBeenCalledWith('/topics/resolve', { topic: 'uranium' });
    expect(composer.offered.size).toBe(2);
    expect(composer.selected).toEqual([]);
    expect(composer.canConfirm).toBe(false);
  });

  it('sends the label and symbols only, never a reason', async () => {
    const topics = await loadedStore();
    topics.startNew();
    const composer = topics.composer!;
    composer.setLabel('  uranium ');
    post.mockResolvedValueOnce(resolution(['CCJ']));
    await composer.resolve();
    composer.toggle('CCJ');
    composer.setAddText('bwxt, leu');
    composer.addTickers();
    post.mockResolvedValueOnce({ id: 't1', instruments: [] });
    get.mockResolvedValueOnce({ topics: [], limits: LIMITS });

    await composer.confirm();

    expect(post).toHaveBeenLastCalledWith('/topics', {
      label: 'uranium',
      symbols: ['CCJ', 'BWXT', 'LEU'],
    });
  });

  it('shows typed tickers as additions, apart from the suggestions', async () => {
    const topics = await loadedStore();
    topics.startNew();
    const composer = topics.composer!;
    composer.setLabel('uranium');
    post.mockResolvedValueOnce(resolution(['CCJ']));
    await composer.resolve();

    composer.toggle('CCJ');
    composer.setAddText('BWXT BWXT ccj');
    composer.addTickers();

    expect(composer.selected).toEqual(['CCJ', 'BWXT']);
    expect(composer.additions).toEqual(['BWXT']);
    expect(composer.addText).toBe('');
  });

  it('stops choosing at the instrument cap', async () => {
    const topics = await loadedStore();
    topics.startNew();
    const composer = topics.composer!;
    composer.setLabel('uranium');
    post.mockResolvedValueOnce(resolution(['A', 'B', 'C', 'D']));
    await composer.resolve();

    composer.selectAll(composer.resolution!.interpretations![0]!.candidates);
    composer.toggle('D');

    expect(composer.selected).toEqual(['A', 'B', 'C']);
    expect(composer.atInstrumentLimit).toBe(true);
  });

  it('marks the tickers a refused confirm names, and keeps the choice on screen', async () => {
    const topics = await loadedStore();
    topics.startNew();
    const composer = topics.composer!;
    composer.setLabel('uranium');
    composer.setAddText('NOPE');
    composer.addTickers();
    post.mockRejectedValueOnce(
      new ApiRequestError('no market data provider recognises NOPE', 422, 'unresolved_symbols', {
        symbols: ['NOPE'],
      }),
    );

    expect(await composer.confirm()).toBe(false);

    expect(composer.unresolved).toEqual(['NOPE']);
    expect(composer.selected).toEqual(['NOPE']);
    expect(topics.composer).toBe(composer);
  });

  it('refuses a new topic at the topic cap before asking the server', async () => {
    const full = Array.from({ length: LIMITS.maxActiveTopics }, (_, i) => ({
      id: `t${i}`,
      label: `t${i}`,
      status: 'active',
    }));
    const topics = await loadedStore(full);
    topics.startNew();
    const composer = topics.composer!;
    composer.setLabel('one more');
    composer.setAddText('CCJ');
    composer.addTickers();

    expect(topics.atLimit).toBe(true);
    expect(composer.blockingIssue).toMatch(/most you can/);
    expect(await composer.confirm()).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('opens an existing topic with its set already chosen, and saves with PUT', async () => {
    const topics = await loadedStore();
    post.mockResolvedValueOnce(resolution(['CCJ']));
    topics.edit({
      id: 't1',
      label: 'uranium',
      instruments: [{ symbol: 'CCJ' }, { symbol: 'BWXT' }],
    } as never);
    const composer = topics.composer!;
    await vi.waitFor(() => expect(composer.resolution).not.toBeNull());

    expect(composer.selected).toEqual(['CCJ', 'BWXT']);
    expect(composer.additions).toEqual(['BWXT']);

    put.mockResolvedValueOnce({ id: 't1', instruments: [] });
    get.mockResolvedValueOnce({ topics: [], limits: LIMITS });
    await composer.confirm();
    expect(put).toHaveBeenCalledWith('/topics/t1', { label: 'uranium', symbols: ['CCJ', 'BWXT'] });
  });

  it('knows when its suggestions are for a label that has since changed', async () => {
    const topics = await loadedStore();
    topics.startNew();
    const composer = topics.composer!;
    composer.setLabel('uranium');
    post.mockResolvedValueOnce(resolution(['CCJ']));
    await composer.resolve();

    composer.setLabel('nuclear fuel');

    expect(composer.stale).toBe(true);
  });
});

describe('auto-proposals', () => {
  const PROPOSAL = {
    id: 'p1',
    label: 'data centre',
    status: 'proposed',
    createdBy: 'auto',
    evidence: {
      phrase: 'data centre',
      articleCount: 4,
      sourceCount: 3,
      windowDays: 7,
      headlines: [],
      symbols: ['EQIX', 'DLR'],
    },
  };

  it('keeps proposals apart from followed topics, and out of the count', async () => {
    const topics = await loadedStore([PROPOSAL, { id: 't1', label: 'uranium', status: 'active' }]);
    expect(topics.proposals.map((t) => t.id)).toEqual(['p1']);
    expect(topics.followed.map((t) => t.id)).toEqual(['t1']);
    expect(topics.activeCount).toBe(1);
  });

  it('reviews a proposal with nothing ticked, not even what the resolver suggested', async () => {
    const topics = await loadedStore([PROPOSAL]);
    post.mockResolvedValueOnce(resolution(['EQIX', 'DLR']));

    topics.review(PROPOSAL as never);
    await vi.waitFor(() => expect(topics.composer?.resolution).not.toBeNull());

    expect(topics.composer!.topicId).toBe('p1');
    expect(topics.composer!.label).toBe('data centre');
    expect(topics.composer!.selected).toEqual([]);
  });

  it('accepts a proposal through PUT on its id', async () => {
    const topics = await loadedStore([PROPOSAL]);
    post.mockResolvedValueOnce(resolution(['EQIX']));
    topics.review(PROPOSAL as never);
    await vi.waitFor(() => expect(topics.composer?.resolution).not.toBeNull());
    topics.composer!.toggle('EQIX');
    put.mockResolvedValueOnce({ ...PROPOSAL, status: 'active', instruments: [] });
    get.mockResolvedValueOnce({ topics: [], limits: LIMITS });

    expect(await topics.composer!.confirm()).toBe(true);
    expect(put).toHaveBeenCalledWith('/topics/p1', { label: 'data centre', symbols: ['EQIX'] });
  });

  it('refuses to accept a proposal at the topic cap, since it would add a topic', async () => {
    const full = Array.from({ length: LIMITS.maxActiveTopics }, (_, i) => ({
      id: `t${i}`,
      label: `t${i}`,
      status: 'active',
    }));
    const topics = await loadedStore([...full, PROPOSAL]);
    post.mockResolvedValueOnce(resolution(['EQIX']));
    topics.review(PROPOSAL as never);
    topics.composer!.setAddText('EQIX');
    topics.composer!.addTickers();

    expect(topics.composer!.blockingIssue).toMatch(/most you can/);
  });

  it('declines with the reject action, never a delete, and reloads', async () => {
    const topics = await loadedStore([PROPOSAL]);
    post.mockResolvedValueOnce(undefined);
    get.mockResolvedValueOnce({ topics: [], limits: LIMITS });

    expect(await topics.reject('p1')).toBe(true);

    expect(post).toHaveBeenCalledWith('/topics/p1/reject');
    expect(del).not.toHaveBeenCalled();
    expect(topics.proposals).toEqual([]);
  });
});

describe('what the screen says', () => {
  it('never words a missing universe as a topic that matches nothing', () => {
    const none = verdictMessage({
      verdict: 'none',
      universe: { state: 'ready', profiles: 10, embedded: 10 },
    })!;
    const unavailable = verdictMessage({
      verdict: 'unavailable',
      universe: { state: 'not_loaded', profiles: 0, embedded: 0 },
    })!;

    expect(none.text).toMatch(/Nothing in the instrument universe/);
    expect(unavailable.text).toMatch(/no instrument universe loaded/);
    expect(unavailable.text).not.toMatch(/Nothing in the instrument universe/);
  });

  it('names an unindexed universe as its own state', () => {
    expect(
      verdictMessage({
        verdict: 'unavailable',
        universe: { state: 'not_embedded', profiles: 5, embedded: 0 },
      })!.text,
    ).toMatch(/not indexed/);
  });

  it('says nothing extra for a confident resolution, and hedges a weak one', () => {
    const ready = { state: 'ready' as const, profiles: 10, embedded: 10 };
    expect(verdictMessage({ verdict: 'confident', universe: ready })).toBeNull();
    expect(verdictMessage({ verdict: 'weak', universe: ready })!.tone).toBe('caution');
  });

  it('notes a partial search', () => {
    expect(coverageNote({ state: 'partially_embedded', profiles: 5223, embedded: 100 })).toBe(
      'Only 100 of 5,223 instruments could be searched, so some matches may be missing.',
    );
    expect(coverageNote({ state: 'ready', profiles: 5, embedded: 5 })).toBeNull();
  });

  it.each([
    ['0.219495', '21.9%'],
    ['0.0600664', '6.0%'],
    ['1', '100.0%'],
    ['0.5', '50.0%'],
    ['0.0009', '0.0%'],
  ])('shows fund weight %s as %s without rounding up', (weight, shown) => {
    expect(fundShare(weight)).toBe(shown);
  });

  it('lists the funds that hold a candidate', () => {
    expect(heldByText([])).toBeNull();
    expect(
      heldByText([
        { etf: 'URA', weight: '0.219495' },
        { etf: 'NLR', weight: '0.04' },
      ]),
    ).toBe('held by URA 21.9%, NLR 4.0%');
  });
});


describe('the topic card', () => {
  const COLLECTED = { lastRunAt: '2026-09-27T14:01:12Z', failedProviders: [] as string[] };

  it('never calls a week quiet when the news could not be read', () => {
    const failing = newsEmptyMessage({ ...COLLECTED, status: 'degraded', failedProviders: ['gdelt'] }, 7);
    expect(failing).not.toMatch(/No news about/);
    expect(failing).toMatch(/may not mean a quiet week/);
    expect(failing).toMatch(/gdelt/);
    expect(newsEmptyMessage({ ...COLLECTED, status: 'failed' }, 7)).toMatch(/stories may be missing/);
  });

  it('calls a week quiet only after a clean collection', () => {
    expect(newsEmptyMessage({ ...COLLECTED, status: 'ok' }, 7)).toBe(
      'No news about this topic’s instruments in the last 7 days.',
    );
  });

  it('says so when news was never collected', () => {
    expect(newsEmptyMessage(null, 7)).toMatch(/has not been collected yet/);
  });

  it.each([
    ['0.4125', '+0.41'],
    ['-0.4199', '−0.41'],
    ['1', '+1.00'],
    ['0.0040', '0.00'],
    ['-0.0040', '0.00'],
  ])('shows score %s as %s, truncated and signed', (score, shown) => {
    expect(signedScore(score)).toBe(shown);
  });

  const SENTIMENT = {
    topicId: 't1',
    days: 7,
    model: 'lexicon-v1',
    otherModels: [],
    daily: [],
    behind: [],
  };

  it('never shows a missing tone as zero', () => {
    const summary = sentimentSummary({
      ...SENTIMENT,
      score: null,
      gap: 'too_few_polarised',
      counts: { articles: 4, unscored: 0, positive: 1, negative: 0, neutral: 3 },
    });
    expect(summary.score).toBeNull();
    expect(summary.text).toMatch(/too few articles/);
  });

  it('shows a tone with the counts it rests on', () => {
    const summary = sentimentSummary({
      ...SENTIMENT,
      score: '-0.2500',
      gap: null,
      counts: { articles: 5, unscored: 0, positive: 1, negative: 3, neutral: 1 },
    });
    expect(summary.score).toBe('−0.25');
    expect(summary.text).toMatch(/5 articles \(1 positive, 3 negative, 1 neutral\)/);
  });

  it('loads news and tone with the topic, and keeps one when the other fails', async () => {
    const topics = await loadedStore();
    const detail = { id: 't1', label: 'uranium', status: 'active', instruments: [] };
    const news = { topicId: 't1', days: 7, articles: [], collection: null };
    get.mockImplementation(async (path: string) => {
      if (path === '/topics/t1') return detail;
      if (path === '/topics/t1/news') return news;
      throw new ApiRequestError('sentiment is down', 502, 'upstream_failure');
    });

    await topics.open('t1');
    await vi.waitFor(() => expect(topics.sentimentError).not.toBeNull());

    expect(topics.detail).toEqual(detail);
    expect(topics.news).toEqual(news);
    expect(topics.sentiment).toBeNull();
  });

  it('drops a late answer for a topic that is no longer open', async () => {
    const topics = await loadedStore();
    let releaseA: (value: unknown) => void = () => {};
    get.mockImplementation(async (path: string) => {
      if (path === '/topics/a/news') return new Promise((resolve) => (releaseA = resolve));
      if (path.startsWith('/topics/a')) return new Promise(() => {});
      if (path === '/topics/b') return { id: 'b', label: 'b', status: 'active', instruments: [] };
      if (path === '/topics/b/news') return { topicId: 'b', days: 7, articles: [], collection: null };
      return new Promise(() => {});
    });

    void topics.open('a');
    await topics.open('b');
    releaseA({ topicId: 'a', days: 7, articles: [], collection: null });
    await vi.waitFor(() => expect(topics.news?.topicId).toBe('b'));
    await Promise.resolve();

    expect(topics.news?.topicId).toBe('b');
  });

});
