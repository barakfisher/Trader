/**
 * Confirming a topic: which instruments carry reasons, and when a write is refused.
 *
 * The property this file exists for is that **provenance comes from the
 * resolver, never from the request**. A symbol gets a rationale, a band and
 * `held_by` only if re-resolving the label offers it. Everything else is a
 * bare `user` addition. The request cannot even carry a rationale, so these
 * tests assert what reaches the database, which is the only place a forged
 * one could land.
 *
 * The database layer is substituted, since the orchestrator suite has no
 * Postgres. The SQL and the migration's constraints were exercised by hand
 * against a real database, as recorded in the PR.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '00000000-0000-0000-0000-000000000001';
const TOPIC = '10000000-0000-0000-0000-000000000001';

const db = vi.hoisted(() => ({
  active: 0,
  topicStatus: null as 'active' | 'proposed' | null,
  duplicate: false,
  written: [] as { instrumentId: string; source: string; rationale: string | null }[],
  labels: [] as { topicId: string | null; label: string }[],
  upserted: [] as string[],
  transactions: 0,
}));

vi.mock('../src/db/queries.js', () => ({
  transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    db.transactions += 1;
    return fn({});
  }),
  lockTopicsForWrite: vi.fn(async () => db.active),
  lockTopic: vi.fn(async () => db.topicStatus),
  writeConfirmedTopic: vi.fn(async (_c: unknown, input: { topicId: string | null; label: string }) => {
    db.labels.push({ topicId: input.topicId, label: input.label });
    return db.duplicate ? { duplicate: true } : { id: input.topicId ?? TOPIC };
  }),
  upsertInstrument: vi.fn(async (input: { symbol: string }) => {
    db.upserted.push(input.symbol);
    return { id: `id-${input.symbol}`, symbol: input.symbol };
  }),
  replaceTopicInstruments: vi.fn(
    async (_c: unknown, _u: string, _t: string, rows: typeof db.written) => {
      db.written = rows;
    },
  ),
  getTopic: vi.fn(async () => ({ id: TOPIC })),
  listTopicInstruments: vi.fn(async () => []),
}));

const { MAX_ACTIVE_TOPICS, confirmTopic, normaliseSymbols } = await import('../src/services/topics.js');

function candidate(symbol: string, extra: Record<string, unknown> = {}) {
  return {
    instrument_id: `id-${symbol}`,
    symbol,
    name: symbol,
    asset_class: 'equity',
    sector: null,
    industry: null,
    similarity: 0.5,
    size_minor: null,
    size_currency: null,
    confidence: 'confident' as const,
    rationale: `${symbol} mines uranium.`,
    held_by: [{ etf: 'URA', weight: '0.2195' }],
    ...extra,
  };
}

function aiWith(offered: string[], known: Record<string, string> = {}) {
  return {
    resolveTopic: vi.fn(async () => ({
      topic: 'uranium',
      verdict: 'confident',
      interpretations: [{ label: 'Uranium', candidates: offered.map((s) => candidate(s)) }],
    })),
    // `known` maps what the user typed to the symbol a provider resolves it to.
    resolveInstrument: vi.fn(async (query: string) => {
      const symbol = known[query];
      return symbol
        ? { query, resolved: { symbol, name: symbol, asset_class: 'equity', exchange: null, currency: 'USD' } }
        : { query, resolved: null, candidates: [] };
    }),
  };
}

const confirm = (ai: ReturnType<typeof aiWith>, symbols: string[], topicId: string | null = null) =>
  confirmTopic(ai as never, { userId: USER, topicId, label: 'uranium', symbols });

beforeEach(() => {
  Object.assign(db, {
    active: 0,
    topicStatus: null,
    duplicate: false,
    written: [],
    labels: [],
    upserted: [],
    transactions: 0,
  });
});

describe('confirmTopic', () => {
  it('keeps the resolver’s reasons for a ticked suggestion', async () => {
    const outcome = await confirm(aiWith(['CCJ', 'NXE']), ['CCJ']);

    expect(outcome.ok).toBe(true);
    expect(db.written).toEqual([
      {
        instrumentId: 'id-CCJ',
        source: 'resolver',
        confidence: 'confident',
        rationale: 'CCJ mines uranium.',
        heldBy: [{ etf: 'URA', weight: '0.2195' }],
      },
    ]);
  });

  it('stores a ticker the resolver did not offer as a bare user addition', async () => {
    const ai = aiWith(['CCJ'], { BWXT: 'BWXT' });

    await confirm(ai, ['CCJ', 'BWXT']);

    expect(db.upserted).toEqual(['BWXT']);
    expect(db.written).toContainEqual({
      instrumentId: 'id-BWXT',
      source: 'user',
      confidence: null,
      rationale: null,
      heldBy: [],
    });
    // Only the addition is looked up; an offered symbol is already known.
    expect(ai.resolveInstrument).toHaveBeenCalledTimes(1);
  });

  it('treats a suggestion ticked under another spelling as the suggestion', async () => {
    await confirm(aiWith(['BRK-B'], { 'BRK.B': 'BRK-B' }), ['BRK.B']);

    expect(db.written).toHaveLength(1);
    expect(db.written[0]).toMatchObject({ instrumentId: 'id-BRK-B', source: 'resolver' });
    expect(db.upserted).toEqual([]);
  });

  it('writes nothing when any ticker is unknown, and names every one', async () => {
    const outcome = await confirm(aiWith(['CCJ']), ['CCJ', 'NOPE', 'ALSO']);

    expect(outcome).toEqual({ ok: false, reason: 'unresolved_symbols', symbols: ['NOPE', 'ALSO'] });
    expect(db.transactions).toBe(0);
    expect(db.written).toEqual([]);
  });

  it('re-resolves the label it is confirming, not one the browser was shown', async () => {
    const ai = aiWith([]);

    await confirmTopic(ai as never, {
      userId: USER,
      topicId: TOPIC,
      label: 'nuclear fuel',
      symbols: [],
    });

    expect(ai.resolveTopic).toHaveBeenCalledWith('nuclear fuel', undefined);
  });

  it('refuses a new topic at the cap', async () => {
    db.active = MAX_ACTIVE_TOPICS;

    const outcome = await confirm(aiWith(['CCJ']), ['CCJ']);

    expect(outcome).toEqual({ ok: false, reason: 'limit_reached', limit: MAX_ACTIVE_TOPICS });
    expect(db.labels).toEqual([]);
  });

  it('lets an active topic be re-confirmed at the cap, since it adds none', async () => {
    db.active = MAX_ACTIVE_TOPICS;
    db.topicStatus = 'active';

    const outcome = await confirm(aiWith(['CCJ']), ['CCJ'], TOPIC);

    expect(outcome.ok).toBe(true);
  });

  it('counts confirming a proposal against the cap, since it becomes active', async () => {
    db.active = MAX_ACTIVE_TOPICS;
    db.topicStatus = 'proposed';

    const outcome = await confirm(aiWith(['CCJ']), ['CCJ'], TOPIC);

    expect(outcome).toMatchObject({ ok: false, reason: 'limit_reached' });
  });

  it('reports a topic that is not the user’s as not found', async () => {
    const outcome = await confirm(aiWith(['CCJ']), ['CCJ'], TOPIC);

    expect(outcome).toEqual({ ok: false, reason: 'not_found' });
    expect(db.labels).toEqual([]);
  });

  it('reports a duplicate label instead of throwing', async () => {
    db.duplicate = true;

    const outcome = await confirm(aiWith(['CCJ']), ['CCJ']);

    expect(outcome).toEqual({ ok: false, reason: 'duplicate_label', label: 'uranium' });
    expect(db.written).toEqual([]);
  });
});

describe('normaliseSymbols', () => {
  it('trims, upper-cases and de-duplicates, keeping the user’s order', () => {
    expect(normaliseSymbols([' ccj', 'NXE', 'ccj ', '', '  '])).toEqual(['CCJ', 'NXE']);
  });
});
