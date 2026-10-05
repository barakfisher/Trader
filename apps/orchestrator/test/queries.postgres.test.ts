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
  /** USER's primary agent, made by the trigger on `users` (migration 0036). */
  let AGENT = '';

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
    AGENT = await queries.primaryAgentId(USER);
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
      // By privilege, not by trigger: CI runs this file as traders_app, which
      // holds INSERT and SELECT on the audit and nothing more (migration 0033).
      await expect(
        getPool().query(`UPDATE admin_audit SET action = 'rewritten' WHERE admin_user_id = $1`, [
          SEED_ADMIN,
        ]),
      ).rejects.toThrow(/permission denied for table admin_audit/);
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
      expect(rows[0]!.profile_membership).toBeNull();
    });

    it("reads a missing ticker's profile as it is now", async () => {
      const symbol = `OD${randomUUID().slice(0, 6).toUpperCase()}`;
      await queries.recordOpsEvent({
        kind: 'universe_gap_missing_ticker',
        userId: USER,
        detail: { symbol, source: 'holding' },
        dedupeKey: `missing_ticker:${USER}:${symbol}:2026-10-01`,
      });
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO instruments (symbol, asset_class) VALUES ($1, 'equity') RETURNING id`,
        [symbol],
      );
      const before = await queries.countUniverse();
      await getPool().query(
        `INSERT INTO instrument_profiles (instrument_id, description, matching_text, source, license,
                                          content_hash, size_as_of, membership)
         VALUES ($1, 'd', 'd', 'test', 'test', 'h', now(), 'on_demand')`,
        [rows[0]!.id],
      );
      try {
        const gap = (await queries.listOpsEvents('universe_gap_missing_ticker', 200)).find(
          (row) => (row.detail as { symbol?: string }).symbol === symbol,
        );
        expect(gap?.profile_membership).toBe('on_demand');
        const after = await queries.countUniverse();
        // Counted apart: the screened count the snapshot is compared with does not move.
        expect(after.on_demand).toBe(before.on_demand + 1);
        expect(after.profiles).toBe(before.profiles);
      } finally {
        await getPool().query('DELETE FROM instruments WHERE symbol = $1', [symbol]);
      }
    });
  });

  describe('the universe status', () => {
    it('counts profiles by asset class and reads the latest load back as JSON', async () => {
      const counts = await queries.countUniverse();
      for (const value of Object.values(counts)) expect(typeof value).toBe('number');
      expect(counts.equities + counts.etfs).toBeLessThanOrEqual(counts.profiles);

      await getPool().query(
        `INSERT INTO universe_loads (snapshot_as_of, source, manifest, report, loaded_at)
         VALUES ('2026-09-24T12:04:35Z', 'test', '{"counts": {"kept": 3}}', '{"members": 3}',
                 now() + interval '1 day')`,
      );
      try {
        const load = await queries.getLatestUniverseLoad();
        expect(load).toMatchObject({ source: 'test', report: { members: 3 } });
        expect(load?.manifest).toEqual({ counts: { kept: 3 } });
      } finally {
        await getPool().query(`DELETE FROM universe_loads WHERE source = 'test'`);
      }
    });
  });

  describe('claiming a rescreen', () => {
    const keys: string[] = [];
    const key = (label: string) => {
      const runKey = `universe-rescreen:test-${label}-${randomUUID()}`;
      keys.push(runKey);
      return runKey;
    };
    const claim = (runKey: string) =>
      queries.claimRun({ userId: null, agentId: null, kind: 'universe_rescreen', runKey, trigger: 'test' });

    afterAll(async () => {
      await getPool().query('DELETE FROM runs WHERE run_key = ANY($1)', [keys]);
    });

    it('belongs to no user, and a second one waits while the first is running', async () => {
      const firstKey = key('first');
      expect(await queries.runKeyExists(firstKey)).toBe(false);
      const first = await claim(firstKey);
      expect(first.claimed).toBe(true);
      expect(await queries.runKeyExists(firstKey)).toBe(true);
      // Another key - yesterday's run going past midnight - meets the index.
      const second = await claim(key('second'));
      expect(second).toMatchObject({ claimed: false, existingStatus: expect.stringMatching(/^running/) });
      await queries.finishRun(first.runId!, 'ok');
    });

    it('is reclaimed only once its heartbeat is stale, however long ago it started', async () => {
      const runKey = key('heartbeat');
      const first = await claim(runKey);
      // Started an hour ago - past STALE_RUN_MINUTES - but beating now: alive.
      await getPool().query(
        `UPDATE runs SET started_at = now() - interval '1 hour', heartbeat_at = now() WHERE id = $1`,
        [first.runId],
      );
      expect((await claim(runKey)).claimed).toBe(false);

      await getPool().query(
        `UPDATE runs SET heartbeat_at = now() - ($2 || ' minutes')::interval WHERE id = $1`,
        [first.runId, String(queries.HEARTBEAT_STALE_MINUTES + 1)],
      );
      const reclaimed = await claim(runKey);
      expect(reclaimed).toMatchObject({ claimed: true, runId: first.runId });
      const { rows } = await getPool().query<{ fresh: boolean }>(
        `SELECT heartbeat_at > now() - interval '1 minute' AS fresh FROM runs WHERE id = $1`,
        [first.runId],
      );
      expect(rows[0]!.fresh).toBe(true);
      await queries.finishRun(first.runId!, 'ok');
    });

    it("takes over from yesterday's dead rescreen instead of refusing every day after", async () => {
      // Independent task 12: a dead run's key names its own day, so only
      // another key's claim can ever find it.
      const yesterday = key('dead-yesterday');
      const dead = await claim(yesterday);
      await getPool().query(
        `UPDATE runs SET heartbeat_at = now() - ($2 || ' minutes')::interval WHERE id = $1`,
        [dead.runId, String(queries.HEARTBEAT_STALE_MINUTES + 1)],
      );
      const today = await claim(key('today'));
      expect(today.claimed).toBe(true);
      const { rows } = await getPool().query<{ status: string; stats: Record<string, unknown> }>(
        'SELECT status, stats FROM runs WHERE id = $1',
        [dead.runId],
      );
      expect(rows[0]!.status).toBe('failed');
      expect(rows[0]!.stats).toMatchObject({ supersededBy: expect.stringContaining('today') });
      await queries.finishRun(today.runId!, 'ok');
    });

    it('takes over from one that died before its first heartbeat, once it is old enough', async () => {
      const yesterday = key('never-beat');
      const dead = await claim(yesterday);
      // Never beat, started an hour ago: past STALE_RUN_MINUTES.
      await getPool().query(
        `UPDATE runs SET started_at = now() - interval '1 hour', heartbeat_at = NULL WHERE id = $1`,
        [dead.runId],
      );
      const today = await claim(key('after-never-beat'));
      expect(today.claimed).toBe(true);
      await queries.finishRun(today.runId!, 'ok');
    });

    it('leaves a live rescreen under another key alone', async () => {
      const live = await claim(key('live'));
      await getPool().query(`UPDATE runs SET heartbeat_at = now() WHERE id = $1`, [live.runId]);
      expect((await claim(key('blocked'))).claimed).toBe(false);
      const { rows } = await getPool().query<{ status: string }>(
        'SELECT status FROM runs WHERE id = $1',
        [live.runId],
      );
      expect(rows[0]!.status).toBe('running');
      await queries.finishRun(live.runId!, 'ok');
    });

    it('retries a failed rescreen under its own key, and nothing else', async () => {
      const runKey = key('retry');
      const first = await claim(runKey);
      await queries.finishRun(first.runId!, 'failed', { error: 'rate limited' });
      expect((await claim(runKey)).claimed).toBe(false);
      const retried = await queries.claimRun({
        userId: null,
        agentId: null,
        kind: 'universe_rescreen',
        runKey,
        trigger: 'test',
        retryFailed: true,
      });
      expect(retried).toMatchObject({ claimed: true, runId: first.runId });
      await queries.finishRun(first.runId!, 'ok');
      // A finished one is never claimed again, retry or not.
      const again = await queries.claimRun({
        userId: null,
        agentId: null,
        kind: 'universe_rescreen',
        runKey,
        trigger: 'test',
        retryFailed: true,
      });
      expect(again.claimed).toBe(false);
    });
  });

  describe('the LLM panel', () => {
    // Dated a day ahead so a window starting tomorrow sees only these rows,
    // whatever else the database holds.
    const TOMORROW = new Date(Date.now() + 12 * 60 * 60 * 1000);
    // Their own user: a future-dated observation would be USER's "latest" in every later test.
    const LLM_USER = randomUUID();

    beforeAll(async () => {
      await getPool().query('INSERT INTO users (id) VALUES ($1)', [LLM_USER]);
      await getPool().query(
        `INSERT INTO llm_calls (user_id, agent, provider, model, outcome, verdict, latency_ms,
                                prompt_tokens, completion_tokens, cost_micro_usd, prompt, completion,
                                started_at)
         VALUES ($1, 'narration', 'openrouter', 'm:free', 'ok', 'accepted', 100, 10, 20, 0, 'p', 'c',
                 now() + interval '1 day'),
                ($1, 'narration', 'openrouter', 'm:free', 'ok', 'accepted', 300, 10, 20, 0, 'p', 'c',
                 now() + interval '1 day'),
                ($1, 'narration', 'openrouter', 'm:free', 'provider_error', NULL, 900, 0, 0, 0, 'p',
                 NULL, now() + interval '1 day'),
                ($1, 'narration', 'none', NULL, 'no_provider', NULL, 0, 0, 0, 0, 'p', NULL,
                 now() + interval '1 day'),
                ($1, 'ask', 'openrouter', 'paid', 'ok', NULL, 50, 5, 5, 3000000000, 'p', 'c',
                 now() + interval '1 day')`,
        [LLM_USER],
      );
      await getPool().query(
        `INSERT INTO observations (user_id, agent_id, kind, subject_ref, headline, dedupe_key,
                                   narration_source, fallback_reason, created_at)
         VALUES ($1, (SELECT id FROM agents WHERE user_id = $1 AND is_primary), 'price_move', 'X', 'h', $2, 'llm', 'none', now() + interval '1 day'),
                ($1, (SELECT id FROM agents WHERE user_id = $1 AND is_primary), 'price_move', 'X', 'h', $3, 'template', 'provider_error', now() + interval '1 day')`,
        [LLM_USER, `llm-panel-1-${LLM_USER}`, `llm-panel-2-${LLM_USER}`],
      );
    });

    afterAll(async () => {
      await getPool().query('DELETE FROM users WHERE id = $1', [LLM_USER]);
    });

    it('groups calls with sums that survive past 32 bits', async () => {
      const groups = await queries.groupLlmCalls(TOMORROW);
      expect(groups.find((row) => row.agent === 'ask')).toMatchObject({
        calls: 1,
        cost_micro_usd: '3000000000',
      });
      const accepted = groups.find((row) => row.verdict === 'accepted');
      expect(accepted).toMatchObject({ calls: 2, prompt_tokens: '20', completion_tokens: '40' });
    });

    it('takes latency percentiles over calls that reached a provider only', async () => {
      const narration = (await queries.llmLatencies(TOMORROW)).find((row) => row.agent === 'narration');
      // 100, 300, 900 - the no_provider call's 0 is not among them.
      expect(narration).toEqual({ agent: 'narration', sample: 3, p50_ms: 300, p95_ms: 900 });
    });

    it('lists calls without their prompt or completion, and counts fallbacks', async () => {
      const recent = (await queries.listLlmCalls(20)).filter((row) => row.model === 'm:free');
      expect(recent.length).toBeGreaterThanOrEqual(3);
      expect(Object.keys(recent[0]!)).not.toContain('prompt');
      expect(Object.keys(recent[0]!)).not.toContain('completion');
      expect(await queries.firstLlmCallAt()).toBeInstanceOf(Date);

      const fallbacks = await queries.countNarrationFallbacks(TOMORROW);
      expect(fallbacks).toEqual(
        expect.arrayContaining([
          { fallback_reason: 'none', count: 1 },
          { fallback_reason: 'provider_error', count: 1 },
        ]),
      );
    });
  });

  describe('agent scope (Stage 1, PR 2)', () => {
    it("never shows a simulated agent's rows as the real portfolio's, or the reverse", async () => {
      const pool = getPool();
      const simulated = (
        await pool.query(
          `INSERT INTO agents (user_id, slug, name, budget_minor)
           VALUES ($1, 'scope-test', 'Scope test', 100000) RETURNING id`,
          [USER],
        )
      ).rows[0].id as string;
      const [real, paper] = (
        await pool.query(
          `INSERT INTO instruments (symbol, asset_class)
           VALUES ($1, 'equity'), ($2, 'equity') RETURNING id`,
          [`REAL${randomUUID().slice(0, 6)}`, `PAPR${randomUUID().slice(0, 6)}`],
        )
      ).rows.map((row) => row.id as string);
      const holding = (agentId: string, instrumentId: string) =>
        queries.upsertHolding({
          userId: USER,
          agentId,
          instrumentId: instrumentId!,
          quantity: '1',
          costBasisMinor: null,
          currency: 'USD',
          openedAt: null,
          notes: null,
        });
      await holding(AGENT, real!);
      await holding(simulated, paper!);
      const finding = (agentId: string, dedupeKey: string) => ({
        userId: USER,
        agentId,
        runId: null,
        kind: 'price_move',
        severity: 'info',
        subjectKind: 'instrument',
        subjectRef: 'instrument:SCOPE',
        headline: 'h',
        explanation: 'e',
        evidence: {},
        conceptRefs: [],
        dedupeKey,
        narrationSource: null,
        fallbackReason: null,
        localized: {},
      });
      const realKey = `scope-real-${randomUUID()}`;
      const paperKey = `scope-paper-${randomUUID()}`;
      await queries.insertObservations([finding(AGENT, realKey), finding(simulated, paperKey)]);

      const symbolsOf = async (agentId: string) =>
        (await queries.listHoldings(USER, agentId)).map((row) => row.instrument_id);
      expect(await symbolsOf(AGENT)).toContain(real);
      expect(await symbolsOf(AGENT)).not.toContain(paper);
      expect(await symbolsOf(simulated)).toEqual([paper]);

      expect(await queries.listRecentDedupeKeys(USER, AGENT)).toContain(realKey);
      expect(await queries.listRecentDedupeKeys(USER, AGENT)).not.toContain(paperKey);
      expect(await queries.listRecentDedupeKeys(USER, simulated)).toEqual([paperKey]);

      await pool.query('DELETE FROM observations WHERE agent_id = $1', [simulated]);
      await pool.query('DELETE FROM holdings WHERE agent_id = $1', [simulated]);
      await pool.query('DELETE FROM agents WHERE id = $1', [simulated]);
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
          agentId: AGENT,
          asOf: '2026-09-14',
          totalMinor: 7259674,
          costMinor: 5881582,
          currency: 'USD',
          breakdown: {},
          holdingsCount: 10,
          pricedCount: 10,
          degraded: false,
        });
        const [row] = await queries.listSnapshots(USER, AGENT, 1);
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
        agentId: AGENT,
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
        agentId: AGENT,
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
        localized: { he: { headline: '\u2066TEST\u2069 זז', explanation: '\u2066TEST\u2069 זז.' } },
      };
      const first = await queries.insertObservations([observation]);
      const second = await queries.insertObservations([observation]);
      expect(first).toMatchObject({ created: 1, suppressed: 0 });
      expect(second).toMatchObject({ created: 0, suppressed: 1 });

      const recent = await queries.listRecentNarrationProvenance(USER, 3);
      expect(recent[0]).toEqual({ narration_source: 'template', fallback_reason: 'no_provider' });

      // The translations come back as they went in, isolates included.
      const [stored] = await queries.listObservations(USER, AGENT, 1);
      expect(stored!.localized).toEqual(observation.localized);
    });
  });

  describe('proposal episodes (decision 92)', () => {
    it('holds one open episode per subject, and reopens it only after closing', async () => {
      const { inserted } = await queries.insertObservations([
        {
          userId: USER,
          agentId: AGENT,
          runId: null,
          kind: 'allocation_drift',
          severity: 'high',
          subjectKind: 'portfolio',
          subjectRef: 'portfolio:allocation:EPI',
          headline: 'EPI drifted',
          explanation: 'EPI drifted.',
          evidence: { drift: '0.150619' },
          conceptRefs: [],
          dedupeKey: `test-${randomUUID()}`,
          narrationSource: 'template',
          fallbackReason: 'no_provider',
          localized: {},
        },
      ]);
      const episode = {
        userId: USER,
        observationKind: 'allocation_drift',
        subjectRef: 'portfolio:allocation:EPI',
        observationId: inserted[0]!.id,
        askedMagnitude: '0.150619',
      };

      const first = await queries.claimEpisode(episode);
      expect(first).not.toBeNull();
      expect(await queries.claimEpisode(episode)).toBeNull();
      expect(await queries.listOpenEpisodes(USER, AGENT, 'allocation_drift')).toEqual([
        { id: first, subject_ref: 'portfolio:allocation:EPI', asked_magnitude: '0.150619000000000000' },
      ]);

      expect(await queries.closeEpisodes(USER, [first!], 'worsened')).toBe(1);
      expect(await queries.closeEpisodes(USER, [first!], 'resolved')).toBe(0);
      expect(await queries.claimEpisode(episode)).not.toBeNull();
    });
  });
  describe('a holding page', () => {
    it("reads one holding's findings under both subject formats, and the whole feed without one", async () => {
      const insert = (ref: string, kind: string) =>
        getPool().query(
          `INSERT INTO observations (user_id, agent_id, kind, subject_kind, subject_ref, headline, dedupe_key)
           VALUES ($1, (SELECT id FROM agents WHERE user_id = $1 AND is_primary), $2, 'instrument', $3, 'h', $4)`,
          [USER, kind, ref, randomUUID()],
        );
      await insert('instrument:NVDA', 'price_move');
      await insert('portfolio:allocation:NVDA', 'allocation_drift');
      await insert('instrument:NVDAX', 'price_move');
      await insert('instrument:SMR', 'drawdown');

      const nvda = await queries.listObservations(USER, AGENT, 50, {
        subjectRefs: ['instrument:NVDA', 'portfolio:allocation:NVDA'],
      });
      expect(nvda.map((row) => row.subject_ref).sort()).toEqual([
        'instrument:NVDA',
        'portfolio:allocation:NVDA',
      ]);
      // The untyped null is what a driver and a planner can disagree about.
      // (An earlier test in this file left a finding too; only the superset matters.)
      const all = (await queries.listObservations(USER, AGENT, 50)).map((row) => row.subject_ref);
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
        `INSERT INTO holdings (id, user_id, agent_id, instrument_id, quantity, currency)
         VALUES ($1, $2, (SELECT id FROM agents WHERE user_id = $2 AND is_primary), $3, 1, 'USD')`,
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

      const page = await queries.listHoldingArticles(USER, AGENT, holding, 7, 2);
      expect(page.map((row) => row.id)).toEqual([newest, original]);
      expect(page[0]?.total).toBe('3');
      expect(await queries.listHoldingArticles(randomUUID(), AGENT, holding, 7, 2)).toEqual([]);

      await pool.query('DELETE FROM holdings WHERE id = $1', [holding]);
      // Instruments cascade to their links; the articles themselves are shared data.
      await pool.query('DELETE FROM instruments WHERE id = ANY($1::uuid[])', [[instrument, other]]);
    });
  });
  describe('leftover proposal workflows (task 14)', () => {
    it('lists runs still suspended on a decided proposal, and nothing else', async () => {
      const pool = getPool();
      const runIds: string[] = [];
      const proposalWithRun = async (state: string, workflowStatus: string) => {
        const observationId = (
          await pool.query(
            `INSERT INTO observations (user_id, agent_id, kind, subject_ref, headline, dedupe_key)
             VALUES ($1, (SELECT id FROM agents WHERE user_id = $1 AND is_primary), 'allocation_drift', 'portfolio:allocation:W', 'h', $2) RETURNING id`,
            [USER, randomUUID()],
          )
        ).rows[0].id as string;
        await pool.query(
          `INSERT INTO proposals (user_id, agent_id, observation_id, kind, state, expires_at, decided_at)
           VALUES ($1, (SELECT id FROM agents WHERE user_id = $1 AND is_primary), $2, 'rebalance', $3, now() + interval '1 day',
                   CASE WHEN $3 IN ('pending', 'snoozed') THEN NULL ELSE now() END)`,
          [USER, observationId, state],
        );
        // As the app role: the sweep reads and Mastra writes this table through
        // traders_app's grants on the mastra schema (migration 0033).
        await pool.query(
          `INSERT INTO mastra.mastra_workflow_snapshot
                  (workflow_name, run_id, snapshot, "createdAt", "updatedAt")
           VALUES ('proposalLifecycle', $1, jsonb_build_object('status', $2::text), now(), now())`,
          [observationId, workflowStatus],
        );
        runIds.push(observationId);
        return observationId;
      };
      const leftover = await proposalWithRun('approved', 'suspended');
      const rejected = await proposalWithRun('rejected', 'suspended');
      await proposalWithRun('pending', 'suspended'); // still waiting for its answer
      await proposalWithRun('approved', 'success'); // already ended

      const found = await queries.listLeftoverLifecycles(500);
      expect(found.filter((id) => runIds.includes(id)).sort()).toEqual([leftover, rejected].sort());

      await pool.query('DELETE FROM mastra.mastra_workflow_snapshot WHERE run_id = ANY($1)', [runIds]);
      // Proposals cascade with their observations; USER is shared with later tests.
      await pool.query('DELETE FROM observations WHERE id = ANY($1::uuid[])', [runIds]);
    });
  });

  describe('the workflow runtime', () => {
    it('reads a run as the app role, issuing no DDL', async () => {
      // CI runs this file as traders_app, which may use the mastra schema but
      // not create in it (migration 0033). With `disableInit` on the inner
      // store only, Mastra ran CREATE TABLE before every first call and this
      // read failed with "permission denied for schema mastra".
      const { PROPOSAL_LIFECYCLE_ID, proposalLifecycle } = await import(
        '../src/mastra/proposalLifecycle.js'
      );
      const { closeWorkflowRuntime, initWorkflowRuntime } = await import(
        '../src/mastra/workflowRuntime.js'
      );
      const runtime = initWorkflowRuntime({
        workflows: { [PROPOSAL_LIFECYCLE_ID]: proposalLifecycle },
      });
      try {
        const workflow = runtime.getWorkflow(PROPOSAL_LIFECYCLE_ID);
        expect(await workflow.getWorkflowRunById(randomUUID())).toBeNull();
      } finally {
        await closeWorkflowRuntime();
      }
    });
  });

  describe('the proposals history', () => {
    it('lists every terminal state, newest decision first, and nothing still open', async () => {
      const pool = getPool();
      const observation = async () =>
        (
          await pool.query(
            `INSERT INTO observations (user_id, agent_id, kind, subject_ref, headline, dedupe_key)
             VALUES ($1, (SELECT id FROM agents WHERE user_id = $1 AND is_primary), 'allocation_drift', 'portfolio:allocation:X', 'h', $2) RETURNING id`,
            [USER, randomUUID()],
          )
        ).rows[0].id as string;
      const proposal = async (state: string, decidedHoursAgo: number | null) =>
        (
          await pool.query(
            `INSERT INTO proposals (user_id, agent_id, observation_id, kind, state, expires_at, decided_at, decided_via)
             VALUES ($1, (SELECT id FROM agents WHERE user_id = $1 AND is_primary), $2, 'rebalance', $3, now() + interval '1 day',
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
      const agent = await queries.primaryAgentId(user);
      try {
        // One scan: one timestamp, microseconds included, three severities.
        const scan = '2026-09-30 07:06:52.090526+00';
        const earlier = '2026-09-29 07:06:52.090526+00';
        const insert = (severity: string, at: string) =>
          pool.query(
            `INSERT INTO observations (user_id, agent_id, kind, severity, subject_ref, headline, dedupe_key, created_at)
             VALUES ($1, (SELECT id FROM agents WHERE user_id = $1 AND is_primary), 'drawdown', $2, 'instrument:X', $2, $3, $4) RETURNING id`,
            [user, severity, randomUUID(), at],
          );
        await insert('info', scan);
        await insert('high', scan);
        await insert('notable', scan);
        await insert('high', earlier);

        const feed = await queries.listObservations(user, agent, 10);
        expect(feed.map((row) => row.severity)).toEqual(['high', 'notable', 'info', 'high']);

        const notable = await queries.listObservations(user, agent, 10, { minRank: 1 });
        expect(notable.map((row) => row.severity)).toEqual(['high', 'notable', 'high']);
        expect(await queries.countObservations(user, agent, { minRank: 1 })).toBe(3);

        // Page by page, two at a time, the same order with nothing lost or repeated.
        const first = await queries.listObservations(user, agent, 2);
        const second = await queries.listObservations(user, agent, 2, {}, first.at(-1)!.id);
        expect([...first, ...second].map((row) => row.id)).toEqual(feed.map((row) => row.id));
        // Another account's id is no cursor here.
        expect(await queries.listObservations(USER, AGENT, 2, {}, first.at(-1)!.id)).toEqual([]);
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
              `INSERT INTO observations (user_id, agent_id, kind, subject_ref, headline, dedupe_key)
               VALUES ($1, (SELECT id FROM agents WHERE user_id = $1 AND is_primary), 'drawdown', 'instrument:X', $2, $3) RETURNING id`,
              [user, headline, randomUUID()],
            )
          ).rows[0].id as string;
        const note = (ref: string, status: string, sentAt: string | null, reason = 'below_floor') =>
          pool.query(
            `INSERT INTO notifications (user_id, agent_id, channel, ref_kind, ref_id, route, reason, status,
                                        dedupe_key, sent_at)
             VALUES ($1, (SELECT id FROM agents WHERE user_id = $1 AND is_primary), 'digest', 'observation', $2, 'digest', $3, $4, $5, $6)`,
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
