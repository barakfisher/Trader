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
const { coverageNote, fundShare, heldByText, verdictMessage } = await import(
  '../src/lib/topicPresentation.ts'
);

const LIMITS = { maxActiveTopics: 10, maxInstrumentsPerTopic: 3, maxLabelLength: 200 };

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
