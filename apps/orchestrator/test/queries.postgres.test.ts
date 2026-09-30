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

  describe('the admin audit', () => {
    // Written as the seeded admin, not USER: an audit row can never be deleted
    // and neither can the admin it names, so USER's cleanup would be refused.
    const SEED_ADMIN = '00000000-0000-0000-0000-000000000001';

    it('stores the address as inet and reads it back without a prefix length', async () => {
      const requestId = randomUUID();
      await queries.insertAdminAudit({
        adminUserId: SEED_ADMIN,
        action: 'POST /admin/example',
        detail: { body: { scope: 'universe' } },
        ipAddress: '10.0.0.7',
        requestId,
      });
      const row = (await queries.listAdminAudit(100)).find((r) => r.request_id === requestId);
      expect(row).toMatchObject({
        admin_user_id: SEED_ADMIN,
        action: 'POST /admin/example',
        detail: { body: { scope: 'universe' } },
        ip_address: '10.0.0.7',
      });
    });

    it('refuses to change a row, for the role the app connects as', async () => {
      await expect(
        getPool().query(`UPDATE admin_audit SET action = 'rewritten' WHERE admin_user_id = $1`, [
          SEED_ADMIN,
        ]),
      ).rejects.toThrow(/append-only: UPDATE refused/);
    });
  });

  describe('the universe gaps', () => {
    it('counts a repeat instead of inserting it, keeping the first detail', async () => {
      const dedupeKey = `missing_ticker:${USER}:TINY:2026-10-01`;
      const event = {
        kind: 'universe_gap_missing_ticker' as const,
        userId: USER,
        detail: { symbol: 'TINY', source: 'import' },
        dedupeKey,
      };
      await queries.recordOpsEvent(event);
      await queries.recordOpsEvent({ ...event, detail: { symbol: 'TINY', source: 'holding' } });
      const rows = (await queries.listOpsEvents('universe_gap_missing_ticker', 200)).filter(
        (row) => row.user_id === USER,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ occurrences: 2, detail: { source: 'import' } });
      expect(rows[0]!.last_seen_at.getTime()).toBeGreaterThanOrEqual(rows[0]!.occurred_at.getTime());
    });
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

      const nvda = await queries.listObservations(USER, 50, {
        subjectRefs: ['instrument:NVDA', 'portfolio:allocation:NVDA'],
      });
      expect(nvda.map((row) => row.subject_ref).sort()).toEqual([
        'instrument:NVDA',
        'portfolio:allocation:NVDA',
      ]);
      // The untyped null is what a driver and a planner can disagree about.
      // (An earlier test in this file left a finding too; only the superset matters.)
      const all = (await queries.listObservations(USER, 50)).map((row) => row.subject_ref);
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
  describe('the proposals history', () => {
    it('lists every terminal state, newest decision first, and nothing still open', async () => {
      const pool = getPool();
      const observation = async () =>
        (
          await pool.query(
            `INSERT INTO observations (user_id, kind, subject_ref, headline, dedupe_key)
             VALUES ($1, 'allocation_drift', 'portfolio:allocation:X', 'h', $2) RETURNING id`,
            [USER, randomUUID()],
          )
        ).rows[0].id as string;
      const proposal = async (state: string, decidedHoursAgo: number | null) =>
        (
          await pool.query(
            `INSERT INTO proposals (user_id, observation_id, kind, state, expires_at, decided_at, decided_via)
             VALUES ($1, $2, 'rebalance', $3, now() + interval '1 day',
                     CASE WHEN $4::int IS NULL THEN NULL ELSE now() - ($4::int * interval '1 hour') END,
                     CASE WHEN $4::int IS NULL THEN NULL ELSE 'web' END)
             RETURNING id`,
            [USER, await observation(), state, decidedHoursAgo],
          )
        ).rows[0].id as string;
      const expired = await proposal('expired', 1);
      const approved = await proposal('approved', 3);
      const rejected = await proposal('rejected', 2);
      await proposal('pending', null);
      await proposal('snoozed', null);

      const history = await queries.listProposals(USER, { decided: true, limit: 10 });
      expect(history.map((row) => row.id)).toEqual([expired, rejected, approved]);
    });
  });

  describe('the feed', () => {
    it('puts a scan\'s most severe finding first, filters by severity, and pages by id', async () => {
      const pool = getPool();
      const user = randomUUID();
      await pool.query('INSERT INTO users (id) VALUES ($1)', [user]);
      try {
        // One scan: one timestamp, microseconds included, three severities.
        const scan = '2026-09-30 07:06:52.090526+00';
        const earlier = '2026-09-29 07:06:52.090526+00';
        const insert = (severity: string, at: string) =>
          pool.query(
            `INSERT INTO observations (user_id, kind, severity, subject_ref, headline, dedupe_key, created_at)
             VALUES ($1, 'drawdown', $2, 'instrument:X', $2, $3, $4) RETURNING id`,
            [user, severity, randomUUID(), at],
          );
        await insert('info', scan);
        await insert('high', scan);
        await insert('notable', scan);
        await insert('high', earlier);

        const feed = await queries.listObservations(user, 10);
        expect(feed.map((row) => row.severity)).toEqual(['high', 'notable', 'info', 'high']);

        const notable = await queries.listObservations(user, 10, { minRank: 1 });
        expect(notable.map((row) => row.severity)).toEqual(['high', 'notable', 'high']);
        expect(await queries.countObservations(user, { minRank: 1 })).toBe(3);

        // Page by page, two at a time, the same order with nothing lost or repeated.
        const first = await queries.listObservations(user, 2);
        const second = await queries.listObservations(user, 2, {}, first.at(-1)!.id);
        expect([...first, ...second].map((row) => row.id)).toEqual(feed.map((row) => row.id));
        // Another account's id is no cursor here.
        expect(await queries.listObservations(USER, 2, {}, first.at(-1)!.id)).toEqual([]);
      } finally {
        await pool.query('DELETE FROM users WHERE id = $1', [user]);
      }
    });
  });
  describe('the digest', () => {
    it('reads the pending entries, and the last delivered batch alone', async () => {
      const pool = getPool();
      const user = randomUUID();
      await pool.query('INSERT INTO users (id) VALUES ($1)', [user]);
      try {
        const finding = async (headline: string) =>
          (
            await pool.query(
              `INSERT INTO observations (user_id, kind, subject_ref, headline, dedupe_key)
               VALUES ($1, 'drawdown', 'instrument:X', $2, $3) RETURNING id`,
              [user, headline, randomUUID()],
            )
          ).rows[0].id as string;
        const note = (ref: string, status: string, sentAt: string | null, reason = 'below_floor') =>
          pool.query(
            `INSERT INTO notifications (user_id, channel, ref_kind, ref_id, route, reason, status,
                                        dedupe_key, sent_at)
             VALUES ($1, 'digest', 'observation', $2, 'digest', $3, $4, $5, $6)`,
            [user, ref, reason, status, randomUUID(), sentAt],
          );
        await note(await finding('older digest'), 'sent', '2026-09-29 05:23:07.1+00');
        await note(await finding('last digest a'), 'sent', '2026-09-30 06:45:29.300+00');
        await note(await finding('last digest b'), 'sent', '2026-09-30 06:45:29.305+00');
        await note(await finding('waiting'), 'pending', null, 'quiet_hours');

        const pending = await queries.listPendingDigestEntries(user);
        expect(pending.map((row) => [row.headline, row.reason])).toEqual([['waiting', 'quiet_hours']]);
        const last = await queries.listLastDigestEntries(user);
        expect(last.map((row) => row.headline).sort()).toEqual(['last digest a', 'last digest b']);
      } finally {
        await pool.query('DELETE FROM users WHERE id = $1', [user]);
      }
    });
  });
});
