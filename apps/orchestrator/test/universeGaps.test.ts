/**
 * What a gap event says, and what is deliberately not one.
 *
 * A gap is recorded only when the universe was asked and said no, or when
 * nothing could price the symbol. "Membership was not checked" and "the user
 * is being asked to choose" are not gaps; recording them would fill the
 * admin page with gaps that are not there.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/queries.js', () => ({ recordOpsEvent: vi.fn(async () => undefined) }));

const queries = await import('../src/db/queries.js');
const { missingTickerDetail, normaliseTopic, recordLowConfidence, recordMissingTicker, requestProfile } =
  await import(
  '../src/services/universeGaps.js'
);

const USER = { userId: 'u-1', timezone: 'Asia/Jerusalem' };
// 21:30 UTC on 30 Sep is already 1 Oct in Jerusalem: the key is the user's day.
const NOW = new Date('2026-09-30T21:30:00Z');

function resolution(overrides: Record<string, unknown> = {}) {
  return {
    query: 'x',
    confidence: 1,
    resolved: {
      symbol: 'TINY',
      name: 'Tiny Corp',
      asset_class: 'equity',
      exchange: 'NMS',
      currency: 'USD',
      source: 'yfinance',
    },
    candidates: [],
    universe: { member: false, outside_screen: null },
    ...overrides,
  } as never;
}

function topicResolution(verdict: string) {
  return {
    topic: '  Quantum   Computing ',
    verdict,
    best_similarity: 0.18,
    refuse_below: 0.23,
    confident_above: 0.4,
    interpretations: [],
    ambiguous: false,
    universe: { state: 'ready', profiles: 5223, embedded: 5223 },
    embedding_model: 'text-embedding-3-small',
    vector_is_semantic: true,
  } as never;
}

describe('a missing ticker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is a real gap when a US listing is simply not in the universe', () => {
    expect(missingTickerDetail('tiny', resolution(), 'import')).toEqual({
      symbol: 'TINY',
      source: 'import',
      gap: 'not_in_universe',
      rule: null,
      assetClass: 'equity',
      exchange: 'NMS',
    });
  });

  it('names the screen rule when the listing could never be in it', () => {
    const crypto = resolution({ universe: { member: false, outside_screen: 'asset_class' } });
    expect(missingTickerDetail('BTC-USD', crypto, 'holding')).toMatchObject({
      gap: 'outside_screen',
      rule: 'asset_class',
    });
  });

  it('is unpriced when nothing could price it', () => {
    const nothing = resolution({ resolved: null, universe: null });
    expect(missingTickerDetail('NOSUCH', nothing, 'topic')).toMatchObject({
      symbol: 'NOSUCH',
      gap: 'unpriced',
    });
  });

  it('is not a gap for a member, an unchecked membership, or a choice being offered', () => {
    expect(missingTickerDetail('AAPL', resolution({ universe: { member: true } }), 'import')).toBeNull();
    expect(missingTickerDetail('AAPL', resolution({ universe: null }), 'import')).toBeNull();
    const choice = resolution({ resolved: null, candidates: [{ symbol: 'A' }], universe: null });
    expect(missingTickerDetail('A', choice, 'import')).toBeNull();
  });

  it("is keyed by user, symbol and the user's own day, so repeats are counted not duplicated", async () => {
    await recordMissingTicker(USER, 'tiny', resolution(), 'import', NOW);
    expect(queries.recordOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'universe_gap_missing_ticker',
        userId: 'u-1',
        dedupeKey: 'missing_ticker:u-1:TINY:2026-10-01',
      }),
    );
  });

  it('never throws, even when the write fails', async () => {
    vi.mocked(queries.recordOpsEvent).mockRejectedValueOnce(new Error('connection lost'));
    await expect(recordMissingTicker(USER, 'tiny', resolution(), 'import', NOW)).resolves.toBeUndefined();
  });
  it('asks for a profile of a real gap, and only of a real gap', async () => {
    const ai = { requestProfile: vi.fn(async () => ({})) };
    await recordMissingTicker({ ...USER, ai, requestId: 'r-1' }, 'tiny', resolution(), 'import', NOW);
    expect(ai.requestProfile).toHaveBeenCalledWith('TINY', 'r-1');

    ai.requestProfile.mockClear();
    const german = resolution({ universe: { member: false, outside_screen: 'exchange' } });
    await recordMissingTicker({ ...USER, ai }, 'SAP.DE', german, 'import', NOW);
    const unpriced = resolution({ resolved: null, candidates: [], universe: null });
    await recordMissingTicker({ ...USER, ai }, 'NOSUCH', unpriced, 'import', NOW);
    expect(ai.requestProfile).not.toHaveBeenCalled();
  });

  it('does not wait for the profile request, and survives its failure', async () => {
    let settle: (value: unknown) => void = () => {};
    const pending = { requestProfile: vi.fn(() => new Promise((resolve) => (settle = resolve))) };
    // Resolves although the request never has: the user's flow does not wait on it.
    await recordMissingTicker({ ...USER, ai: pending }, 'tiny', resolution(), 'import', NOW);
    settle({});

    const failing = { requestProfile: vi.fn(async () => Promise.reject(new Error('AI service down'))) };
    await expect(requestProfile(failing, 'TINY')).resolves.toBeUndefined();
  });
});

describe('a low-confidence topic', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records the gate and the best score it was judged by', async () => {
    await recordLowConfidence(USER, topicResolution('none'), NOW);
    expect(queries.recordOpsEvent).toHaveBeenCalledWith({
      kind: 'universe_gap_low_confidence',
      userId: 'u-1',
      detail: {
        topic: 'quantum computing',
        bestSimilarity: 0.18,
        refuseBelow: 0.23,
        confidentAbove: 0.4,
        embeddingModel: 'text-embedding-3-small',
        vectorIsSemantic: true,
      },
      dedupeKey: 'low_confidence:u-1:quantum computing:2026-10-01',
    });
  });

  it('is only a "none": weak is an answer, unavailable is not a gap in the universe', async () => {
    for (const verdict of ['confident', 'weak', 'unavailable']) {
      await recordLowConfidence(USER, topicResolution(verdict), NOW);
    }
    expect(queries.recordOpsEvent).not.toHaveBeenCalled();
  });

  it('treats spacing and case as the same question', () => {
    expect(normaliseTopic('  Quantum   Computing ')).toBe('quantum computing');
  });
});
