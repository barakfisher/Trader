/**
 * `db/queries.ts` against a real Postgres, opt-in by `TEST_DATABASE_URL`.
 *
 * Every other orchestrator test substitutes this module, so until this file no
 * statement in it had run under a test. What is pinned here is behaviour that
 * only the database can decide: a compare-and-insert under a row lock, and
 * uniqueness doing the work of idempotency.
 *
 * Skipped, visibly, without the variable - never read from `.env`. The schema
 * must already be at head: CI's `postgres (integration)` job runs the Python
 * integration suite first, which migrates it. The database name must end in
 * `_ci` or `_test`, because rows are written and deleted.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';

// In CI a missing URL would skip this file and pass having tested nothing.
if (DATABASE_URL === '' && process.env.INTEGRATION_REQUIRED === '1') {
  throw new Error('INTEGRATION_REQUIRED=1 but TEST_DATABASE_URL is not set');
}

describe.skipIf(DATABASE_URL === '')('queries.ts against Postgres', async () => {
  const { getPool, initPool } = await import('../src/db/pool.js');
  const queries = await import('../src/db/queries.js');
  const USER = randomUUID();

  beforeAll(async () => {
    const name = new URL(DATABASE_URL).pathname.slice(1);
    if (!/_(ci|test)$/.test(name)) {
      throw new Error(`TEST_DATABASE_URL names '${name}'; it must end in _ci or _test`);
    }
    initPool(DATABASE_URL);
    const { rows } = await getPool().query(`SELECT to_regclass('narration_transitions') AS t`);
    if (rows[0]?.t === null) {
      throw new Error('the schema is not at head: run the Python integration suite first');
    }
    await getPool().query('INSERT INTO users (id) VALUES ($1)', [USER]);
  });

  afterAll(async () => {
    // `users` cascades to everything written here.
    await getPool().query('DELETE FROM users WHERE id = $1', [USER]);
    await getPool().end();
  });

  describe('listSnapshots', () => {
    it('returns the calendar date that was stored, whatever the process timezone', async () => {
      // East of UTC is where a DATE parsed to local midnight and printed in UTC
      // became the day before. Set here, so the test does not depend on the
      // machine it runs on.
      const zone = process.env.TZ;
      process.env.TZ = 'Asia/Jerusalem';
      try {
        await queries.upsertSnapshot({
          userId: USER,
          asOf: '2026-09-14',
          totalMinor: 7259674,
          costMinor: 5881582,
          currency: 'USD',
          breakdown: {},
          holdingsCount: 10,
          pricedCount: 10,
          degraded: false,
        });
        const [row] = await queries.listSnapshots(USER, 1);
        expect(row?.as_of).toBe('2026-09-14');
      } finally {
        process.env.TZ = zone;
      }
    });
  });

  describe('recordNarrationState', () => {
    it('records a baseline, ignores a repeat, and records a change', async () => {
      const baseline = await queries.recordNarrationState(USER, 'narrating', null, null);
      expect(baseline).toMatchObject({ from_state: null, to_state: 'narrating' });
      expect(await queries.recordNarrationState(USER, 'narrating', null, null)).toBeNull();
      const change = await queries.recordNarrationState(USER, 'rejected', 'unsourced_figures', null);
      expect(change).toMatchObject({ from_state: 'narrating', to_state: 'rejected' });
    });

    it('writes one row when several scans record the same change at once', async () => {
      // Without the lock on the user's row, each would read the old state and
      // insert, and each row would be announced. One burst rarely overlaps on
      // a fast machine, so the test runs many, alternating the target state so
      // every round is a genuine change.
      for (let round = 0; round < 10; round += 1) {
        const state = round % 2 === 0 ? 'exhausted' : 'unavailable';
        const results = await Promise.all(
          Array.from({ length: 12 }, () => queries.recordNarrationState(USER, state, null, null)),
        );
        expect(results.filter((row) => row !== null), `round ${round}`).toHaveLength(1);
      }
    });
  });

  describe('claimNotification', () => {
    it('claims a narration notice once, whoever asks second', async () => {
      const refId = randomUUID();
      const notice = {
        userId: USER,
        channel: 'telegram',
        refKind: 'narration',
        refId,
        route: 'push',
        reason: 'above_floor',
        status: 'pending',
        dedupeKey: `telegram:narration:${refId}`,
      };
      expect(await queries.claimNotification(notice)).not.toBeNull();
      expect(await queries.claimNotification(notice)).toBeNull();
    });
  });

  describe('insertObservations', () => {
    it('suppresses a finding the feed already holds, by dedupe key', async () => {
      const observation = {
        userId: USER,
        runId: null,
        kind: 'price_move',
        severity: 'info',
        subjectKind: 'instrument',
        subjectRef: 'instrument:TEST',
        headline: 'TEST moved',
        explanation: 'TEST moved.',
        evidence: {},
        conceptRefs: [],
        dedupeKey: `test-${randomUUID()}`,
        narrationSource: 'template',
        fallbackReason: 'no_provider',
      };
      const first = await queries.insertObservations([observation]);
      const second = await queries.insertObservations([observation]);
      expect(first).toMatchObject({ created: 1, suppressed: 0 });
      expect(second).toMatchObject({ created: 0, suppressed: 1 });

      const recent = await queries.listRecentNarrationProvenance(USER, 3);
      expect(recent[0]).toEqual({ narration_source: 'template', fallback_reason: 'no_provider' });
    });
  });
  describe('a holding page', () => {
    it("reads one holding's findings under both subject formats, and the whole feed without one", async () => {
      const insert = (ref: string, kind: string) =>
        getPool().query(
          `INSERT INTO observations (user_id, kind, subject_kind, subject_ref, headline, dedupe_key)
           VALUES ($1, $2, 'instrument', $3, 'h', $4)`,
          [USER, kind, ref, randomUUID()],
        );
      await insert('instrument:NVDA', 'price_move');
      await insert('portfolio:allocation:NVDA', 'allocation_drift');
      await insert('instrument:NVDAX', 'price_move');
      await insert('instrument:SMR', 'drawdown');

      const nvda = await queries.listObservations(USER, 50, [
        'instrument:NVDA',
        'portfolio:allocation:NVDA',
      ]);
      expect(nvda.map((row) => row.subject_ref).sort()).toEqual([
        'instrument:NVDA',
        'portfolio:allocation:NVDA',
      ]);
      // The untyped null is what a driver and a planner can disagree about.
      // (An earlier test in this file left a finding too; only the superset matters.)
      const all = (await queries.listObservations(USER, 50, null)).map((row) => row.subject_ref);
      expect(all).toEqual(
        expect.arrayContaining(['instrument:NVDA', 'instrument:NVDAX', 'instrument:SMR']),
      );
    });

    it("counts the holding's whole week while returning one page of it", async () => {
      const instrument = randomUUID();
      const other = randomUUID();
      const holding = randomUUID();
      const pool = getPool();
      await pool.query(`INSERT INTO instruments (id, symbol) VALUES ($1, $2), ($3, $4)`, [
        instrument,
        `T${instrument.slice(0, 6)}`,
        other,
        `O${other.slice(0, 6)}`,
      ]);
      await pool.query(
        `INSERT INTO holdings (id, user_id, instrument_id, quantity, currency) VALUES ($1, $2, $3, 1, 'USD')`,
        [holding, USER, instrument],
      );
      const article = async (hoursAgo: number, linkedTo: string, duplicateOf: string | null = null) => {
        const id = randomUUID();
        await pool.query(
          `INSERT INTO articles (id, url_hash, url, source, published_at, title, raw_text, content_hash, duplicate_of_id)
           VALUES ($1, $4, 'https://example.com/' || $4, 'example.com',
                   now() - ($2 || ' hours')::interval, 't', '', $4, $3)`,
          [id, String(hoursAgo), duplicateOf, id],
        );
        await pool.query(
          `INSERT INTO article_entities (article_id, entity_kind, instrument_id, match_method, salience)
           VALUES ($1, 'instrument', $2, 'cashtag', 0.9)`,
          [id, linkedTo],
        );
        return id;
      };
      const newest = await article(1, instrument);
      const original = await article(2, instrument);
      await article(3, instrument);
      await article(4, instrument, original); // a syndicated copy: not counted
      await article(5, other); // another instrument's news
      await article(24 * 8, instrument); // outside the week

      const page = await queries.listHoldingArticles(USER, holding, 7, 2);
      expect(page.map((row) => row.id)).toEqual([newest, original]);
      expect(page[0]?.total).toBe('3');
      expect(await queries.listHoldingArticles(randomUUID(), holding, 7, 2)).toEqual([]);

      await pool.query('DELETE FROM holdings WHERE id = $1', [holding]);
      // Instruments cascade to their links; the articles themselves are shared data.
      await pool.query('DELETE FROM instruments WHERE id = ANY($1::uuid[])', [[instrument, other]]);
    });
  });
});
