/**
 * The topic scan: what it sends, what it stores, and what it refuses to claim.
 *
 * The database and the fan-out are substituted; the SQL was exercised by hand
 * against a real database, as recorded in the PR.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = {
  id: '00000000-0000-0000-0000-000000000001',
  timezone: 'Asia/Jerusalem',
  base_currency: 'USD',
};

const db = vi.hoisted(() => ({
  rows: [] as { topic_id: string; label: string; instrument_id: string; symbol: string }[],
  stored: [] as { subjectKind: string; subjectRef: string; kind: string }[],
}));

vi.mock('../src/db/queries.js', () => ({
  listActiveTopicInstruments: vi.fn(async () => db.rows),
  listRecentDedupeKeys: vi.fn(async () => ['topic_move:already']),
  getOrCreateUserSettings: vi.fn(async () => ({})),
  insertObservations: vi.fn(async (rows: typeof db.stored) => {
    db.stored = rows;
    return {
      created: rows.length,
      suppressed: 0,
      inserted: rows.map((row, index) => ({
        id: `obs-${index}`,
        kind: row.kind,
        severity: 'notable',
        subject_ref: row.subjectRef,
        evidence: {},
        headline: 'uranium moved -5.0% on average',
        explanation: null,
      })),
    };
  }),
}));

const fanOut = vi.hoisted(() =>
  vi.fn(async (_u: string, findings: unknown[]) => ({
    pushed: findings.length,
    deferred: 0,
    duplicate: 0,
    failed: 0,
  })),
);
vi.mock('../src/services/notifications.js', () => ({
  fanOut,
  settingsForNotification: vi.fn(() => ({})),
}));

const { backfillConfirmedInstruments, groupTopics, HISTORY_BACKFILL_DAYS, runTopicScan } =
  await import('../src/services/topicScan.js');

function observation(topicId: string) {
  return {
    kind: 'topic_move',
    severity: 'notable' as const,
    subject_ref: `topic:${topicId}`,
    as_of: '2026-09-25T20:00:00Z',
    headline: 'uranium moved -5.0% on average',
    explanation: '...',
    evidence: { topic_label: 'uranium' },
    concept_refs: ['z-score'],
    dedupe_key: `topic_move:${topicId}`,
    narration_source: 'template' as const,
    fallback_reason: 'no_provider',
  };
}

function aiReturning(observations: ReturnType<typeof observation>[], skipped = {}) {
  return {
    topicScan: vi.fn(async () => ({
      observations,
      stats: {
        topics: 2,
        topics_measured: 2 - Object.keys(skipped).length,
        instruments: 3,
        findings: observations.length,
        already_known: 0,
        narrated_by_llm: 0,
        narration_fallbacks: {},
        skipped,
      },
    })),
    backfillHistory: vi.fn(async () => ({ written: 0, already_present: 0 })),
  };
}

beforeEach(() => {
  db.rows = [
    { topic_id: 't1', label: 'uranium', instrument_id: 'i-ccj', symbol: 'CCJ' },
    { topic_id: 't1', label: 'uranium', instrument_id: 'i-nxe', symbol: 'NXE' },
    { topic_id: 't2', label: 'nuclear', instrument_id: 'i-ccj', symbol: 'CCJ' },
  ];
  db.stored = [];
  fanOut.mockClear();
});

describe('groupTopics', () => {
  it('turns adjacent rows into one topic each, keeping shared instruments in both', () => {
    expect(groupTopics(db.rows)).toEqual([
      {
        topic_id: 't1',
        label: 'uranium',
        instruments: [
          { instrument_id: 'i-ccj', symbol: 'CCJ' },
          { instrument_id: 'i-nxe', symbol: 'NXE' },
        ],
      },
      { topic_id: 't2', label: 'nuclear', instruments: [{ instrument_id: 'i-ccj', symbol: 'CCJ' }] },
    ]);
  });
});

describe('runTopicScan', () => {
  it('is null when there are no active topics, so the run is recorded as skipped', async () => {
    db.rows = [];
    const ai = aiReturning([]);
    expect(await runTopicScan(USER as never, ai as never, {} as never, 'run-1')).toBeNull();
    expect(ai.topicScan).not.toHaveBeenCalled();
  });

  it('sends the known keys and stores each finding as a topic observation', async () => {
    const ai = aiReturning([observation('t1')]);

    const result = await runTopicScan(USER as never, ai as never, {} as never, 'run-1');

    expect(ai.topicScan).toHaveBeenCalledWith(
      expect.objectContaining({ known_dedupe_keys: ['topic_move:already'] }),
      undefined,
    );
    expect(db.stored).toEqual([
      expect.objectContaining({ subjectKind: 'topic', subjectRef: 'topic:t1', kind: 'topic_move' }),
    ]);
    expect(result).toMatchObject({ created: 1, degraded: false, notified: { pushed: 1 } });
  });

  it('never offers buttons: a topic moving is not a question to approve', async () => {
    const ai = aiReturning([observation('t1')]);
    await runTopicScan(USER as never, ai as never, {} as never, 'run-1');

    const [, findings] = fanOut.mock.calls[0]!;
    expect(findings).toHaveLength(1);
    expect(findings[0]).not.toHaveProperty('proposalId');
  });

  it('is degraded when a topic could not be measured, and says which and why', async () => {
    const ai = aiReturning([], { nuclear: '1 confirmed instrument; a basket needs 2' });

    const result = await runTopicScan(USER as never, ai as never, {} as never, 'run-1');

    expect(result?.degraded).toBe(true);
    expect(result?.skipped).toEqual({ nuclear: '1 confirmed instrument; a basket needs 2' });
  });
});

describe('backfillConfirmedInstruments', () => {
  it('fetches the same window as the daily backfill', async () => {
    const ai = aiReturning([]);
    backfillConfirmedInstruments(ai as never, [{ instrument_id: 'i-ccj', symbol: 'CCJ' }]);
    await vi.waitFor(() =>
      expect(ai.backfillHistory).toHaveBeenCalledWith(
        { instruments: [{ instrument_id: 'i-ccj', symbol: 'CCJ' }], days: HISTORY_BACKFILL_DAYS },
        undefined,
      ),
    );
  });

  it('never throws into the confirm that triggered it', async () => {
    const broken = {
      backfillHistory: () => {
        throw new Error('provider down');
      },
    };
    const confirm = () =>
      backfillConfirmedInstruments(broken as never, [{ instrument_id: 'x', symbol: 'X' }]);
    expect(confirm).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
