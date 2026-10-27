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

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_AGENTS_PER_USER_CEILING, RESEARCH_ABANDONED_AFTER_MINUTES } from '@traders/shared';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';

// In CI a missing URL would skip this file and pass having tested nothing.
if (DATABASE_URL === '' && process.env.INTEGRATION_REQUIRED === '1') {
  throw new Error('INTEGRATION_REQUIRED=1 but TEST_DATABASE_URL is not set');
}

describe.skipIf(DATABASE_URL === '')('queries.ts against Postgres', async () => {
  const { getPool, initPool } = await import('../src/db/pool.js');
  const queries = await import('../src/db/queries.js');
  const { EMPTY_MANDATE } = await import('../src/http/agentMandate.js');
  const { SESSIONS_PER_USER_MAX } = await import('../src/http/sessions.js');
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
    await getPool().query("INSERT INTO users (id, status, llm_cap_micro_usd) VALUES ($1, 'active', 10000000)", [USER]);
    AGENT = await queries.primaryAgentId(USER);
  });

  afterAll(async () => {
    // `users` cascades to everything written here.
    await getPool().query('DELETE FROM users WHERE id = $1', [USER]);
    await getPool().end();
  });

  describe('the instrument directory (D324, D325)', () => {
    const SCREENED = `ZZDIR${randomUUID().slice(0, 6).toUpperCase()}`;
    const OWN = `ZZOWN${randomUUID().slice(0, 6).toUpperCase()}`;
    const ELSEWHERE = `ZZOTH${randomUUID().slice(0, 6).toUpperCase()}`;
    afterAll(async () => {
      await getPool().query('DELETE FROM holdings WHERE user_id = $1', [USER]);
      await getPool().query('DELETE FROM instrument_profiles WHERE instrument_id IN (SELECT id FROM instruments WHERE symbol = ANY($1))', [[SCREENED, OWN, ELSEWHERE]]);
      await getPool().query('DELETE FROM instruments WHERE symbol = ANY($1)', [[SCREENED, OWN, ELSEWHERE]]);
    });

    it("lists the screened universe and the user's own instruments, never another user's", async () => {
      const screened = await queries.upsertInstrument({ symbol: SCREENED, name: 'Screened', assetClass: 'etf', exchange: 'PCX' });
      await getPool().query(
        `INSERT INTO instrument_profiles
           (instrument_id, description, matching_text, source, license, content_hash, size_as_of, updated_at, membership)
         VALUES ($1, 'd', 'd', 'test', 'test', 'h', now(), now(), 'screened')`,
        [screened.id],
      );
      const own = await queries.upsertInstrument({ symbol: OWN, name: 'Own', assetClass: 'equity' });
      await getPool().query(
        `INSERT INTO holdings (user_id, agent_id, instrument_id, quantity) VALUES ($1, $2, $3, 1)`,
        [USER, AGENT, own.id],
      );
      await queries.upsertInstrument({ symbol: ELSEWHERE, name: 'Someone else added it' });

      const rows = await queries.listInstrumentDirectory(USER);
      const symbols = rows.map((row) => row.symbol);
      expect(rows.find((row) => row.symbol === SCREENED)).toEqual({
        symbol: SCREENED,
        name: 'Screened',
        asset_class: 'etf',
        exchange: 'PCX',
      });
      expect(symbols).toContain(OWN);
      expect(symbols).not.toContain(ELSEWHERE);
      expect(symbols).toEqual([...symbols].sort());
    });
  });

  describe("the real portfolio's cash (D328-D330)", () => {
    // Its own account: opening a main portfolio's cash changes what the other tests read.
    const OWNER = randomUUID();
    let PRIMARY = '';
    beforeAll(async () => {
      await getPool().query("INSERT INTO users (id, status, llm_cap_micro_usd) VALUES ($1, 'active', 0)", [OWNER]);
      PRIMARY = await queries.primaryAgentId(OWNER);
    });
    afterAll(async () => {
      // An opened ledger is history `traders_app` may not delete row by row:
      // the account's erase removes it in order, as it would for a real one (D264).
      await getPool().query("UPDATE users SET status = 'rejected' WHERE id = $1", [OWNER]);
      await getPool().query('SELECT erase_account($1)', [OWNER]);
    });

    it('opens once, moves for a named reason, and is set to a balance under the cash lock', async () => {
      const { transaction } = await import('../src/db/pool.js');
      const move = (type: 'deposit' | 'withdrawal' | 'income' | 'charge', amount: number, ceiling = 10_000) =>
        transaction((client) => queries.recordPrimaryMovement(client, OWNER, PRIMARY, type, amount, ceiling));
      const set = (balance: number) => transaction((client) => queries.setPrimaryCash(client, OWNER, PRIMARY, balance));

      expect(await queries.getPrimaryCash(OWNER, PRIMARY)).toMatchObject({ budget_minor: null, balance_minor: null });
      expect(await move('income', 100)).toBe('unopened');
      expect(await queries.openPrimaryCash(OWNER, PRIMARY, 5_000, 1_000)).toBe(true);
      expect(await queries.openPrimaryCash(OWNER, PRIMARY, 9_999, 0)).toBe(false);

      // While the opening is the only movement, a correction edits it (D342).
      expect(await set(4_000)).toBe('set');
      expect(await queries.getPrimaryCash(OWNER, PRIMARY)).toMatchObject({
        budget_minor: '4000',
        opening_holdings_cost_minor: '1000',
        balance_minor: '4000',
      });

      expect(await move('deposit', 1_000)).toBe('recorded');
      expect(await move('deposit', 9_000)).toBe('over_ceiling');
      expect(await move('income', 300)).toBe('recorded');
      expect(await move('charge', 100)).toBe('recorded');
      expect(await move('withdrawal', 500)).toBe('recorded');
      expect(await move('charge', 999_999)).toBe('insufficient_cash');
      expect(await queries.getPrimaryCash(OWNER, PRIMARY)).toMatchObject({
        budget_minor: '4500',
        balance_minor: '4700',
        income_minor: '300',
        charges_minor: '100',
      });

      // After other movements, a correction is an adjustment: the deposits stay.
      expect(await set(4_650)).toBe('set');
      expect(await queries.getPrimaryCash(OWNER, PRIMARY)).toMatchObject({ budget_minor: '4500', balance_minor: '4650' });
      const kinds = await queries.listCashTimeline(OWNER, PRIMARY);
      expect(kinds.map((row) => [row.kind, row.amount_minor])).toEqual(
        expect.arrayContaining([
          ['opening_deposit', '4000'],
          ['top_up', '1000'],
          ['income', '300'],
          ['charge', '-100'],
          ['withdrawal', '-500'],
          ['adjustment', '-50'],
        ]),
      );
      expect(await queries.sumFeesPaid(OWNER, PRIMARY)).toBe(0);
    });

    it("takes the cash row before the agent row, as a fill does, so the two never deadlock", async () => {
      const { transaction } = await import('../src/db/pool.js');
      // A fill, as `executeFill` runs it: the cash row locked, then a row whose
      // foreign key takes KEY SHARE on the agent row. Recorded in the other
      // order, the movement held the agent row and waited for the cash row,
      // while the fill held the cash row and waited for the agent row (40P01).
      const fill = await getPool().connect();
      try {
        await fill.query('BEGIN');
        await queries.lockAgentCash(fill, OWNER, PRIMARY);
        const movement = transaction((client) =>
          queries.recordPrimaryMovement(client, OWNER, PRIMARY, 'deposit', 100, 100_000_000),
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        await fill.query('SELECT 1 FROM agents WHERE id = $1 FOR KEY SHARE', [PRIMARY]);
        await fill.query('COMMIT');
        expect(await movement).toBe('recorded');
      } finally {
        fill.release();
      }
    });

    it('corrections and movements at once leave the cash equal to the sum of its movements', async () => {
      const { transaction } = await import('../src/db/pool.js');
      // Ten of each at once, every write taking the agent row before the cash
      // row (`lockPrimary`), so none can deadlock another.
      await Promise.all(
        Array.from({ length: 10 }, (_, round) => [
          transaction((client) => queries.setPrimaryCash(client, OWNER, PRIMARY, 3_000 + round)),
          transaction((client) => queries.recordPrimaryMovement(client, OWNER, PRIMARY, 'deposit', 100, 100_000_000)),
          transaction((client) => queries.recordPrimaryMovement(client, OWNER, PRIMARY, 'income', 7, 100_000_000)),
        ]).flat(),
      );
      const after = await queries.getPrimaryCash(OWNER, PRIMARY);
      const timeline = await queries.listCashTimeline(OWNER, PRIMARY);
      const total = timeline.reduce((sum, row) => sum + BigInt(row.amount_minor), 0n);
      expect(after?.balance_minor).toBe(total.toString());
    });
  });

  describe('users and passwords (D159, D160)', () => {
    it('finds a user by email whatever its case', async () => {
      const email = `${USER.slice(0, 8)}@Example.com`;
      await getPool().query('UPDATE users SET email = $2 WHERE id = $1', [USER, email]);
      const found = await queries.getUserCredentialsByEmail(email.toLowerCase());
      expect(found).toEqual({
        id: USER,
        status: 'active',
        password_hash: null,
        session_version: expect.any(Number),
        email,
        email_verified: false,
      });
      expect(await queries.getUserCredentialsByEmail(`nobody-${USER}@example.com`)).toBeNull();
    });

    it('changes a password: a new hash, the version bumped, the one-time flag cleared', async () => {
      await getPool().query('UPDATE users SET password_must_change = true WHERE id = $1', [USER]);
      const before = await queries.getUser(USER);
      const after = await queries.changePassword(USER, '$argon2id$v=19$m=19456,t=2,p=1$test');
      expect(after).toMatchObject({
        id: USER,
        status: 'active',
        password_must_change: false,
        session_version: before!.session_version + 1,
      });
      expect(await queries.getPasswordHash(USER)).toBe('$argon2id$v=19$m=19456,t=2,p=1$test');
    });

    it('records the sign-in time', async () => {
      await queries.recordSignIn(USER);
      const { rows } = await getPool().query('SELECT last_sign_in_at FROM users WHERE id = $1', [USER]);
      expect(rows[0]?.last_sign_in_at).toBeInstanceOf(Date);
    });

    it('counts the admins, as the bootstrap script checks', async () => {
      expect((await queries.adminPasswordState()).admins).toBe(1);
    });
  });

  describe("a Telegram chat's conversation with the assistant (0067, D222)", () => {
    const conversation = async (userId: string, quietFor: string) =>
      (
        await getPool().query<{ id: string }>(
          `INSERT INTO assistant_conversations (user_id, title, updated_at)
           VALUES ($1, 'Q', now() - $2::interval) RETURNING id`,
          [userId, quietFor],
        )
      ).rows[0]!.id;

    it('is the one the binding names while it is recent, and none once it is quiet or gone', async () => {
      const chat = String(Math.floor(Math.random() * 1e12) + 1e12);
      await getPool().query('INSERT INTO telegram_bindings (user_id, chat_id) VALUES ($1, $2)', [USER, chat]);
      expect(await queries.findTelegramConversation(USER, 12)).toBeNull();

      const recent = await conversation(USER, '1 hour');
      await queries.setTelegramConversation(USER, recent);
      expect(await queries.findTelegramConversation(USER, 12)).toBe(recent);
      expect(await queries.findTelegramConversation(USER, 1)).toBeNull();

      // Deleted on the Ask page: the binding forgets it rather than refusing the delete.
      expect(await queries.deleteAssistantConversation(USER, recent)).toBe(true);
      const { rows } = await getPool().query('SELECT assistant_conversation_id FROM telegram_bindings WHERE user_id = $1', [USER]);
      expect(rows[0].assistant_conversation_id).toBeNull();

      await queries.setTelegramConversation(USER, await conversation(USER, '1 hour'));
      await queries.setTelegramConversation(USER, null);
      expect(await queries.findTelegramConversation(USER, 12)).toBeNull();
      await getPool().query('DELETE FROM telegram_bindings WHERE user_id = $1', [USER]);
      // No cascade from `users` (0052); the listing test below expects USER's own.
      await getPool().query('DELETE FROM assistant_conversations WHERE user_id = $1', [USER]);
    });

    it("never finds another user's conversation, whatever the binding names", async () => {
      const other = randomUUID();
      await getPool().query("INSERT INTO users (id, status, llm_cap_micro_usd) VALUES ($1, 'active', 0)", [other]);
      try {
        const chat = String(Math.floor(Math.random() * 1e12) + 1e12);
        await getPool().query('INSERT INTO telegram_bindings (user_id, chat_id) VALUES ($1, $2)', [USER, chat]);
        await queries.setTelegramConversation(USER, await conversation(other, '1 hour'));
        expect(await queries.findTelegramConversation(USER, 12)).toBeNull();
      } finally {
        await getPool().query('DELETE FROM telegram_bindings WHERE user_id = $1', [USER]);
        await getPool().query('DELETE FROM assistant_conversations WHERE user_id = $1', [other]);
        await getPool().query('DELETE FROM users WHERE id = $1', [other]);
      }
    });
  });

  describe("the own-key month and the safety limit (D209, D250)", () => {
    it("sums the user's own-key calls since their month began, in their zone; none for the admin", async () => {
      const user = randomUUID();
      const zone = 'Pacific/Kiritimati'; // UTC+14: its month starts a day before UTC's
      await getPool().query(
        "INSERT INTO users (id, status, llm_cap_micro_usd, timezone) VALUES ($1, 'active', 0, $2)",
        [user, zone],
      );
      try {
        expect((await queries.getMonthlySpend(user))?.safety_limit_micro_usd).toBeNull();
        expect(await queries.setSafetyLimit(user, 20_000_000)).toBe(20_000_000);
        const start = `date_trunc('month', now() AT TIME ZONE '${zone}') AT TIME ZONE '${zone}'`;
        await getPool().query(
          `INSERT INTO llm_calls (user_id, purpose, provider, outcome, latency_ms, prompt, cost_micro_usd, started_at, paid_by)
           VALUES ($1, 'ask', 'openrouter', 'ok', 1, 'p', 700, ${start} - interval '1 second', 'own_key'),
                  ($1, 'ask', 'openrouter', 'ok', 1, 'p', 11, ${start}, 'own_key'),
                  ($1, 'ask', 'openrouter', 'ok', 1, 'p', 900, now(), 'installation')`,
          [user],
        );
        const { rows } = await getPool().query<{ resets: string }>(
          `SELECT to_char(date_trunc('month', now() AT TIME ZONE '${zone}') + interval '1 month', 'YYYY-MM-DD') AS resets`,
        );
        expect(await queries.getMonthlySpend(user)).toEqual({
          own_key_spent_micro_usd: '11',
          safety_limit_micro_usd: '20000000',
          resets_on: rows[0]!.resets,
        });
        expect(await queries.setSafetyLimit(user, null)).toBeNull();
        await expect(queries.setSafetyLimit(user, 0)).rejects.toThrow();
        const { rows: admins } = await getPool().query<{ id: string }>(
          "SELECT id FROM users WHERE role = 'admin' LIMIT 1",
        );
        if (admins[0]) expect(await queries.getMonthlySpend(admins[0].id)).toBeNull();
      } finally {
        await getPool().query('DELETE FROM llm_calls WHERE user_id = $1', [user]);
        await getPool().query('DELETE FROM user_settings WHERE user_id = $1', [user]);
        await getPool().query('DELETE FROM users WHERE id = $1', [user]);
      }
    });
  });

  describe('sign-up requests (0058, 0074, D156, D185, D188, D259)', () => {
    const tag = USER.slice(0, 8);
    const email = (name: string) => `${name}-${tag}@example.com`;
    let saved = { max_pending_signups: 5, signup_mode: 'approval', daily_new_accounts_limit: 20 };

    beforeAll(async () => {
      const { rows } = await getPool().query(
        'SELECT max_pending_signups, signup_mode, daily_new_accounts_limit FROM installation_settings',
      );
      saved = rows[0];
      // Approval, with room for this block's requests whatever else waits in the database.
      await getPool().query("UPDATE installation_settings SET max_pending_signups = 50, signup_mode = 'approval'");
    });

    afterAll(async () => {
      await getPool().query(
        'UPDATE installation_settings SET max_pending_signups = $1, signup_mode = $2, daily_new_accounts_limit = $3',
        [saved.max_pending_signups, saved.signup_mode, saved.daily_new_accounts_limit],
      );
      await getPool().query(`DELETE FROM users WHERE email LIKE $1`, [`%-${tag}@example.com`]);
    });

    const ask = (address: string) =>
      queries.createSignupRequest({ email: address, passwordHash: 'hash', timezone: 'Europe/London', language: 'he', legalVersion: null });
    const verified = (userId: string) => getPool().query('UPDATE users SET email_verified_at = now() WHERE id = $1', [userId]);

    it('writes an unverified pending user with no agent and no cap, its settings in the language asked in', async () => {
      const created = await ask(email('noa'));
      expect(created.outcome).toBe('created');
      const userId = (created as { userId: string }).userId;
      const { rows } = await getPool().query(
        `SELECT u.status, u.llm_cap_micro_usd, u.timezone, s.language, u.email_verified_at,
                (SELECT count(*)::int FROM agents a WHERE a.user_id = u.id) AS agents
           FROM users u JOIN user_settings s ON s.user_id = u.id WHERE u.id = $1`,
        [userId],
      );
      expect(rows[0]).toEqual({
        status: 'pending',
        llm_cap_micro_usd: null,
        timezone: 'Europe/London',
        language: 'he',
        email_verified_at: null,
        agents: 0,
      });
    });

    it('writes nothing for an email that already asked, whatever its case, and says what it is (D303)', async () => {
      const existing = await ask(email('NOA').replace('NOA', 'Noa'));
      expect(existing).toMatchObject({ outcome: 'exists', status: 'pending', verified: false, language: 'he' });
    });

    it('keeps an unverified request from the admin, and from the waiting limit (D259)', async () => {
      const created = (await ask(email('hidden'))) as { userId: string };
      const before = await queries.countPendingSignups();
      expect((await queries.listSignupRequests()).pending.map((row) => row.user_id)).not.toContain(created.userId);
      expect(await queries.approveSignup(created.userId, 0, USER)).toMatchObject({ applied: false, status: 'pending' });
      await verified(created.userId);
      expect(await queries.countPendingSignups()).toBe(before + 1);
      expect((await queries.listSignupRequests()).pending.map((row) => row.user_id)).toContain(created.userId);
    });

    it('is closed at the limit of verified requests, open below it, and closed outright when the mode says so', async () => {
      const { rows } = await getPool().query(
        `SELECT count(*)::int AS n FROM users WHERE status = 'pending' AND email_verified_at IS NOT NULL`,
      );
      await getPool().query('UPDATE installation_settings SET max_pending_signups = $1', [rows[0].n]);
      expect(await ask(email('late'))).toEqual({ outcome: 'closed' });
      await getPool().query('UPDATE installation_settings SET max_pending_signups = $1', [rows[0].n + 1]);
      expect((await ask(email('late'))).outcome).toBe('created');
      await getPool().query("UPDATE installation_settings SET max_pending_signups = 50, signup_mode = 'closed'");
      expect(await ask(email('closed'))).toEqual({ outcome: 'closed' });
      await getPool().query("UPDATE installation_settings SET signup_mode = 'approval'");
    });

    it('approves a verified request once: the cap and approver set, the primary agent seeded; a second decision changes nothing', async () => {
      const created = (await ask(email('dana'))) as { userId: string };
      await verified(created.userId);
      expect(await queries.approveSignup(created.userId, 20_000_000, USER)).toMatchObject({ applied: true, status: 'active' });
      const { rows } = await getPool().query(
        `SELECT u.llm_cap_micro_usd::int AS cap, u.approved_by, u.approved_at IS NOT NULL AS approved,
                (SELECT count(*)::int FROM agents a WHERE a.user_id = u.id AND a.is_primary) AS primaries
           FROM users u WHERE u.id = $1`,
        [created.userId],
      );
      expect(rows[0]).toEqual({ cap: 20_000_000, approved_by: USER, approved: true, primaries: 1 });
      expect(await queries.rejectSignup(created.userId)).toMatchObject({ applied: false, status: 'active' });
      expect(await queries.approveSignup(created.userId, 5_000_000, USER)).toMatchObject({ applied: false, status: 'active' });
    });

    it('rejects, lists the rejection, and undoes it back to waiting', async () => {
      const created = (await ask(email('omer'))) as { userId: string };
      await verified(created.userId);
      expect(await queries.rejectSignup(created.userId)).toMatchObject({ applied: true, status: 'rejected' });
      expect((await queries.listSignupRequests()).rejected.map((row) => row.user_id)).toContain(created.userId);
      expect(await queries.restoreSignup(created.userId)).toMatchObject({ applied: true, status: 'pending' });
      expect((await queries.listSignupRequests()).pending.map((row) => row.user_id)).toContain(created.userId);
    });

    it('never decides an admin, and answers an unknown id as gone', async () => {
      expect(await queries.approveSignup(randomUUID(), 0, USER)).toEqual({ applied: false, status: 'gone', email: null });
    });

    describe('verification links (0074, D259, D260, D305)', async () => {
      const { linkTokenHash, newLinkToken } = await import('../src/http/linkTokens.js');
      const RULES = { defaultCapMicroUsd: 10_000_000, timezone: 'Asia/Jerusalem' };
      /** The installation's sign-up settings, read by opening a link under their lock (D310). */
      const { DAILY_NEW_ACCOUNTS_CEILING, MAX_PENDING_SIGNUPS_CEILING } = await import('@traders/shared');
      const signupSettings = (
        mode: 'automatic' | 'approval' | 'closed',
        daily = DAILY_NEW_ACCOUNTS_CEILING,
        maxPending = MAX_PENDING_SIGNUPS_CEILING,
      ) =>
        getPool().query(
          'UPDATE installation_settings SET signup_mode = $1, daily_new_accounts_limit = $2, max_pending_signups = $3',
          [mode, daily, maxPending],
        );
      let saved: { signup_mode: string; daily_new_accounts_limit: number; max_pending_signups: number };
      beforeAll(async () => {
        saved = (
          await getPool().query('SELECT signup_mode, daily_new_accounts_limit, max_pending_signups FROM installation_settings')
        ).rows[0];
      });
      beforeEach(() => signupSettings('automatic'));
      afterAll(() => signupSettings(saved.signup_mode as 'approval', saved.daily_new_accounts_limit, saved.max_pending_signups));
      /** What `ask` signs up with: a sign-up's link is opened with its password (D309). */
      const PROOF = { passwordHash: 'hash' };

      async function link(userId: string, address: string, purpose: 'verify_email' | 'verify_new_email' = 'verify_email') {
        const token = newLinkToken();
        await queries.issueAuthToken({ userId, purpose, email: address, tokenHash: linkTokenHash(token), ttlMinutes: 60 });
        return linkTokenHash(token);
      }
      const status = async (userId: string) =>
        (await getPool().query('SELECT status, email_verified_at IS NOT NULL AS verified, approved_automatically FROM users WHERE id = $1', [userId])).rows[0];

      it('lets a verified sign-up in under *automatic*, once; the second click is "used"', async () => {
        const created = (await ask(email('auto'))) as { userId: string };
        const hash = await link(created.userId, email('auto'));
        expect(await queries.useVerificationToken(hash, RULES, PROOF)).toEqual({ outcome: 'activated', userId: created.userId });
        expect(await status(created.userId)).toEqual({ status: 'active', verified: true, approved_automatically: true });
        expect(await queries.useVerificationToken(hash, RULES, PROOF)).toEqual({ outcome: 'used' });
      });

      it('keeps a verified sign-up for the admin under approval, and past the daily limit', async () => {
        const approval = (await ask(email('appr'))) as { userId: string };
        await signupSettings('approval');
        expect(await queries.useVerificationToken(await link(approval.userId, email('appr')), RULES, PROOF)).toEqual({
          outcome: 'awaiting_approval',
          userId: approval.userId,
        });
        expect(await status(approval.userId)).toMatchObject({ status: 'pending', verified: true });

        const over = (await ask(email('over'))) as { userId: string };
        await signupSettings('automatic', 0);
        expect(await queries.useVerificationToken(await link(over.userId, email('over')), RULES, PROOF)).toEqual({
          outcome: 'awaiting_approval',
          userId: over.userId,
        });
        expect(await status(over.userId)).toMatchObject({ status: 'pending', verified: true, approved_automatically: false });
      });

      it("refuses a sign-up's link without its password, or with another, and leaves it unused (D309)", async () => {
        const created = (await ask(email('proof'))) as { userId: string };
        const hash = await link(created.userId, email('proof'));
        expect(await queries.useVerificationToken(hash, RULES, null)).toEqual({ outcome: 'wrong_password' });
        expect(await queries.useVerificationToken(hash, RULES, { passwordHash: 'someone else' })).toEqual({ outcome: 'wrong_password' });
        expect(await status(created.userId)).toMatchObject({ status: 'pending', verified: false });
        expect(await queries.useVerificationToken(hash, RULES, PROOF)).toEqual({ outcome: 'activated', userId: created.userId });
      });

      it("takes the new password when an unverified request signs up again, and never a verified one's (D309)", async () => {
        const first = (await queries.createSignupRequest({
          email: email('prehijack'),
          passwordHash: 'the first',
          timezone: 'Europe/London',
          language: 'he',
          legalVersion: null,
        })) as { userId: string };
        const again = await queries.createSignupRequest({
          email: email('prehijack'),
          passwordHash: 'the owner',
          timezone: 'Asia/Jerusalem',
          language: 'en',
          legalVersion: null,
        });
        expect(again).toMatchObject({ outcome: 'exists', userId: first.userId, verified: false });
        const read = async (userId: string) =>
          (await getPool().query('SELECT password_hash, timezone FROM users WHERE id = $1', [userId])).rows[0];
        expect(await read(first.userId)).toEqual({ password_hash: 'the owner', timezone: 'Asia/Jerusalem' });
        const hash = await link(first.userId, email('prehijack'));
        expect(await queries.useVerificationToken(hash, RULES, { passwordHash: 'the first' })).toEqual({ outcome: 'wrong_password' });

        await verified(first.userId);
        await queries.createSignupRequest({ email: email('prehijack'), passwordHash: 'a third', timezone: 'UTC', language: 'en', legalVersion: null });
        expect(await read(first.userId)).toEqual({ password_hash: 'the owner', timezone: 'Asia/Jerusalem' });
      });

      it("holds approval's waiting limit when a link verifies, and refuses under closed - the link stays unused", async () => {
        const created = (await ask(email('queue'))) as { userId: string };
        const hash = await link(created.userId, email('queue'));
        const { rows } = await getPool().query(
          `SELECT count(*)::int AS n FROM users WHERE status = 'pending' AND role = 'user' AND email_verified_at IS NOT NULL`,
        );
        await signupSettings('approval', DAILY_NEW_ACCOUNTS_CEILING, rows[0].n);
        expect(await queries.useVerificationToken(hash, RULES, PROOF)).toEqual({ outcome: 'signup_full' });
        // Past automatic's daily limit a sign-up joins the same queue, under the same limit.
        await signupSettings('automatic', 0, rows[0].n);
        expect(await queries.useVerificationToken(hash, RULES, PROOF)).toEqual({ outcome: 'signup_full' });
        await signupSettings('closed');
        expect(await queries.useVerificationToken(hash, RULES, PROOF)).toEqual({ outcome: 'signup_full' });
        expect(await status(created.userId)).toMatchObject({ status: 'pending', verified: false });
        await signupSettings('approval', DAILY_NEW_ACCOUNTS_CEILING, rows[0].n + 1);
        expect(await queries.useVerificationToken(hash, RULES, PROOF)).toEqual({
          outcome: 'awaiting_approval',
          userId: created.userId,
        });
      });

      it('says expired for an old link and invalid for an unknown one, changing nothing', async () => {
        const created = (await ask(email('slow'))) as { userId: string };
        const hash = await link(created.userId, email('slow'));
        await getPool().query(
          "UPDATE auth_tokens SET created_at = now() - interval '2 days', expires_at = now() - interval '1 second' WHERE token_hash = $1",
          [hash],
        );
        expect(await queries.useVerificationToken(hash, RULES, PROOF)).toEqual({ outcome: 'expired' });
        expect(await queries.useVerificationToken(linkTokenHash('never issued'), RULES, PROOF)).toEqual({ outcome: 'invalid' });
        expect(await status(created.userId)).toMatchObject({ status: 'pending', verified: false });
      });

      it("cancels a request's earlier link when a new one is sent (D260)", async () => {
        const created = (await ask(email('twice'))) as { userId: string };
        const first = await link(created.userId, email('twice'));
        const second = await link(created.userId, email('twice'));
        expect(await queries.useVerificationToken(first, RULES, PROOF)).toEqual({ outcome: 'invalid' });
        expect((await queries.useVerificationToken(second, RULES, PROOF)).outcome).toBe('activated');
      });

      it('never treats a reset link as a verification link', async () => {
        const created = (await ask(email('reset'))) as { userId: string };
        const token = newLinkToken();
        await queries.issueAuthToken({
          userId: created.userId,
          purpose: 'reset_password',
          email: email('reset'),
          tokenHash: linkTokenHash(token),
          ttlMinutes: 60,
        });
        expect(await queries.useVerificationToken(linkTokenHash(token), RULES, PROOF)).toEqual({ outcome: 'invalid' });
        expect(await status(created.userId)).toMatchObject({ verified: false });
      });

      it('confirms a pending new address: the sign-in address changes and every session ends', async () => {
        const created = (await ask(email('mover'))) as { userId: string };
        await queries.useVerificationToken(await link(created.userId, email('mover')), RULES, PROOF);
        await queries.createSession({
          userId: created.userId,
          tokenHash: linkTokenHash(newLinkToken()),
          ttlHours: 1,
          userAgent: null,
          ipAddress: null,
          maxPerUser: SESSIONS_PER_USER_MAX,
        });
        await queries.setPendingEmail(created.userId, email('moved'));
        const result = await queries.useVerificationToken(await link(created.userId, email('moved'), 'verify_new_email'), RULES, PROOF);
        expect(result).toEqual({ outcome: 'email_changed', userId: created.userId });
        const { rows } = await getPool().query(
          `SELECT email, pending_email, (SELECT count(*)::int FROM user_sessions WHERE user_id = $1) AS sessions FROM users WHERE id = $1`,
          [created.userId],
        );
        expect(rows[0]).toEqual({ email: email('moved'), pending_email: null, sessions: 0 });
      });

      it("refuses an address change without the account's password, or for an account no longer active (D310)", async () => {
        const created = (await ask(email('changer'))) as { userId: string };
        await queries.useVerificationToken(await link(created.userId, email('changer')), RULES, PROOF);
        await queries.setPendingEmail(created.userId, email('changed'));
        const hash = await link(created.userId, email('changed'), 'verify_new_email');
        expect(await queries.useVerificationToken(hash, RULES, null)).toEqual({ outcome: 'wrong_password' });
        // A password changed since the change was asked for: the old one no longer opens it.
        expect(await queries.useVerificationToken(hash, RULES, { passwordHash: 'an older hash' })).toEqual({ outcome: 'wrong_password' });
        await getPool().query("UPDATE users SET status = 'disabled' WHERE id = $1", [created.userId]);
        expect(await queries.useVerificationToken(hash, RULES, PROOF)).toEqual({ outcome: 'invalid' });
        const { rows } = await getPool().query('SELECT email FROM users WHERE id = $1', [created.userId]);
        expect(rows[0].email).toBe(email('changer'));
      });

      it('refuses a new address another account took meanwhile, and forgets the change', async () => {
        const created = (await ask(email('late-mover'))) as { userId: string };
        await queries.useVerificationToken(await link(created.userId, email('late-mover')), RULES, PROOF);
        await queries.setPendingEmail(created.userId, email('noa'));
        const result = await queries.useVerificationToken(await link(created.userId, email('noa'), 'verify_new_email'), RULES, PROOF);
        expect(result).toEqual({ outcome: 'email_taken' });
        const { rows } = await getPool().query('SELECT pending_email FROM users WHERE id = $1', [created.userId]);
        expect(rows[0].pending_email).toBeNull();
      });

      describe('reset links (D260, D312)', () => {
        async function resetLink(userId: string, address: string) {
          const token = newLinkToken();
          await queries.issueAuthToken({ userId, purpose: 'reset_password', email: address, tokenHash: linkTokenHash(token), ttlMinutes: 30 });
          return linkTokenHash(token);
        }
        const activeAccount = async (name: string) => {
          const created = (await ask(email(name))) as { userId: string };
          await getPool().query("UPDATE users SET status = 'active', email_verified_at = now(), llm_cap_micro_usd = 0 WHERE id = $1", [
            created.userId,
          ]);
          return created.userId;
        };

        it('mails only an active account with a proven address, whatever the case typed', async () => {
          const active = await activeAccount('reset-active');
          expect(await queries.getResetRecipient(email('reset-active').toUpperCase())).toMatchObject({ id: active, language: 'he' });
          const unverified = (await ask(email('reset-pending'))) as { userId: string };
          expect(await queries.getResetRecipient(email('reset-pending'))).toBeNull();
          await getPool().query("UPDATE users SET status = 'disabled' WHERE id = $1", [active]);
          expect(await queries.getResetRecipient(email('reset-active'))).toBeNull();
          expect(await queries.getResetRecipient(email('reset-nobody'))).toBeNull();
          expect(unverified.userId).toBeTruthy();
        });

        it('sets the password once, clears "must change", and ends every session', async () => {
          const userId = await activeAccount('reset-once');
          await getPool().query('UPDATE users SET password_must_change = true WHERE id = $1', [userId]);
          await queries.createSession({
            userId,
            tokenHash: linkTokenHash(newLinkToken()),
            ttlHours: 1,
            userAgent: null,
            ipAddress: null,
            maxPerUser: SESSIONS_PER_USER_MAX,
          });
          // A change of address someone asked for: a reset ends it, link and all (D310, D312).
          await queries.setPendingEmail(userId, email('reset-elsewhere'));
          await link(userId, email('reset-elsewhere'), 'verify_new_email');
          const hash = await resetLink(userId, email('reset-once'));
          expect(await queries.useResetToken(hash, null)).toEqual({ outcome: 'invalid' });
          expect(await queries.useResetToken(hash, 'the new hash')).toEqual({ outcome: 'reset', userId, email: email('reset-once') });
          const pending = await getPool().query(
            `SELECT pending_email, (SELECT count(*)::int FROM auth_tokens WHERE user_id = $1 AND purpose = 'verify_new_email') AS links
               FROM users WHERE id = $1`,
            [userId],
          );
          expect(pending.rows[0]).toEqual({ pending_email: null, links: 0 });
          const { rows } = await getPool().query(
            `SELECT password_hash, password_must_change, session_version,
                    (SELECT count(*)::int FROM user_sessions WHERE user_id = $1) AS sessions
               FROM users WHERE id = $1`,
            [userId],
          );
          expect(rows[0]).toMatchObject({ password_hash: 'the new hash', password_must_change: false, sessions: 0 });
          expect(await queries.useResetToken(hash, 'another hash')).toEqual({ outcome: 'used' });
        });

        it('never mails or resets the admin, and unbinds Telegram and providers on a reset (D313, D315)', async () => {
          const userId = await activeAccount('reset-admin');
          await getPool().query("UPDATE users SET role = 'admin' WHERE id = $1", [userId]);
          expect(await queries.getResetRecipient(email('reset-admin'))).toBeNull();
          const adminLink = await resetLink(userId, email('reset-admin'));
          expect(await queries.useResetToken(adminLink, 'x')).toEqual({ outcome: 'invalid' });
          await getPool().query("UPDATE users SET role = 'user' WHERE id = $1", [userId]);

          await getPool().query('INSERT INTO telegram_bindings (user_id, chat_id) VALUES ($1, $2)', [userId, 990000000 + Math.floor(Math.random() * 1_000_000)]);
          // And a provider linked from a stolen session goes too (D315).
          await queries.linkIdentity({ userId, provider: 'github', subject: `sub-${randomUUID()}`, email: null });
          expect((await queries.useResetToken(await resetLink(userId, email('reset-admin')), 'new')).outcome).toBe('reset');
          const { rows } = await getPool().query(
            `SELECT (SELECT count(*)::int FROM telegram_bindings WHERE user_id = $1) AS bindings,
                    (SELECT count(*)::int FROM user_identities WHERE user_id = $1) AS identities`,
            [userId],
          );
          expect(rows[0]).toEqual({ bindings: 0, identities: 0 });
        });

        it('refuses an expired link, a verification link, and an account no longer active or at that address', async () => {
          const userId = await activeAccount('reset-refused');
          const expired = await resetLink(userId, email('reset-refused'));
          await getPool().query("UPDATE auth_tokens SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 second' WHERE token_hash = $1", [
            expired,
          ]);
          expect(await queries.useResetToken(expired, 'x')).toEqual({ outcome: 'expired' });
          expect(await queries.useResetToken(await link(userId, email('reset-refused')), 'x')).toEqual({ outcome: 'invalid' });
          const moved = await resetLink(userId, email('reset-refused'));
          await getPool().query('UPDATE users SET email = $2 WHERE id = $1', [userId, email('reset-moved')]);
          expect(await queries.useResetToken(moved, 'x')).toEqual({ outcome: 'invalid' });
          const { rows } = await getPool().query('SELECT password_hash FROM users WHERE id = $1', [userId]);
          expect(rows[0].password_hash).toBe('hash');
        });
      });

      describe('provider identities (0075, D262, D263, D314)', () => {
        const sub = () => `sub-${randomUUID()}`;

        it('opens a verified account with no password, linked to the identity, by the rules', async () => {
          const subject = sub();
          const created = await queries.createOAuthAccount(
            { email: email('oauth-new'), provider: 'google', subject, timezone: 'Europe/London', language: 'he' },
            RULES,
          );
          expect(created).toMatchObject({ outcome: 'activated' });
          const userId = (created as { userId: string }).userId;
          expect(await status(userId)).toEqual({ status: 'active', verified: true, approved_automatically: true });
          const { rows } = await getPool().query('SELECT password_hash FROM users WHERE id = $1', [userId]);
          expect(rows[0].password_hash).toBeNull();
          expect(await queries.getIdentityUser('google', subject)).toEqual({ user_id: userId, status: 'active' });
          expect(
            await queries.createOAuthAccount(
              { email: email('oauth-new'), provider: 'github', subject: sub(), timezone: 'UTC', language: 'en' },
              RULES,
            ),
          ).toEqual({ outcome: 'exists' });
        });

        it('leaves nothing behind when sign-up is closed', async () => {
          await signupSettings('closed');
          const subject = sub();
          expect(
            await queries.createOAuthAccount({ email: email('oauth-closed'), provider: 'google', subject, timezone: 'UTC', language: 'en' }, RULES),
          ).toEqual({ outcome: 'signup_full' });
          expect(await queries.getAccountByEmail(email('oauth-closed'))).toBeNull();
          expect(await queries.getIdentityUser('google', subject)).toBeNull();
        });

        it("claims an unverified request at the vouched address and drops the first sign-up's password", async () => {
          const created = (await ask(email('oauth-claim'))) as { userId: string };
          const pending = await link(created.userId, email('oauth-claim'));
          const subject = sub();
          expect(await queries.claimUnverifiedRequest({ userId: created.userId, provider: 'google', subject, email: email('oauth-claim') }, RULES)).toBe(
            'activated',
          );
          const { rows } = await getPool().query('SELECT password_hash FROM users WHERE id = $1', [created.userId]);
          expect(rows[0].password_hash).toBeNull();
          // Its old link is gone: the first sign-up's password can never verify it now.
          expect(await queries.useVerificationToken(pending, RULES, PROOF)).toEqual({ outcome: 'invalid' });
          expect(await queries.getIdentityUser('google', subject)).toMatchObject({ user_id: created.userId });
        });

        it('links one identity to one account, and one of each provider to an account', async () => {
          const first = (await ask(email('oauth-a'))) as { userId: string };
          const second = (await ask(email('oauth-b'))) as { userId: string };
          const subject = sub();
          expect(await queries.linkIdentity({ userId: first.userId, provider: 'github', subject, email: null })).toBe('linked');
          expect(await queries.linkIdentity({ userId: second.userId, provider: 'github', subject, email: null })).toBe('taken');
          expect(await queries.linkIdentity({ userId: first.userId, provider: 'github', subject: sub(), email: null })).toBe('already_linked');
        });

        it("refuses to unlink an account's only way in, and unlinks when a password or another provider remains", async () => {
          const created = await queries.createOAuthAccount(
            { email: email('oauth-only'), provider: 'google', subject: sub(), timezone: 'UTC', language: 'en' },
            RULES,
          );
          const userId = (created as { userId: string }).userId;
          expect(await queries.unlinkIdentity(userId, 'google')).toBe('last_method');
          expect(await queries.unlinkIdentity(userId, 'github')).toBe('not_linked');
          await queries.linkIdentity({ userId, provider: 'github', subject: sub(), email: null });
          expect(await queries.unlinkIdentity(userId, 'google')).toBe('unlinked');
          expect((await queries.listIdentities(userId)).map((row) => row.provider)).toEqual(['github']);
        });
      });

      it('sweeps unverified sign-ups past their window, never a verified request or an account (D304)', async () => {
        const stale = (await ask(email('stale'))) as { userId: string };
        const waiting = (await ask(email('waiting'))) as { userId: string };
        await verified(waiting.userId);
        await getPool().query("UPDATE users SET created_at = now() - interval '30 days' WHERE id = ANY($1::uuid[])", [
          [stale.userId, waiting.userId],
        ]);
        expect(await queries.deleteStaleUnverifiedSignups(7)).toBeGreaterThanOrEqual(1);
        const { rows } = await getPool().query('SELECT id FROM users WHERE id = ANY($1::uuid[])', [[stale.userId, waiting.userId]]);
        expect(rows.map((row) => row.id)).toEqual([waiting.userId]);
      });
    });
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

  describe('the universe taxonomy (0056, D164)', () => {
    it('reads its rows with counts as numbers and a null sector kept null', async () => {
      const name = `test-${randomUUID()}`;
      await getPool().query(
        `INSERT INTO universe_taxonomy (kind, name, sector, instruments)
         VALUES ('industry', $1, 'Energy', 3), ('etf_category', $1, NULL, 2)`,
        [name],
      );
      try {
        const rows = (await queries.listTaxonomy()).filter((row) => row.name === name);
        expect(rows).toEqual([
          expect.objectContaining({ kind: 'industry', sector: 'Energy', instruments: 3 }),
          expect.objectContaining({ kind: 'etf_category', sector: null, instruments: 2 }),
        ]);
        expect(rows[0]?.updated_at).toBeInstanceOf(Date);
      } finally {
        await getPool().query('DELETE FROM universe_taxonomy WHERE name = $1', [name]);
      }
    });
  });

  describe("the mandate's universe at approval (D301)", () => {
    it('reads an instrument with its profile and what the taxonomy lists, and null for no instrument', async () => {
      const tag = randomUUID().slice(0, 6).toUpperCase();
      const [equity, etf, bare] = [`UE${tag}`, `UF${tag}`, `UB${tag}`];
      const industry = `test-industry-${tag}`;
      const category = `test-category-${tag}`;
      const { rows } = await getPool().query<{ id: string; symbol: string }>(
        `INSERT INTO instruments (symbol, asset_class)
         VALUES ($1, 'equity'), ($2, 'etf'), ($3, 'equity') RETURNING id, symbol`,
        [equity, etf, bare],
      );
      const id = (symbol: string) => rows.find((row) => row.symbol === symbol)!.id;
      try {
        await getPool().query(
          `INSERT INTO instrument_profiles (instrument_id, description, matching_text, source, license,
                                            content_hash, size_as_of, membership, sector, industry,
                                            category, market_cap_minor, size_currency)
           VALUES ($1, 'd', 'd', 'test', 'test', 'h', now(), 'on_demand', 'Technology', $3, NULL,
                   1500000000000, 'USD'),
                  ($2, 'd', 'd', 'test', 'test', 'h', now(), 'on_demand', NULL, NULL, $4, NULL, NULL)`,
          [id(equity), id(etf), industry, category],
        );
        await getPool().query(
          `INSERT INTO universe_taxonomy (kind, name, sector, instruments)
           VALUES ('industry', $1, 'Technology', 1), ('etf_category', $2, 'Technology', 1)`,
          [industry, category],
        );
        expect(await queries.getUniverseProfile(equity)).toEqual({
          asset_class: 'equity',
          sector: 'Technology',
          industry,
          category: null,
          market_cap_minor: '1500000000000',
          size_currency: 'USD',
          category_sector: null,
          industry_listed: true,
          category_listed: false,
        });
        expect(await queries.getUniverseProfile(etf)).toMatchObject({
          asset_class: 'etf',
          category,
          category_sector: 'Technology',
          industry_listed: false,
          category_listed: true,
        });
        // An instrument with no profile is read with nothing known about it, as the scan reads it.
        expect(await queries.getUniverseProfile(bare)).toMatchObject({
          asset_class: 'equity',
          sector: null,
          market_cap_minor: null,
          industry_listed: false,
        });
        expect(await queries.getUniverseProfile(`NO${tag}`)).toBeNull();
      } finally {
        await getPool().query('DELETE FROM universe_taxonomy WHERE name = ANY($1)', [[industry, category]]);
        await getPool().query('DELETE FROM instruments WHERE symbol = ANY($1)', [[equity, etf, bare]]);
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

  describe('the model choices (D43)', () => {
    it("writes a scope's choice, replaces it, and may never delete it", async () => {
      await queries.chooseLlmModel('explain', 'anthropic/claude-haiku-4.5', USER);
      await queries.chooseLlmModel('explain', 'anthropic/claude-sonnet-5.5', USER);
      const { rows } = await getPool().query(
        `SELECT model, updated_by::text AS updated_by FROM llm_model_choices WHERE scope = 'explain'`,
      );
      expect(rows).toEqual([{ model: 'anthropic/claude-sonnet-5.5', updated_by: USER }]);
      // A choice is replaced, never removed: no row means "use LLM_MODEL", which only a migration may restore.
      await expect(getPool().query(`DELETE FROM llm_model_choices`)).rejects.toThrow(/permission denied/);
    });
  });

  describe('the LLM panel', () => {
    // Dated a day ahead so a window starting tomorrow sees only these rows,
    // whatever else the database holds.
    const TOMORROW = new Date(Date.now() + 12 * 60 * 60 * 1000);
    // Their own user: a future-dated observation would be USER's "latest" in every later test.
    const LLM_USER = randomUUID();

    beforeAll(async () => {
      await getPool().query("INSERT INTO users (id, status, llm_cap_micro_usd) VALUES ($1, 'active', 10000000)", [LLM_USER]);
      await getPool().query(
        `INSERT INTO llm_calls (user_id, purpose, provider, model, outcome, verdict, latency_ms,
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
      expect(groups.find((row) => row.purpose === 'ask')).toMatchObject({
        calls: 1,
        cost_micro_usd: '3000000000',
      });
      const accepted = groups.find((row) => row.verdict === 'accepted');
      expect(accepted).toMatchObject({ calls: 2, prompt_tokens: '20', completion_tokens: '40' });
    });

    it('takes latency percentiles over calls that reached a provider only', async () => {
      const narration = (await queries.llmLatencies(TOMORROW)).find((row) => row.purpose === 'narration');
      // 100, 300, 900 - the no_provider call's 0 is not among them.
      expect(narration).toEqual({ purpose: 'narration', sample: 3, p50_ms: 300, p95_ms: 900 });
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

  describe("a scan's tool calls, for the Evidence checked line", () => {
    // Evaluated over a literal transcript rather than a stored scan: `agent_scans`
    // is append-only for the app role (0043), so a row written here would outlive
    // the user this file deletes.
    it('reads every assistant step\'s calls in order, and nothing from tool steps', async () => {
      const transcript = [
        { role: 'assistant', text: null, tool_calls: [
          { id: 'c1', name: 'get_price_history', arguments: '{"symbol":"NVDA","days":21}' },
          { id: 'c2', name: 'get_news', arguments: '{"symbol":"NVDA"}' },
        ] },
        { role: 'tool', call_id: 'c1', name: 'get_price_history', result: { closes: [] } },
        { role: 'assistant', text: null, tool_calls: [{ id: 'c3', name: 'get_position', arguments: '{}' }] },
        { role: 'assistant', text: '{"decision":"buy"}', tool_calls: [] },
      ];
      const { rows } = await getPool().query<{ calls: { name: string; arguments: string }[] }>(
        `SELECT ${queries.SCAN_TOOL_CALLS} AS calls FROM (SELECT $1::jsonb AS transcript) s`,
        [JSON.stringify(transcript)],
      );
      expect(rows[0]!.calls.map((call) => [call.name, call.arguments])).toEqual([
        ['get_price_history', '{"symbol":"NVDA","days":21}'],
        ['get_news', '{"symbol":"NVDA"}'],
        ['get_position', '{}'],
      ]);
      const empty = await getPool().query<{ calls: unknown[] }>(
        `SELECT ${queries.SCAN_TOOL_CALLS} AS calls FROM (SELECT '[]'::jsonb AS transcript) s`,
      );
      expect(empty.rows[0]!.calls).toEqual([]);
    });

    it('runs the proposal read with its scan join, and reads an unknown scan as no calls', async () => {
      const row = await queries.findProposal(USER, randomUUID());
      expect(row).toBeNull();
      expect(await queries.listScanToolCalls(USER, AGENT, randomUUID())).toEqual([]);
    });
  });

  describe('agents (Stage 2)', () => {
    it('creates, lists, renames and pauses a simulated agent, and never changes the primary', async () => {
      const agent = await queries.createAgent({
        userId: USER,
        slug: `agent-${randomUUID().slice(0, 8)}`,
        name: `Momentum ${randomUUID().slice(0, 4)}`,
        persona: 'Buys strength.',
        budgetMinor: 100050,
        currency: 'USD',
        scanSchedule: { everyHours: 2, preOpen: true, postClose: false },
        maxDecisions: 3,
        mandate: { ...EMPTY_MANDATE, max_position_bps: 1000, sectors: ['Energy'], blocked_symbols: ['XOM'] },
        state: 'active',
      });
      expect(agent).toMatchObject({ is_primary: false, budget_minor: '100050', state: 'active', holdings_count: 0 });
      // The mandate (0057) round-trips: integers as numbers, text[] as arrays.
      expect(agent).toMatchObject({
        scan_every_hours: 2,
        scan_pre_open: true,
        scan_post_close: false,
        max_decisions: 3,
        running_scan: null,
        max_position_bps: 1000,
        cash_buffer_bps: null,
        allow_etfs: true,
        sectors: ['Energy'],
        market_caps: [],
        blocked_symbols: ['XOM'],
      });
      const edited = await queries.updateAgent(USER, agent.id, { mandate: { market_caps: ['large', 'mega'], sectors: [] } });
      expect(edited).toMatchObject({ market_caps: ['large', 'mega'], sectors: [], max_position_bps: 1000 });
      // The primary has no mandate, whatever a writer asks (agents_primary_has_no_mandate).
      await expect(
        getPool().query('UPDATE agents SET max_holdings = 3 WHERE id = $1', [AGENT]),
      ).rejects.toMatchObject({ code: '23514' });

      const listed = await queries.listAgents(USER);
      expect(listed[0]).toMatchObject({ id: AGENT, is_primary: true });
      expect(listed.map((row) => row.id)).toContain(agent.id);

      const paused = await queries.updateAgent(USER, agent.id, { state: 'paused', name: `${agent.name} II` });
      expect(paused).toMatchObject({ state: 'paused', name: `${agent.name} II` });
      expect(await queries.updateAgent(USER, AGENT, { name: 'Mine' })).toBeNull();

      // The route maps this to 409 by the constraint's name, so pin the name.
      const duplicate = await queries
        .createAgent({
          userId: USER,
          slug: 'agent-dup00000',
          name: `${agent.name} II`,
          persona: null,
          budgetMinor: 1,
          currency: 'USD',
          scanSchedule: { everyHours: null, preOpen: true, postClose: false },
          maxDecisions: 1,
          mandate: EMPTY_MANDATE,
          state: 'active',
        })
        .catch((error: { code?: string; constraint?: string }) => error);
      expect(duplicate).toMatchObject({ code: '23505', constraint: 'agents_user_id_name_key' });

      // The contradiction check (0059): stored as jsonb, dismissed only for its own fingerprint.
      const check = { fingerprint: 'f1', conflicts: [{ setting: 'horizon', quote: 'q' }], checked_at: '2026-10-19T08:00:00Z', dismissed: false };
      await queries.saveInstructionsCheck(USER, agent.id, check);
      await queries.dismissInstructionsCheck(USER, agent.id, 'another');
      expect((await queries.getAgent(USER, agent.id))?.instructions_check).toEqual(check);
      await queries.dismissInstructionsCheck(USER, agent.id, 'f1');
      expect((await queries.getAgent(USER, agent.id))?.instructions_check).toEqual({ ...check, dismissed: true });
      // A check's call counts against the agent's daily allowance, beside its scans (D177).
      await getPool().query(
        `INSERT INTO llm_calls (user_id, agent_id, purpose, provider, model, outcome, latency_ms, cost_micro_usd, prompt)
         VALUES ($1, $2, 'mandate_check', 'p', 'm', 'ok', 1, 1234, 'p')`,
        [USER, agent.id],
      );
      expect((await queries.getAgent(USER, agent.id))?.llm_spent_today_micro_usd).toBe('1234');
      await getPool().query('DELETE FROM llm_calls WHERE agent_id = $1', [agent.id]);

      await getPool().query('DELETE FROM agents WHERE id = $1', [agent.id]);
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

  describe('the Insights window (0051, decision 133)', () => {
    it("counts a day's findings in the user's timezone, and the unread among them", async () => {
      const pool = getPool();
      const at = async (createdAt: string) =>
        pool.query(
          `INSERT INTO observations (user_id, agent_id, kind, severity, subject_ref, headline,
                                     dedupe_key, created_at)
           VALUES ($1, $2, 'price_move', 'info', 'instrument:WIN', 'h', $3, $4)`,
          [USER, AGENT, `window-${randomUUID()}`, createdAt],
        );
      // 22:30 UTC on the 1st is the 2nd in Jerusalem; 10:00 UTC on the 2nd is the 2nd too.
      await at('2026-09-01T22:30:00Z');
      await at('2026-09-02T10:00:00Z');
      await at('2026-09-01T08:00:00Z');

      const rows = await queries.countObservationsByDay(
        USER,
        AGENT,
        'Asia/Jerusalem',
        '2026-09-01',
        new Date('2026-09-02T00:00:00Z'),
      );
      const byDay = Object.fromEntries(rows.map((row) => [row.day, row]));
      expect(byDay['2026-09-01']).toMatchObject({ count: 1, unread: 0 });
      expect(byDay['2026-09-02']).toMatchObject({ count: 2, unread: 1 });

      const filtered = await queries.listObservations(USER, AGENT, 50, {
        day: { date: '2026-09-02', timezone: 'Asia/Jerusalem' },
      });
      expect(filtered.filter((row) => row.subject_ref === 'instrument:WIN')).toHaveLength(2);

      await pool.query('DELETE FROM observations WHERE user_id = $1 AND dedupe_key LIKE $2', [
        USER,
        'window-%',
      ]);
    });

    it('moves seen only forward, and never past now', async () => {
      const first = await queries.markInsightsSeen(USER, new Date('2026-09-02T00:00:00Z'));
      expect(first?.toISOString()).toBe('2026-09-02T00:00:00.000Z');
      const stale = await queries.markInsightsSeen(USER, new Date('2026-09-01T00:00:00Z'));
      expect(stale?.toISOString()).toBe('2026-09-02T00:00:00.000Z');
      const future = await queries.markInsightsSeen(USER, new Date('2999-01-01T00:00:00Z'));
      expect(future!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      expect(await queries.getInsightsSeenAt(USER)).toEqual(future);
    });
  });

  describe('alerts (decision 134)', () => {
    it('lists what was pushed or deferred, by source, and nothing that only waited for the digest', async () => {
      const pool = getPool();
      const agent = (
        await pool.query(
          `INSERT INTO agents (user_id, slug, name, budget_minor)
           VALUES ($1, 'alerts-test', 'Alerts test', 100000) RETURNING id`,
          [USER],
        )
      ).rows[0].id as string;
      const observe = async (agentId: string, subjectKind: string, kind: string) =>
        (
          await pool.query(
            `INSERT INTO observations (user_id, agent_id, kind, severity, subject_kind, subject_ref,
                                       headline, dedupe_key)
             VALUES ($1, $2, $3, 'high', $4, 'instrument:ALRT', 'h', $5) RETURNING id`,
            [USER, agentId, kind, subjectKind, `alerts-${randomUUID()}`],
          )
        ).rows[0].id as string;
      const notify = (
        agentId: string,
        refId: string,
        channel: string,
        route: string,
        reason: string,
      ) =>
        pool.query(
          `INSERT INTO notifications (user_id, agent_id, channel, ref_kind, ref_id, route, reason,
                                      status, sent_at, dedupe_key)
           VALUES ($1, $2, $3, 'observation', $4, $5, $6, 'sent', now(), $7)`,
          [USER, agentId, channel, refId, route, reason, `alerts-${randomUUID()}`],
        );

      const pushed = await observe(AGENT, 'instrument', 'drawdown');
      await notify(AGENT, pushed, 'telegram', 'push', 'above_floor');
      const quiet = await observe(AGENT, 'topic', 'topic_move');
      await notify(AGENT, quiet, 'digest', 'digest', 'quiet_hours');
      const belowFloor = await observe(AGENT, 'instrument', 'price_move');
      await notify(AGENT, belowFloor, 'digest', 'digest', 'below_floor');
      await observe(AGENT, 'instrument', 'sigma_move'); // never routed anywhere
      const trade = await observe(agent, 'instrument', 'agent_trade');
      await notify(agent, trade, 'telegram', 'push', 'above_floor');

      const ids = async (source: 'portfolio' | 'topics' | 'agents' | null) =>
        (await queries.listAlerts(USER, 50, source, null)).map((row) => row.id);

      expect(await ids(null)).toEqual([trade, quiet, pushed]);
      expect(await queries.countAlerts(USER, null)).toBe(3);
      expect(await ids('portfolio')).toEqual([pushed]);
      expect(await ids('topics')).toEqual([quiet]);
      expect(await ids('agents')).toEqual([trade]);

      const [first] = await queries.listAlerts(USER, 1, null, null);
      expect(first?.agent_name).toBe('Alerts test');
      expect(first?.agent_is_primary).toBe(false);
      // The next page continues after the last alert the reader has.
      expect((await queries.listAlerts(USER, 50, null, trade)).map((row) => row.id)).toEqual([
        quiet,
        pushed,
      ]);

      await pool.query('DELETE FROM notifications WHERE user_id = $1 AND dedupe_key LIKE $2', [
        USER,
        'alerts-%',
      ]);
      await pool.query('DELETE FROM observations WHERE user_id = $1 AND dedupe_key LIKE $2', [
        USER,
        'alerts-%',
      ]);
      await pool.query('DELETE FROM agents WHERE id = $1', [agent]);
    });
  });

  describe('finding episodes (0049, decision 132)', () => {
    it('raises a band, never lowers it, and goes with its observation', async () => {
      const subjectRef = `instrument:EP${randomUUID().slice(0, 6)}`;
      const observe = async (severity: string) => {
        const { inserted } = await queries.insertObservations([
          {
            userId: USER,
            agentId: AGENT,
            runId: null,
            kind: 'drawdown',
            severity,
            subjectKind: 'instrument',
            subjectRef,
            headline: 'h',
            explanation: 'e',
            evidence: {},
            conceptRefs: [],
            dedupeKey: `episode-${randomUUID()}`,
            narrationSource: null,
            fallbackReason: null,
            localized: {},
          },
        ]);
        return inserted[0]!.id;
      };
      const record = async (severity: string) =>
        queries.recordFindingEpisode({
          userId: USER,
          agentId: AGENT,
          kind: 'drawdown',
          subjectRef,
          severity,
          observationId: await observe(severity),
        });
      const open = async () =>
        (await queries.listOpenFindingEpisodes(USER, AGENT)).filter(
          (row) => row.subject_ref === subjectRef,
        );

      await record('notable');
      await record('high');
      await record('info');

      const [episode] = await open();
      expect(episode?.severity).toBe('high');
      expect(await open()).toHaveLength(1);

      expect(await queries.closeFindingEpisodes(USER, [episode!.id])).toBe(1);
      expect(await open()).toEqual([]);

      // A reset erases observations; their episodes must not hold it up.
      await record('info');
      await getPool().query('DELETE FROM observations WHERE subject_ref = $1', [subjectRef]);
      const { rows } = await getPool().query(
        'SELECT count(*)::int AS n FROM finding_episodes WHERE subject_ref = $1',
        [subjectRef],
      );
      expect(rows[0].n).toBe(0);
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

  describe('the ledger (0040)', () => {
    // No fill is written here: fills are append-only, and one would outlive this
    // suite's cleanup of USER. The traded path is proven in test_ledger_sql.py.
    it("reads a new agent's cash as its budget, and the real portfolio as having none", async () => {
      const pool = getPool();
      const simulated = (
        await pool.query(
          `INSERT INTO agents (user_id, slug, name, budget_minor)
           VALUES ($1, 'ledger-test', 'Ledger test', 250000) RETURNING id`,
          [USER],
        )
      ).rows[0].id as string;
      expect(await queries.getAgentCash(USER, simulated)).toMatchObject({
        balance_minor: '250000',
        currency: 'USD',
      });
      expect(await queries.agentHasTraded(USER, simulated)).toBe(false);
      expect(await queries.getAgentCash(USER, AGENT)).toBeNull();

      await queries.updateAgent(USER, simulated, { budgetMinor: 300000 });
      expect((await queries.getAgentCash(USER, simulated))?.balance_minor).toBe('300000');
      await pool.query('DELETE FROM agents WHERE id = $1', [simulated]);
    });
  });

  describe('a fill and its holding (0040), rolled back', () => {
    it('writes a fill under the cash lock, moves cash and the holding, and reads it back by key', async () => {
      const pool = getPool();
      const instrument = (
        await pool.query(
          `INSERT INTO instruments (symbol, asset_class) VALUES ($1, 'equity') RETURNING id`,
          [`FILL${randomUUID().slice(0, 8)}`.toUpperCase()],
        )
      ).rows[0].id as string;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const simulated = (
          await client.query(
            `INSERT INTO agents (user_id, slug, name, budget_minor)
             VALUES ($1, 'fill-test', 'Fill test', 100000) RETURNING id`,
            [USER],
          )
        ).rows[0].id as string;
        expect(await queries.lockAgentCash(client, USER, simulated)).toBe(100000n);
        expect(await queries.lockAgentHolding(client, USER, simulated, instrument)).toBeNull();
        await queries.insertFill(client, {
          userId: USER,
          agentId: simulated,
          instrumentId: instrument,
          side: 'buy',
          quantity: 3n,
          priceMinor: 20000n,
          notionalMinor: 60000n,
          feeMinor: 150n,
          priceSource: 'quote',
          quoteAsOf: new Date().toISOString(),
          quoteDelaySeconds: 900,
          source: 'manual_user_override',
          proposalId: null,
          idempotencyKey: 'pg-key',
        });
        await queries.setAgentHolding(client, {
          userId: USER,
          agentId: simulated,
          instrumentId: instrument,
          quantity: 3n,
          costBasisMinor: 20000n,
          openedAt: '2026-10-05',
        });
        expect(await queries.lockAgentCash(client, USER, simulated)).toBe(100000n - 60150n);
        expect(await queries.lockAgentHolding(client, USER, simulated, instrument)).toMatchObject({
          quantity: '3.000000000000000000',
          cost_basis_minor: '20000',
        });
        // D299: what the mandate's size rules read, by symbol.
        const symbol = (await client.query('SELECT symbol FROM instruments WHERE id = $1', [instrument])).rows[0]
          .symbol as string;
        expect(await queries.getAgentBook(USER, simulated, symbol, client)).toEqual({
          holdings_cost_minor: '60000',
          symbol_cost_minor: '60000',
          held_count: 1,
          holds_symbol: true,
        });
        expect(await queries.getAgentBook(USER, simulated, 'NOT-HELD', client)).toEqual({
          holdings_cost_minor: '60000',
          symbol_cost_minor: '0',
          held_count: 1,
          holds_symbol: false,
        });
        expect(await queries.findFillByKey(USER, simulated, 'pg-key', client)).toMatchObject({
          side: 'buy',
          price_minor: '20000',
          price_source: 'quote',
          source: 'manual_user_override',
        });
        await queries.setAgentHolding(client, {
          userId: USER,
          agentId: simulated,
          instrumentId: instrument,
          quantity: 0n,
          costBasisMinor: 20000n,
          openedAt: '2026-10-05',
        });
        expect(await queries.lockAgentHolding(client, USER, simulated, instrument)).toBeNull();
        expect(await queries.getAgentBook(USER, simulated, symbol, client)).toEqual({
          holdings_cost_minor: '0',
          symbol_cost_minor: '0',
          held_count: 0,
          holds_symbol: false,
        });
      } finally {
        await client.query('ROLLBACK');
        client.release();
        await pool.query('DELETE FROM instruments WHERE id = $1', [instrument]);
      }
    });
  });

  describe('added cash and the timeline (D22, D31)', () => {
    it('raises the budget in one statement, stops at the ceiling and an archive, and lists the balance', async () => {
      const pool = getPool();
      const simulated = (
        await pool.query(
          `INSERT INTO agents (user_id, slug, name, budget_minor)
           VALUES ($1, 'top-up-test', 'Top-up test', 100000) RETURNING id`,
          [USER],
        )
      ).rows[0].id as string;
      try {
        expect(await queries.topUpAgent(USER, simulated, 25000, 1_000_000)).toMatchObject({ budget_minor: '125000' });
        expect((await queries.getAgentCash(USER, simulated))?.balance_minor).toBe('125000');
        expect(await queries.topUpAgent(USER, simulated, 900000, 1_000_000)).toBeNull();
        expect(await queries.topUpAgent(USER, AGENT, 100, 1_000_000)).toBeNull();
        // Before the first trade, added cash raises the opening deposit: one row.
        const timeline = await queries.listCashActivity(USER, simulated, 10);
        expect(timeline.map((row) => [row.kind, row.amount_minor, row.balance_after_minor])).toEqual([
          ['opening_deposit', '125000', '125000'],
        ]);
        await pool.query(`UPDATE agents SET state = 'archived' WHERE id = $1`, [simulated]);
        expect(await queries.topUpAgent(USER, simulated, 100, 1_000_000)).toBeNull();
        expect((await queries.getAgent(USER, simulated))?.cash_minor).toBe('125000');
      } finally {
        await pool.query('DELETE FROM agents WHERE id = $1', [simulated]);
      }
    });
  });

  describe('per-agent run keys (0037)', () => {
    it('lets two agents claim one key, and one agent claim it once', async () => {
      const pool = getPool();
      const simulated = (
        await pool.query(
          `INSERT INTO agents (user_id, slug, name, budget_minor)
           VALUES ($1, 'run-key-test', 'Run key test', 100000) RETURNING id`,
          [USER],
        )
      ).rows[0].id as string;
      const runKey = `portfolio_scan:test-${randomUUID()}`;
      const claim = (agentId: string) =>
        queries.claimRun({ userId: USER, agentId, kind: 'portfolio_scan', runKey, trigger: 'test' });
      expect((await claim(AGENT)).claimed).toBe(true);
      expect((await claim(simulated)).claimed).toBe(true);
      expect((await claim(AGENT)).claimed).toBe(false);
      await pool.query('DELETE FROM runs WHERE run_key = $1', [runKey]);
      await pool.query('DELETE FROM agents WHERE id = $1', [simulated]);
    });

    it("reports the holder's status per agent, and the installation's as its own (DB4)", async () => {
      const pool = getPool();
      const runKey = `portfolio_scan:test-${randomUUID()}`;
      // The installation's own runs have neither user nor agent (0036's runs_agent_follows_user).
      const claim = (agentId: string | null) =>
        queries.claimRun({ userId: agentId && USER, agentId, kind: 'portfolio_scan', runKey, trigger: 'test' });
      expect((await claim(null)).claimed).toBe(true);
      expect(await queries.runKeyExists(runKey)).toBe(true);
      // The agent's claim is not the installation's, though they share the key.
      expect((await claim(AGENT)).claimed).toBe(true);
      await pool.query(`UPDATE runs SET status = 'ok' WHERE run_key = $1 AND agent_id = $2`, [runKey, AGENT]);
      expect(await claim(null)).toEqual({ claimed: false, runId: null, existingStatus: 'running' });
      expect(await claim(AGENT)).toEqual({ claimed: false, runId: null, existingStatus: 'ok' });
      await pool.query('DELETE FROM runs WHERE run_key = $1', [runKey]);
      expect(await queries.runKeyExists(runKey)).toBe(false);
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
      await pool.query("INSERT INTO users (id, status, llm_cap_micro_usd) VALUES ($1, 'active', 10000000)", [user]);
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
      await pool.query("INSERT INTO users (id, status, llm_cap_micro_usd) VALUES ($1, 'active', 10000000)", [user]);
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
  describe("an agent's scans and model spend (D45, D46, D50)", () => {
    // Committed, because the queries read through the pool - and written as the
    // seeded admin, as the admin audit's rows are: traders_app may not delete a
    // scan or a ledger row, so USER's cleanup would be refused. A fresh agent
    // per run keeps a re-run on a local database independent of the last one.
    const SEED_ADMIN = '00000000-0000-0000-0000-000000000001';
    it('pages the scans with their proposal and fill, sums today, and averages the cost', async () => {
      const pool = getPool();
      const agent = (
        await pool.query(
          `INSERT INTO agents (user_id, slug, name, persona, budget_minor)
           VALUES ($1, $2, $2, 'Patient.', 100000) RETURNING id`,
          [SEED_ADMIN, `scan-read-${randomUUID().slice(0, 8)}`],
        )
      ).rows[0].id as string;
      {
        const scan = async (startedAt: string, cost: number, outcome: string, answer: unknown) =>
          (
            await pool.query(
              `INSERT INTO agent_scans (user_id, agent_id, trigger, started_at, finished_at, outcome, cost_micro_usd, briefing, transcript, answer)
               VALUES ($1, $2, 'manual', $3, $3::timestamptz + interval '10 seconds', $4, $5, '{"cash": "1000.00"}',
                       '[{"role": "assistant", "text": "hi", "tool_calls": []}]', $6)
               RETURNING id`,
              [SEED_ADMIN, agent, startedAt, outcome, cost, JSON.stringify(answer)],
            )
          ).rows[0].id as string;
        const older = await scan('2026-10-06T13:00:00Z', 20_000, 'no_trade', { decision: 'none', thesis: 'Nothing.' });
        const newer = await scan('2026-10-07T13:00:00Z', 40_000, 'trade', {
          decision: 'buy', symbol: 'INTC', quantity: '3', thesis: 'INTC fell.', price_minor: 11_250,
        });
        const propose = (symbol: string) =>
          queries.createTradeProposal({
            userId: SEED_ADMIN,
            agentId: agent,
            scanId: newer,
            kind: 'buy',
            payload: { symbol, quantity: '3', priceMinor: 11_250, priceAsOf: null, currency: 'USD' },
            expiresAt: new Date(Date.now() + 3_600_000),
            headline: `Scan read proposes to buy 3 ${symbol} at 112.50`,
            thesis: `${symbol} fell.`,
            localized: {},
            evidence: {},
          });
        const { proposalId } = await propose('INTC');
        // D197: a second trade of the same scan is its own proposal; the same one again is not (0061).
        const { proposalId: second } = await propose('AMD');
        expect(second).not.toBe(proposalId);
        expect((await propose('INTC')).proposalId).toBe(proposalId);
        // Today's calls count; yesterday's do not.
        for (const [startedAt, cost] of [[new Date(), 7_000], [new Date(Date.now() - 2 * 86_400_000), 99_000]] as const) {
          await pool.query(
            `INSERT INTO llm_calls (user_id, agent_id, purpose, provider, outcome, latency_ms, cost_micro_usd, prompt, started_at)
             VALUES ($1, $2, 'agent_scan', 'test', 'ok', 1, $3, 'p', $4)`,
            [SEED_ADMIN, agent, cost, startedAt],
          );
        }

        const page = await queries.listAgentScans(SEED_ADMIN, agent, { limit: 1 });
        expect(page.map((row) => row.id)).toEqual([newer]);
        expect(page[0]).toMatchObject({ cost_micro_usd: '40000' });
        expect(page[0]!.proposals.map((p) => [p.id, p.symbol, p.state, p.fill_id])).toEqual([
          [proposalId, 'INTC', 'pending', null],
          [second, 'AMD', 'pending', null],
        ]);
        expect(page[0]).not.toHaveProperty('transcript');
        const back = await queries.listAgentScans(SEED_ADMIN, agent, { limit: 5, before: page[0]!.started_at });
        expect(back.map((row) => row.id)).toEqual([older]);
        expect(await queries.listAgentScans(randomUUID(), agent, { limit: 5 })).toEqual([]);

        const detail = await queries.getAgentScan(SEED_ADMIN, agent, older);
        expect(detail).toMatchObject({ briefing: { cash: '1000.00' }, transcript: [{ role: 'assistant' }], proposals: [] });
        expect(await queries.getAgentScan(USER, AGENT, older)).toBeNull();

        const row = await queries.getAgent(SEED_ADMIN, agent);
        expect(row).toMatchObject({
          llm_budget_micro_usd: '500000',
          scan_every_hours: null,
          scan_pre_open: true,
          scan_post_close: false,
          llm_spent_today_micro_usd: '7000',
          agent_scan_cost_micro_usd: '30000',
        });
        // The installation's average spans every run's agents on a reused database.
        expect(row!.installation_scan_cost_micro_usd).not.toBeNull();
        const primary = await queries.getAgent(USER, AGENT);
        expect(primary).toMatchObject({ llm_spent_today_micro_usd: '0', agent_scan_cost_micro_usd: null });

        const none = { everyHours: null, preOpen: false, postClose: false };
        const patched = await queries.updateAgent(SEED_ADMIN, agent, { llmBudgetMicroUsd: 1_250_000, scanSchedule: none });
        expect(patched).toMatchObject({
          llm_budget_micro_usd: '1250000',
          scan_every_hours: null,
          scan_pre_open: false,
          scan_post_close: false,
        });
        // 0060's CHECK: hours between market-hours scans are 1 to 6.
        await expect(
          getPool().query('UPDATE agents SET scan_every_hours = 7 WHERE id = $1', [agent]),
        ).rejects.toMatchObject({ code: '23514' });
        // Archived, so a reused database never reaches the admin's agent limit (D72).
        await queries.updateAgent(SEED_ADMIN, agent, { state: 'archived' });
      }
    });
  });

  describe('the agent limit (0047, 0062: D72, D199), rolled back', () => {
    const insertAgent = (
      client: { query: (sql: string, params: unknown[]) => Promise<unknown> },
      user: string,
      slug: string,
      state = 'active',
    ) =>
      client.query(
        `INSERT INTO agents (user_id, slug, name, budget_minor, state) VALUES ($1, $2, $2, 1000, $3)`,
        [user, slug, state],
      );

    it('counts active agents only: a paused one is created at the limit, a resume is refused', async () => {
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        const user = randomUUID();
        await client.query("INSERT INTO users (id, status, llm_cap_micro_usd) VALUES ($1, 'active', 10000000)", [user]);
        const { max_agents_per_user: max } = (await client.query('SELECT max_agents_per_user FROM installation_settings')).rows[0];
        for (let index = 0; index < max; index += 1) await insertAgent(client, user, `limit-${index}`);
        // The primary the trigger on users made never counts.
        await client.query('SAVEPOINT one_more');
        await expect(insertAgent(client, user, 'limit-extra')).rejects.toThrow(
          new RegExp(`^agent_limit_reached: ${max} of ${max} active agents`),
        );
        await client.query('ROLLBACK TO SAVEPOINT one_more');

        await insertAgent(client, user, 'resting', 'paused');
        await client.query('SAVEPOINT resume');
        await expect(
          client.query(`UPDATE agents SET state = 'active' WHERE user_id = $1 AND slug = 'resting'`, [user]),
        ).rejects.toThrow(/agent_limit_reached/);
        await client.query('ROLLBACK TO SAVEPOINT resume');

        // Pausing one makes the room the resume needed.
        await client.query(`UPDATE agents SET state = 'paused' WHERE user_id = $1 AND slug = 'limit-0'`, [user]);
        await client.query(`UPDATE agents SET state = 'active' WHERE user_id = $1 AND slug = 'resting'`, [user]);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it('lets one of two racing activations through, never both', async () => {
      const user = randomUUID();
      const first = await getPool().connect();
      const second = await getPool().connect();
      try {
        await getPool().query("INSERT INTO users (id, status, llm_cap_micro_usd) VALUES ($1, 'active', 10000000)", [user]);
        const { max_agents_per_user: max } = (await getPool().query('SELECT max_agents_per_user FROM installation_settings')).rows[0];
        for (let index = 0; index < max - 1; index += 1) await insertAgent(getPool(), user, `race-${index}`);
        await insertAgent(getPool(), user, 'race-waiting', 'paused');
        // A create and a resume of the last place at once. Without the lock both would see room.
        await first.query('BEGIN');
        await second.query('BEGIN');
        await insertAgent(first, user, 'race-last');
        // first holds the user's row: second waits for it, then counts the limit.
        const waiting = second.query(`UPDATE agents SET state = 'active' WHERE user_id = $1 AND slug = 'race-waiting'`, [user]).then(
          () => 'resumed',
          (error: Error) => error.message,
        );
        await first.query('COMMIT');
        expect(await waiting).toMatch(new RegExp(`agent_limit_reached: ${max} of ${max}`));
        expect(await queries.countActiveAgents(user)).toBe(max);
      } finally {
        await second.query('ROLLBACK').catch(() => undefined);
        first.release();
        second.release();
        // Each agent's cash account is a ledger row the app role may not delete, so
        // the throwaway user stays; its agents are archived and hold nothing.
        await getPool().query(`UPDATE agents SET state = 'archived' WHERE user_id = $1 AND NOT is_primary`, [user]);
      }
    });

    it(`lets one of two racing creates take the ${MAX_AGENTS_PER_USER_CEILING}th place, never both (0063, D202)`, async () => {
      const user = randomUUID();
      const first = await getPool().connect();
      const second = await getPool().connect();
      try {
        await getPool().query("INSERT INTO users (id, status, llm_cap_micro_usd) VALUES ($1, 'active', 10000000)", [user]);
        // Paused, so the active limit (0062) never speaks first.
        for (let index = 0; index < MAX_AGENTS_PER_USER_CEILING - 1; index += 1) {
          await insertAgent(getPool(), user, `kept-${index}`, 'paused');
        }
        await first.query('BEGIN');
        await second.query('BEGIN');
        await insertAgent(first, user, 'kept-last', 'paused');
        // first holds the user's row: second waits for it, then counts the ceiling.
        const waiting = insertAgent(second, user, 'kept-racer', 'paused').then(
          () => 'created',
          (error: Error) => error.message,
        );
        await first.query('COMMIT');
        expect(await waiting).toMatch(
          new RegExp(`^agent_total_reached: ${MAX_AGENTS_PER_USER_CEILING} of ${MAX_AGENTS_PER_USER_CEILING} agents`),
        );
        expect(await queries.countLiveAgents(user)).toBe(MAX_AGENTS_PER_USER_CEILING);
      } finally {
        await second.query('ROLLBACK').catch(() => undefined);
        first.release();
        second.release();
        // As above: the throwaway user stays, its agents archived.
        await getPool().query(`UPDATE agents SET state = 'archived' WHERE user_id = $1 AND NOT is_primary`, [user]);
      }
    });
  });

  describe("a scheduled slot's attempts (0048, D69)", () => {
    it('lists the attempts of one slot, oldest first, and no other slot or agent', async () => {
      const slot = `agent_scan:${AGENT}:2026-10-08:pre_open`;
      for (const [key, status] of [
        [`${slot}:1`, 'failed'],
        [`${slot}:2`, 'ok'],
        [`agent_scan:${AGENT}:2026-10-08:post_close:1`, 'ok'],
        // A slot whose name starts like this one's is not this one.
        [`${slot}_x:1`, 'ok'],
      ] as const) {
        const { runId } = await queries.claimRun({ userId: USER, agentId: AGENT, kind: 'agent_scan', runKey: key, trigger: 'schedule' });
        await queries.finishRun(runId!, status, { retryable: true });
      }
      const attempts = await queries.listSlotAttempts(AGENT, slot);
      expect(attempts.map((row) => [row.run_key, row.status])).toEqual([
        [`${slot}:1`, 'failed'],
        [`${slot}:2`, 'ok'],
      ]);
      expect(attempts[0]!.stats).toEqual({ retryable: true });
      expect(await queries.listSlotAttempts(randomUUID(), slot)).toEqual([]);
    });
  });

  describe('trade proposals (0044), rolled back', () => {
    // agent_scans does not cascade from users, so everything here is rolled back.
    it('writes the observation and the proposal once per scan, and holds the constraints', async () => {
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        const simulated = (
          await client.query(
            `INSERT INTO agents (user_id, slug, name, persona, budget_minor)
             VALUES ($1, 'trade-test', 'Trade test', 'Patient.', 100000) RETURNING id`,
            [USER],
          )
        ).rows[0].id as string;
        const scan = (
          await client.query(
            `INSERT INTO agent_scans (user_id, agent_id, trigger, finished_at, outcome, briefing)
             VALUES ($1, $2, 'manual', now(), 'trade', '{}') RETURNING id`,
            [USER, simulated],
          )
        ).rows[0].id as string;
        const proposal = {
          userId: USER,
          agentId: simulated,
          scanId: scan,
          kind: 'buy' as const,
          payload: { symbol: 'INTC', quantity: '3', priceMinor: 11_250, priceAsOf: null, currency: 'USD' as const },
          expiresAt: new Date(Date.now() + 3_600_000),
          headline: 'Trade test proposes to buy 3 INTC at 112.50',
          thesis: 'INTC fell 3.18% to 112.50.',
          localized: { he: { headline: 'h', explanation: 'INTC fell 3.18% to 112.50.' } },
          evidence: { scanId: scan },
        };
        const created = await queries.createTradeProposalIn(client, proposal);
        const id = created.proposalId;
        // A retry after a lost reply answers the same proposal, and writes nothing more.
        expect(await queries.createTradeProposalIn(client, proposal)).toEqual(created);
        const written = await client.query(
          `SELECT p.kind, p.scan_id, p.payload, o.kind AS observation_kind, o.explanation, o.localized
             FROM proposals p JOIN observations o ON o.id = p.observation_id
            WHERE p.agent_id = $1`,
          [simulated],
        );
        expect(written.rows).toEqual([
          {
            kind: 'buy',
            scan_id: scan,
            payload: proposal.payload,
            observation_kind: 'agent_trade',
            explanation: proposal.thesis,
            localized: proposal.localized,
          },
        ]);

        // A trade kind with no scan behind it is a trade nobody decided.
        await client.query('SAVEPOINT no_scan');
        await expect(
          client.query(
            `INSERT INTO proposals (user_id, agent_id, observation_id, kind, expires_at)
             SELECT $1, $2, id, 'sell', now() FROM observations WHERE agent_id = $2`,
            [USER, simulated],
          ),
        ).rejects.toThrow(/proposals_trade_has_scan|proposals_one_per_observation/);
        await client.query('ROLLBACK TO SAVEPOINT no_scan');

        // An agent's fill without its proposal is refused; with it, written.
        const instrument = (
          await client.query(
            `INSERT INTO instruments (symbol, asset_class) VALUES ($1, 'equity') RETURNING id`,
            [`TRD${randomUUID().slice(0, 8)}`.toUpperCase()],
          )
        ).rows[0].id as string;
        const fill = (proposalId: string | null, key: string) =>
          queries.insertFill(client, {
            userId: USER,
            agentId: simulated,
            instrumentId: instrument,
            side: 'buy',
            quantity: 3n,
            priceMinor: 11_250n,
            notionalMinor: 33_750n,
            feeMinor: 150n,
            priceSource: 'quote',
            quoteAsOf: new Date().toISOString(),
            quoteDelaySeconds: 900,
            source: 'agent',
            proposalId,
            idempotencyKey: key,
          });
        await client.query('SAVEPOINT no_proposal');
        await expect(fill(null, 'no-proposal')).rejects.toThrow(/fills_agent_has_proposal/);
        await client.query('ROLLBACK TO SAVEPOINT no_proposal');
        await fill(id, `proposal:${id}`);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });

  describe("a trade proposal's re-check (0066, D212, D213)", () => {
    // Committed and written as the seeded admin, as the scans above are: traders_app
    // may not delete a scan. A fresh agent per run keeps a re-run independent.
    const SEED_ADMIN = '00000000-0000-0000-0000-000000000001';
    it('reads the latest re-check and the proposal it raised; once is the index', async () => {
      const pool = getPool();
      const simulated = (
        await pool.query(
          `INSERT INTO agents (user_id, slug, name, persona, budget_minor)
           VALUES ($1, $2, $2, 'Patient.', 100000) RETURNING id`,
          [SEED_ADMIN, `recheck-${randomUUID().slice(0, 8)}`],
        )
      ).rows[0].id as string;
      const scanOf = async (trigger: string, outcome: string, minutesAgo: number, refreshes: string | null = null) =>
        (
          await pool.query(
            `INSERT INTO agent_scans (user_id, agent_id, trigger, refreshes_proposal_id, started_at,
                                      finished_at, outcome, briefing)
             VALUES ($1, $2, $3, $4, now() - make_interval(mins => $5), now(), $6, '{}') RETURNING id`,
            [SEED_ADMIN, simulated, trigger, refreshes, minutesAgo, outcome],
          )
        ).rows[0].id as string;
      const proposeFrom = async (scanId: string) =>
        (
          await queries.createTradeProposal({
            userId: SEED_ADMIN,
            agentId: simulated,
            scanId,
            kind: 'buy',
            payload: { symbol: 'CCJ', quantity: '2', priceMinor: 5_100, priceAsOf: null, currency: 'USD' },
            expiresAt: new Date(Date.now() - 3_600_000),
            headline: 'Recheck test proposes to buy 2 CCJ at 51.00',
            thesis: 't',
            localized: {},
            evidence: {},
          })
        ).proposalId;
      const original = await proposeFrom(await scanOf('manual', 'trade', 120));
      expect(await queries.latestRecheck(SEED_ADMIN, simulated, original)).toBeNull();

      // One that reached no answer does not count: a second may follow it (D213).
      const unanswered = await scanOf('refresh', 'budget_reached', 10, original);
      expect(await queries.latestRecheck(SEED_ADMIN, simulated, original)).toMatchObject({
        scan_id: unanswered,
        outcome: 'budget_reached',
        new_proposal_id: null,
      });
      const counted = await scanOf('refresh', 'trade', 5, original);
      const raised = await proposeFrom(counted);
      expect(await queries.latestRecheck(SEED_ADMIN, simulated, original)).toMatchObject({
        scan_id: counted,
        new_proposal_id: raised,
      });
      await expect(scanOf('refresh', 'no_trade', 1, original)).rejects.toThrow(/agent_scans_one_refresh/);
      // D218: the agent's next buy of CCJ, approved, made the trade; a later sell does not.
      expect(await queries.laterApprovedProposal(SEED_ADMIN, simulated, original)).toBeNull();
      await pool.query(`UPDATE proposals SET state = 'approved', decided_at = now(), decided_via = 'web' WHERE id = $1`, [raised]);
      expect(await queries.laterApprovedProposal(SEED_ADMIN, simulated, original)).toBe(raised);
      expect(await queries.laterApprovedProposal(SEED_ADMIN, simulated, raised)).toBeNull();
      // Another user's id reads nothing.
      expect(await queries.latestRecheck(randomUUID(), simulated, original)).toBeNull();
    });
  });

  describe('the account reset (task 18)', () => {
    // An account of its own: a reset of USER would erase what the tests above wrote.
    const OWNER = randomUUID();

    afterAll(async () => {
      // `agent_cash` names the user without a cascade; the agent's own delete takes it.
      await getPool().query('DELETE FROM agents WHERE user_id = $1 AND NOT is_primary', [OWNER]);
      await getPool().query('DELETE FROM users WHERE id = $1', [OWNER]);
    });

    it('erases the chosen groups through the one function this role may call, and backs them up', async () => {
      await getPool().query("INSERT INTO users (id, status, llm_cap_micro_usd) VALUES ($1, 'active', 10000000)", [OWNER]);
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO agents (user_id, slug, name, budget_minor)
         VALUES ($1, 'resettable', 'Resettable', 250000) RETURNING id`,
        [OWNER],
      );
      const agent = rows[0]!.id;
      await getPool().query(
        `INSERT INTO topics (user_id, label, status, created_by, confirmed_at)
         VALUES ($1, 'robots', 'active', 'user', now())`,
        [OWNER],
      );

      const reset = await queries.resetAccount(OWNER, ['agents_trading', 'followed_topics']);

      expect(reset.counts).toMatchObject({ topics: 1, cash_movements: 1, fills: 0 });
      const after = await getPool().query<{ budget: string; cash: string; topics: string }>(
        `SELECT a.budget_minor::text AS budget, c.balance_minor::text AS cash,
                (SELECT count(*)::text FROM topics WHERE user_id = $1) AS topics
           FROM agents a JOIN agent_cash c ON c.agent_id = a.id WHERE a.id = $2`,
        [OWNER, agent],
      );
      expect(after.rows[0]).toEqual({ budget: '0', cash: '0', topics: '0' });
      const backup = await getPool().query<{ groups: string[] }>(
        'SELECT groups FROM account_resets WHERE id = $1',
        [reset.reset_id],
      );
      expect(backup.rows[0]!.groups).toEqual(['agents_trading', 'followed_topics']);
    });
  });

  describe('the digest seen (0046, UX4)', () => {
    it('records nothing before any digest, then only forward and never past the last one', async () => {
      const at = (iso: string) => new Date(iso);
      // No digest sent yet: there is nothing to have seen.
      expect(await queries.markDigestSeen(USER, at('2026-10-08T08:00:00Z'))).toBeNull();
      expect(await queries.getDigestSeenAt(USER)).toBeNull();

      const refId = randomUUID();
      const claimed = await queries.claimNotification({
        userId: USER,
        agentId: AGENT,
        channel: 'digest',
        refKind: 'narration',
        refId,
        route: 'digest',
        reason: 'quiet_hours',
        status: 'pending',
        dedupeKey: `digest:narration:${refId}`,
      });
      expect(claimed).not.toBeNull();
      // Microseconds, as Postgres stores them: the client echoes only milliseconds back.
      await getPool().query(
        `UPDATE notifications SET status = 'sent', sent_at = '2026-10-08T08:42:40.736914Z' WHERE ref_id = $1`,
        [refId],
      );

      expect(await queries.markDigestSeen(USER, at('2026-10-08T08:42:40.736Z'))).toEqual(
        at('2026-10-08T08:42:40.736Z'),
      );
      // An older digest, from a stale tab: no going back.
      expect(await queries.markDigestSeen(USER, at('2026-10-01T00:00:00Z'))).toEqual(
        at('2026-10-08T08:42:40.736Z'),
      );
      // A claim from the future is held to the last digest sent.
      expect(await queries.markDigestSeen(USER, at('2030-01-01T00:00:00Z'))).toEqual(
        at('2026-10-08T08:42:40.736Z'),
      );
      expect(await queries.getDigestSeenAt(USER)).toEqual(at('2026-10-08T08:42:40.736Z'));
    });

    it('survives a settings save, which names the columns it writes', async () => {
      const before = await queries.getDigestSeenAt(USER);
      await queries.replaceUserSettings(USER, {
        proposalSeverity: 'high',
        proposalTtlHours: 24,
        notifySeverity: 'high',
        quietHoursStart: null,
        quietHoursEnd: null,
        mutedUntil: null,
        language: 'en',
      });
      expect(await queries.getDigestSeenAt(USER)).toEqual(before);
    });
  });

  describe("the assistant's conversations (0052)", () => {
    const OTHER = randomUUID();
    let conversation = '';

    beforeAll(async () => {
      await getPool().query("INSERT INTO users (id, status, llm_cap_micro_usd) VALUES ($1, 'active', 10000000)", [OTHER]);
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO assistant_conversations (user_id, title) VALUES ($1, 'How am I doing?') RETURNING id`,
        [USER],
      );
      conversation = rows[0]!.id;
      await getPool().query(
        `INSERT INTO assistant_messages (conversation_id, user_id, role, content, outcome, sources, created_at)
         VALUES ($1, $2, 'user', 'How am I doing?', NULL, '[]', now() - interval '1 minute'),
                ($1, $2, 'assistant', 'Up.', 'answer', '[{"kind": "page", "label": "Portfolio", "link": "/"}]', now())`,
        [conversation, USER],
      );
    });

    afterAll(async () => {
      // No cascade from `users` (0052): a conversation is removed with its own DELETE.
      await getPool().query('DELETE FROM assistant_conversations WHERE user_id IN ($1, $2)', [USER, OTHER]);
      await getPool().query('DELETE FROM users WHERE id = $1', [OTHER]);
    });

    it('lists and reads back only the owner\'s conversations, messages oldest first', async () => {
      expect((await queries.listAssistantConversations(USER, 10)).map((c) => c.id)).toEqual([conversation]);
      expect(await queries.listAssistantConversations(OTHER, 10)).toEqual([]);
      expect(await queries.getAssistantConversation(OTHER, conversation)).toBeNull();
      expect(await queries.listAssistantMessages(OTHER, conversation)).toEqual([]);

      const messages = await queries.listAssistantMessages(USER, conversation);
      expect(messages.map((m) => [m.role, m.outcome])).toEqual([
        ['user', null],
        ['assistant', 'answer'],
      ]);
      expect(messages[1]!.sources).toEqual([{ kind: 'page', label: 'Portfolio', link: '/' }]);
    });

    it("refuses to delete another user's conversation, and deletes the owner's with its messages", async () => {
      expect(await queries.deleteAssistantConversation(OTHER, conversation)).toBe(false);
      expect(await queries.deleteAssistantConversation(USER, conversation)).toBe(true);
      const { rows } = await getPool().query('SELECT 1 FROM assistant_messages WHERE conversation_id = $1', [
        conversation,
      ]);
      expect(rows).toEqual([]);
      expect(await queries.deleteAssistantConversation(USER, conversation)).toBe(false);
    });

    it("reads and sets the assistant's daily limit", async () => {
      const before = await queries.getInstallationSettings();
      try {
        await queries.setAssistantDailyBudget(1_250_000, '00000000-0000-0000-0000-000000000001');
        expect((await queries.getInstallationSettings()).assistant_daily_budget_micro_usd).toBe(1_250_000);
      } finally {
        await queries.setAssistantDailyBudget(before.assistant_daily_budget_micro_usd, '00000000-0000-0000-0000-000000000001');
      }
    });
  });

  describe("a user's own model choice and its fallbacks (0069, D244, D286)", () => {
    const MODEL = 'acme/model-1';

    it("saves and clears the models for Ask and explanations, each in its own column", async () => {
      await queries.setUserModel(USER, 'assistant', MODEL);
      await queries.setUserModel(USER, 'explain', 'acme/model-2');
      const read = () =>
        getPool().query('SELECT llm_assistant_model, llm_explain_model FROM user_settings WHERE user_id = $1', [USER]);
      expect((await read()).rows[0]).toEqual({ llm_assistant_model: MODEL, llm_explain_model: 'acme/model-2' });
      await queries.setUserModel(USER, 'assistant', null);
      expect((await read()).rows[0]).toEqual({ llm_assistant_model: null, llm_explain_model: 'acme/model-2' });
    });

    it("sets an agent's model, never the main portfolio's, nor another user's agent", async () => {
      const agent = (
        await getPool().query<{ id: string }>(
          `INSERT INTO agents (user_id, slug, name, budget_minor) VALUES ($1, 'model-agent', 'Model agent', 100000)
           RETURNING id`,
          [USER],
        )
      ).rows[0]!.id;
      expect(await queries.setAgentModel(USER, agent, MODEL)).toBe(true);
      expect(await queries.setAgentModel(USER, AGENT, MODEL)).toBe(false);
      expect(await queries.setAgentModel(randomUUID(), agent, 'acme/other')).toBe(false);
      const { rows } = await getPool().query('SELECT id, model FROM agents WHERE user_id = $1 ORDER BY is_primary', [USER]);
      expect(rows).toEqual([
        { id: agent, model: MODEL },
        { id: AGENT, model: null },
      ]);
      // `agent_cash` does not cascade from `users`; the agent's own delete takes it.
      await getPool().query('DELETE FROM agents WHERE id = $1', [agent]);
    });

    it('lists the unannounced fallbacks with their agent, and marks one announced', async () => {
      const id = (
        await getPool().query<{ id: string }>(
          `INSERT INTO model_fallbacks (user_id, agent_id, scope, saved_model, effective_model)
           VALUES ($1, $2, 'assistant', $3, 'google/gemini-3.5-flash-lite') RETURNING id`,
          [USER, AGENT, MODEL],
        )
      ).rows[0]!.id;
      const [row] = await queries.listUnannouncedModelFallbacks(USER);
      expect(row).toMatchObject({ id, agent_id: AGENT, scope: 'assistant', saved_model: MODEL });
      await queries.markModelFallbackAnnounced(USER, id);
      expect(await queries.listUnannouncedModelFallbacks(USER)).toEqual([]);
    });
  });

  describe('research on the main portfolio (0070, D254, D289-D293)', () => {
    it("assigns only the user's own simulated, unarchived agent, and reads each holding's latest rating", async () => {
      const pool = getPool();
      const mark = USER.slice(0, 8);
      const [analyst, archived] = await Promise.all(
        ['analyst', 'archived'].map(async (slug) =>
          (
            await pool.query<{ id: string }>(
              `INSERT INTO agents (user_id, slug, name, budget_minor, state)
               VALUES ($1, $2, $3, 1000, $4) RETURNING id`,
              [USER, `research-${slug}`, `Research ${slug}`, slug === 'archived' ? 'archived' : 'active'],
            )
          ).rows[0]!.id,
        ),
      );
      const other = randomUUID();
      try {
        await pool.query("INSERT INTO users (id, status, llm_cap_micro_usd) VALUES ($1, 'active', 10000000)", [other]);
        const othersPrimary = await queries.primaryAgentId(other);

        expect(await queries.setResearchAgent(USER, AGENT)).toBe(false);
        expect(await queries.setResearchAgent(USER, archived!)).toBe(false);
        expect(await queries.setResearchAgent(USER, othersPrimary)).toBe(false);
        expect(await queries.setResearchAgent(USER, analyst!)).toBe(true);
        expect(await queries.getResearchAgent(USER)).toEqual({ id: analyst, name: 'Research analyst', state: 'active' });
        expect(await queries.listActiveResearchAssignments([USER, other])).toEqual([{ user_id: USER, agent_id: analyst }]);

        const instrument = (
          await pool.query<{ id: string }>(
            `INSERT INTO instruments (symbol, asset_class, name) VALUES ($1, 'equity', 'Research Corp') RETURNING id`,
            [`R${mark}`.slice(0, 12).toUpperCase()],
          )
        ).rows[0]!.id;
        await pool.query(`INSERT INTO holdings (user_id, agent_id, instrument_id, quantity) VALUES ($1, $2, $3, 2)`, [
          USER,
          AGENT,
          instrument,
        ]);
        const run = (
          await pool.query<{ id: string }>(
            `INSERT INTO research_runs (user_id, agent_id, trigger, status, started_at, finished_at)
             VALUES ($1, $2, 'manual', 'done', now() - interval '2 hours', now() - interval '1 hour') RETURNING id`,
            [USER, analyst],
          )
        ).rows[0]!.id;
        for (const [status, rating, age] of [
          ['rated', 'bearish', '3 hours'],
          ['rated', 'bullish', '2 hours'],
          ['refused', null, '1 hour'],
        ] as const) {
          await pool.query(
            `INSERT INTO research_ratings (run_id, user_id, agent_id, instrument_id, symbol, status, rating, rationale, created_at)
             VALUES ($1, $2, $3, $4, 'R', $5, $6, $7, now() - $8::interval)`,
            [run, USER, analyst, instrument, status, rating, rating === null ? null : `${rating} reasons`, age],
          );
        }
        const mine = (rows: Awaited<ReturnType<typeof queries.listResearchHoldings>>) => rows.find((row) => row.instrument_id === instrument);
        const row = mine(await queries.listResearchHoldings(USER, analyst!));
        expect(row).toMatchObject({ rating: 'bullish', rationale: 'bullish reasons', agent_name: 'Research analyst', last_status: 'refused' });
        // Another agent's ratings are not this one's.
        const none = mine(await queries.listResearchHoldings(USER, archived!));
        expect(none).toMatchObject({ rating: null, last_status: null });

        // A run left running past the abandonment age reads as failed.
        await pool.query(
          `INSERT INTO research_runs (user_id, agent_id, trigger, status, started_at)
           VALUES ($1, $2, 'schedule', 'running', now() - make_interval(mins => $3 + 1))`,
          [USER, analyst, RESEARCH_ABANDONED_AFTER_MINUTES],
        );
        expect(await queries.getLatestResearchRun(USER)).toMatchObject({ status: 'failed', error: 'abandoned' });

        expect(await queries.setResearchAgent(USER, null)).toBe(true);
        expect(await queries.getResearchAgent(USER)).toBeNull();
      } finally {
        // `agent_cash` does not cascade from `users`; the agents' own delete takes it.
        await pool.query('DELETE FROM agents WHERE id = ANY($1::uuid[])', [[analyst, archived]]);
        await pool.query('DELETE FROM users WHERE id = $1', [other]);
      }
    });
  });

  describe('sessions (0071, D261)', async () => {
    const { sessionTokenHash } = await import('../src/http/auth.js');
    const TTL_HOURS = 1;
    const TOUCH_SECONDS = 300;

    /** A user of its own, so ending "every session" ends nothing of USER's. */
    async function withUser<T>(fn: (userId: string) => Promise<T>): Promise<T> {
      const userId = randomUUID();
      await getPool().query("INSERT INTO users (id, status, llm_cap_micro_usd) VALUES ($1, 'active', 0)", [userId]);
      try {
        return await fn(userId);
      } finally {
        await getPool().query('DELETE FROM users WHERE id = $1', [userId]);
      }
    }

    async function signIn(userId: string, secret = randomUUID()): Promise<{ id: string; hash: Buffer }> {
      const hash = sessionTokenHash(secret);
      const created = await queries.createSession({
        userId,
        tokenHash: hash,
        ttlHours: TTL_HOURS,
        userAgent: 'UA',
        ipAddress: '203.0.113.7',
        maxPerUser: SESSIONS_PER_USER_MAX,
      });
      return { id: created.id, hash };
    }

    const sessionIds = async (userId: string) => (await queries.listSessions(userId)).map((row) => row.id).sort();

    it("reads the session with its user, only by the right hash and the cookie's user", async () => {
      await withUser(async (userId) => {
        const session = await signIn(userId);
        const found = await queries.getSessionUser(userId, session.hash, TOUCH_SECONDS, null);
        expect(found).toMatchObject({ id: userId, status: 'active', session_id: session.id });
        expect(await queries.getSessionUser(userId, sessionTokenHash('another secret'), TOUCH_SECONDS, null)).toBeNull();
        expect(await queries.getSessionUser(USER, session.hash, TOUCH_SECONDS, null)).toBeNull();
        const { rows } = await getPool().query('SELECT expires_at - created_at AS ttl FROM user_sessions WHERE id = $1', [session.id]);
        expect(rows[0]!.ttl).toMatchObject({ hours: TTL_HOURS });
      });
    });

    it('ends the oldest sessions when a sign-in passes the cap, and only that user\'s', async () => {
      await withUser(async (userId) => {
        const other = await signIn(USER);
        try {
          const first: string[] = [];
          for (let index = 0; index < SESSIONS_PER_USER_MAX; index += 1) {
            const session = await signIn(userId);
            // Distinct ages, oldest first, so "oldest" does not rest on the clock's resolution.
            await getPool().query("UPDATE user_sessions SET created_at = now() - make_interval(mins => $2) WHERE id = $1", [
              session.id,
              SESSIONS_PER_USER_MAX - index,
            ]);
            first.push(session.id);
          }
          expect(await sessionIds(userId)).toEqual([...first].sort());

          const newest = await signIn(userId);
          expect(await sessionIds(userId)).toEqual([...first.slice(1), newest.id].sort());
          expect((await queries.listSessions(USER)).map((row) => row.id)).toContain(other.id);
        } finally {
          await queries.deleteSession(USER, other.id);
        }
      });
    });

    it('keeps only the new session at a cap of one, and refuses a cap that is not a positive integer', async () => {
      await withUser(async (userId) => {
        await signIn(userId);
        const created = await queries.createSession({
          userId,
          tokenHash: sessionTokenHash(randomUUID()),
          ttlHours: TTL_HOURS,
          userAgent: 'UA',
          ipAddress: null,
          maxPerUser: 1,
        });
        expect(await sessionIds(userId)).toEqual([created.id]);
        for (const maxPerUser of [0, -1, 1.5, null as unknown as number]) {
          await expect(
            queries.createSession({
              userId,
              tokenHash: sessionTokenHash(randomUUID()),
              ttlHours: TTL_HOURS,
              userAgent: 'UA',
              ipAddress: null,
              maxPerUser,
            }),
            String(maxPerUser),
          ).rejects.toThrow('maxPerUser');
        }
        expect(await sessionIds(userId)).toEqual([created.id]);
      });
    });

    it('moves last seen only once the touch interval has passed', async () => {
      await withUser(async (userId) => {
        const session = await signIn(userId);
        const lastSeen = async () =>
          (await getPool().query('SELECT last_seen_at FROM user_sessions WHERE id = $1', [session.id])).rows[0]!.last_seen_at as Date;
        const stale = new Date(Date.now() - (TOUCH_SECONDS + 60) * 1000);
        await getPool().query('UPDATE user_sessions SET last_seen_at = $2 WHERE id = $1', [session.id, stale]);
        await queries.getSessionUser(userId, session.hash, TOUCH_SECONDS, null);
        const touched = await lastSeen();
        expect(touched.getTime()).toBeGreaterThan(stale.getTime());
        const recent = new Date(Date.now() - 60 * 1000);
        await getPool().query('UPDATE user_sessions SET last_seen_at = $2 WHERE id = $1', [session.id, recent]);
        await queries.getSessionUser(userId, session.hash, TOUCH_SECONDS, null);
        expect((await lastSeen()).getTime()).toBe(recent.getTime());
      });
    });

    it('refuses, lists and sweeps an expired session as gone', async () => {
      await withUser(async (userId) => {
        const live = await signIn(userId);
        const expired = await signIn(userId);
        await getPool().query(
          "UPDATE user_sessions SET created_at = now() - interval '2 days', expires_at = now() - interval '1 second' WHERE id = $1",
          [expired.id],
        );
        expect(await queries.getSessionUser(userId, expired.hash, TOUCH_SECONDS, null)).toBeNull();
        expect(await sessionIds(userId)).toEqual([live.id]);
        expect(await queries.deleteExpiredSessions()).toBeGreaterThanOrEqual(1);
        const { rows } = await getPool().query('SELECT id FROM user_sessions WHERE user_id = $1', [userId]);
        expect(rows.map((row) => row.id)).toEqual([live.id]);
      });
    });

    it("ends one session, never another user's, and all but one on request", async () => {
      await withUser(async (userId) => {
        const [first, second, third] = [await signIn(userId), await signIn(userId), await signIn(userId)];
        const others = await signIn(USER);
        expect(await queries.deleteSession(userId, others.id)).toBe(false);
        expect(await queries.deleteSession(userId, first.id)).toBe(true);
        expect(await queries.getSessionUser(userId, first.hash, TOUCH_SECONDS, null)).toBeNull();
        const expired = await signIn(userId);
        await getPool().query(
          "UPDATE user_sessions SET created_at = now() - interval '2 days', expires_at = now() - interval '1 second' WHERE id = $1",
          [expired.id],
        );
        // Third and the expired one go; only third was live, so only third is counted.
        expect(await queries.deleteOtherSessions(userId, second.id)).toBe(1);
        expect(await sessionIds(userId)).toEqual([second.id]);
        expect(await queries.getSessionUser(userId, third.hash, TOUCH_SECONDS, null)).toBeNull();
        expect(await sessionIds(USER)).toContain(others.id);
        await queries.deleteSession(USER, others.id);
      });
    });

    it('ends every session in the same statement as a password, status or one-time password change', async () => {
      await withUser(async (userId) => {
        const changes: [string, () => Promise<unknown>][] = [
          ['password', () => queries.changePassword(userId, '$argon2id$v=19$m=19456,t=2,p=1$x')],
          ['one-time password', () => queries.setOneTimePassword(userId, '$argon2id$v=19$m=19456,t=2,p=1$y')],
          ['disable', () => queries.setUserStatus(userId, 'active', 'disabled')],
        ];
        for (const [name, change] of changes) {
          await signIn(userId);
          await signIn(userId);
          await change();
          const { rows } = await getPool().query('SELECT count(*)::int AS n FROM user_sessions WHERE user_id = $1', [userId]);
          expect(rows[0]!.n, name).toBe(0);
        }
      });
    });

    it('ends nothing when the change does not apply', async () => {
      await withUser(async (userId) => {
        const session = await signIn(userId);
        // Not disabled, so there is nothing to enable.
        expect(await queries.setUserStatus(userId, 'disabled', 'active')).toBeNull();
        expect(await sessionIds(userId)).toEqual([session.id]);
      });
    });
  });

  describe("the Telegram token's last error, for the Keys tab (D288)", () => {
    it("counts only what Telegram or the network said, never a user's missing chat", async () => {
      const insert = (error: string, minutesAgo: number) =>
        getPool().query(
          `INSERT INTO notifications (user_id, agent_id, channel, ref_kind, ref_id, route, reason, status, error,
                                      dedupe_key, created_at)
           VALUES ($1, $2, 'telegram', 'observation', gen_random_uuid(), 'push', 'above_floor', 'failed', $3,
                   gen_random_uuid()::text, now() - make_interval(mins => $4))`,
          [USER, AGENT, error, minutesAgo],
        );
      await insert('HTTP 401: Unauthorized', 10);
      await insert('this user has no Telegram chat connected', 1);
      const last = await queries.lastTelegramFailure();
      expect(last?.error).toBe('HTTP 401: Unauthorized');
    });
  });
  describe('account deletion and export (0076, D264)', async () => {
    const { sessionTokenHash } = await import('../src/http/auth.js');
    const { ACCOUNT_DELETION_GRACE_DAYS } = await import('@traders/shared');
    const SECRET_HASH = '$argon2id$v=19$m=19456,t=2,p=1$never-exported';

    /** A user of its own, with a password, a session and a model key; removed after, if still there. */
    async function withUser<T>(fn: (userId: string, sessionId: string) => Promise<T>): Promise<T> {
      const userId = randomUUID();
      await getPool().query(
        `INSERT INTO users (id, email, status, llm_cap_micro_usd, password_hash)
         VALUES ($1, $2, 'active', 0, $3)`,
        [userId, `${userId}@example.com`, SECRET_HASH],
      );
      const session = await queries.createSession({
        userId,
        tokenHash: sessionTokenHash(randomUUID()),
        ttlHours: 1,
        userAgent: 'UA',
        ipAddress: null,
        maxPerUser: SESSIONS_PER_USER_MAX,
      });
      try {
        return await fn(userId, session.id);
      } finally {
        await getPool().query('DELETE FROM assistant_conversations WHERE user_id = $1', [userId]);
        await getPool().query('DELETE FROM users WHERE id = $1', [userId]);
      }
    }

    const statusOf = async (userId: string) =>
      (await getPool().query<{ status: string }>('SELECT status FROM users WHERE id = $1', [userId])).rows[0]?.status;
    const sessionCount = async (userId: string) =>
      (await getPool().query<{ n: number }>('SELECT count(*)::int AS n FROM user_sessions WHERE user_id = $1', [userId]))
        .rows[0]!.n;
    const backdate = (userId: string, interval: string) =>
      getPool().query(`UPDATE users SET deletion_due_at = now() - $2::interval WHERE id = $1`, [userId, interval]);

    it('closes an active account for the grace period, ending every session in the same statement', async () => {
      await withUser(async (userId) => {
        const before = await queries.getUser(userId);
        const closed = await queries.closeAccount(userId, ACCOUNT_DELETION_GRACE_DAYS);
        expect(closed).toMatchObject({ id: userId, email: `${userId}@example.com` });
        const { rows } = await getPool().query<{ days: number; version: number }>(
          `SELECT round(extract(epoch FROM deletion_due_at - now()) / 86400)::int AS days, session_version AS version
             FROM users WHERE id = $1`,
          [userId],
        );
        expect(rows[0]).toEqual({ days: ACCOUNT_DELETION_GRACE_DAYS, version: before!.session_version + 1 });
        expect(await statusOf(userId)).toBe('closed');
        expect(await sessionCount(userId)).toBe(0);
        // Nothing scheduled runs for it: the fan-out reads `active` only.
        expect(await queries.listActiveUserIds()).not.toContain(userId);
      });
    });

    it('closes neither a disabled account nor the admin', async () => {
      await withUser(async (userId) => {
        await getPool().query("UPDATE users SET status = 'disabled' WHERE id = $1", [userId]);
        expect(await queries.closeAccount(userId, ACCOUNT_DELETION_GRACE_DAYS)).toBeNull();
        await getPool().query("UPDATE users SET status = 'active', role = 'admin' WHERE id = $1", [userId]);
        expect(await queries.closeAccount(userId, ACCOUNT_DELETION_GRACE_DAYS)).toBeNull();
        expect(await statusOf(userId)).toBe('active');
      });
    });

    it('reopens a closed account before its date, and never a disabled one or one past it', async () => {
      await withUser(async (userId) => {
        await queries.closeAccount(userId, ACCOUNT_DELETION_GRACE_DAYS);
        const version = async () => (await queries.getUser(userId))!.session_version;
        // A password that changed since it was checked reopens nothing (D297).
        expect(await queries.reopenClosedAccount(userId, (await version()) - 1)).toBeNull();
        expect(await queries.reopenClosedAccount(userId, await version())).toMatchObject({ id: userId, status: 'active' });
        const { rows } = await getPool().query('SELECT deletion_due_at FROM users WHERE id = $1', [userId]);
        expect(rows[0]!.deletion_due_at).toBeNull();

        await getPool().query("UPDATE users SET status = 'disabled' WHERE id = $1", [userId]);
        expect(await queries.reopenClosedAccount(userId, await version())).toBeNull();
        expect(await statusOf(userId)).toBe('disabled');

        await getPool().query("UPDATE users SET status = 'active' WHERE id = $1", [userId]);
        await queries.closeAccount(userId, ACCOUNT_DELETION_GRACE_DAYS);
        await backdate(userId, '1 minute');
        expect(await queries.reopenClosedAccount(userId, await version())).toBeNull();
        expect(await statusOf(userId)).toBe('closed');
      });
    });

    it('lets a closed account reset its password during the grace period, and leaves it closed', async () => {
      await withUser(async (userId) => {
        const email = `${userId}@example.com`;
        await getPool().query('UPDATE users SET email_verified_at = now() WHERE id = $1', [userId]);
        await queries.closeAccount(userId, ACCOUNT_DELETION_GRACE_DAYS);
        expect(await queries.getResetRecipient(email)).toMatchObject({ id: userId });

        const token = Buffer.alloc(32, userId.slice(0, 1));
        await getPool().query(
          `INSERT INTO auth_tokens (user_id, purpose, token_hash, email, expires_at)
           VALUES ($1, 'reset_password', $2, $3, now() + interval '30 minutes')`,
          [userId, token, email],
        );
        expect(await queries.useResetToken(token, '$argon2id$v=19$m=19456,t=2,p=1$reset')).toMatchObject({ outcome: 'reset' });
        expect(await statusOf(userId)).toBe('closed');

        // Past its date there is nothing to reset: the erase may be taking it.
        await backdate(userId, '1 minute');
        expect(await queries.getResetRecipient(email)).toBeNull();
      });
    });

    it('counts a sign-in as recent only within the minutes asked, and only for its own user', async () => {
      await withUser(async (userId, sessionId) => {
        expect(await queries.sessionSignedInWithin(userId, sessionId, 10)).toBe(true);
        expect(await queries.sessionSignedInWithin(USER, sessionId, 10)).toBe(false);
        await getPool().query("UPDATE user_sessions SET created_at = now() - interval '11 minutes' WHERE id = $1", [sessionId]);
        expect(await queries.sessionSignedInWithin(userId, sessionId, 10)).toBe(false);
      });
    });

    it('lists and erases an account past its date, with its history, as the app role', async () => {
      await withUser(async (userId) => {
        // An agent brings its ledger (cash, the opening deposit), one of the keys that had no delete rule.
        await getPool().query(
          `INSERT INTO agents (user_id, slug, name, persona, budget_minor) VALUES ($1, 'erase-me', 'E', 'p', 1000)`,
          [userId],
        );
        await getPool().query(`INSERT INTO assistant_conversations (user_id, title) VALUES ($1, 'q')`, [userId]);
        await queries.closeAccount(userId, ACCOUNT_DELETION_GRACE_DAYS);
        expect(await queries.listAccountsDueForErase()).not.toContain(userId);
        expect(await queries.eraseAccount(userId)).toBe(false);

        await backdate(userId, '1 minute');
        expect(await queries.listAccountsDueForErase()).toContain(userId);
        expect(await queries.eraseAccount(userId)).toBe(true);
        expect(await statusOf(userId)).toBeUndefined();
        for (const table of ['agents', 'agent_cash', 'cash_movements', 'assistant_conversations']) {
          const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [userId]);
          expect(rows[0]!.n, table).toBe(0);
        }
      });
    });

    it('dates a rejection, lists a request rejected long enough ago, and forgets the date on restore', async () => {
      const address = `rejected-${randomUUID()}@example.com`;
      const created = await queries.createSignupRequest({ email: address, passwordHash: 'h', timezone: 'UTC', language: 'en', legalVersion: null });
      if (created.outcome !== 'created') throw new Error(`expected a new request, got ${created.outcome}`);
      const userId = created.userId;
      try {
        await getPool().query('UPDATE users SET email_verified_at = now() WHERE id = $1', [userId]);
        await queries.rejectSignup(userId);
        expect(await queries.listRejectedSignupsOlderThan(90)).not.toContain(userId);
        await getPool().query("UPDATE users SET rejected_at = now() - interval '91 days' WHERE id = $1", [userId]);
        expect(await queries.listRejectedSignupsOlderThan(90)).toContain(userId);
        await queries.restoreSignup(userId);
        const { rows } = await getPool().query('SELECT rejected_at FROM users WHERE id = $1', [userId]);
        expect(rows[0]!.rejected_at).toBeNull();
      } finally {
        await getPool().query('DELETE FROM users WHERE id = $1', [userId]);
      }
    });

    it("exports the user's own rows, quantities exact, and never a secret", async () => {
      await withUser(async (userId) => {
        const primary = await queries.primaryAgentId(userId);
        const symbol = `EXP${userId.slice(0, 6)}`.toUpperCase();
        const instrument = (
          await getPool().query<{ id: string }>(`INSERT INTO instruments (symbol, asset_class) VALUES ($1, 'equity') RETURNING id`, [symbol])
        ).rows[0]!.id;
        try {
          await getPool().query(
            `INSERT INTO holdings (user_id, agent_id, instrument_id, quantity, cost_basis_minor) VALUES ($1, $2, $3, '0.123456789012345678', 12345)`,
            [userId, primary, instrument],
          );
          const conversation = (
            await getPool().query<{ id: string }>(`INSERT INTO assistant_conversations (user_id, title) VALUES ($1, 'Q') RETURNING id`, [userId])
          ).rows[0]!.id;
          await getPool().query(
            `INSERT INTO assistant_messages (conversation_id, user_id, role, content) VALUES ($1, $2, 'user', 'What do I hold?')`,
            [conversation, userId],
          );
          await getPool().query(
            `INSERT INTO user_llm_keys (user_id, ciphertext, last_four) VALUES ($1, 'never-exported-ciphertext', 'abcd')`,
            [userId],
          );

          await queries.recordLegalAcceptance(userId, '2026-11-01');

          const text = await queries.exportAccount(userId);
          // The exact digits, as a string: never through a float (guideline 4).
          expect(text).toContain('"quantity": "0.123456789012345678"');
          const document = JSON.parse(text) as Record<string, unknown> & {
            account: { email: string };
            holdings: { symbol: string; cost_basis_minor: number }[];
            conversations: { messages: { content: string }[] }[];
            legalAcceptances: unknown[];
          };
          expect(document.account.email).toBe(`${userId}@example.com`);
          expect(document.holdings).toEqual([expect.objectContaining({ symbol, cost_basis_minor: 12345 })]);
          expect(document.conversations[0]!.messages.map((message) => message.content)).toEqual(['What do I hold?']);
          // What the user agreed to, and when (D265).
          expect(document.legalAcceptances).toEqual([{ version: '2026-11-01', accepted_at: expect.any(String) }]);
          expect(Object.keys(document).sort()).toEqual(
            [
              'account', 'agentScans', 'agentSuggestions', 'agents', 'conversations', 'exportedAt', 'format', 'holdings', 'ledgers',
              'legalAcceptances', 'observations', 'proposalTransitions', 'proposals', 'settings', 'targetWeights', 'topicInstruments', 'topics',
            ].sort(),
          );
          for (const secret of [SECRET_HASH, 'never-exported-ciphertext', 'abcd', 'token_hash', 'session_version', USER]) {
            expect(text, secret).not.toContain(secret);
          }
        } finally {
          await getPool().query('DELETE FROM holdings WHERE user_id = $1', [userId]);
          await getPool().query('DELETE FROM instruments WHERE id = $1', [instrument]);
        }
      });
    });
  });
  describe('legal acceptances (0077, D265)', async () => {
    const { sessionTokenHash } = await import('../src/http/auth.js');
    const VERSION = '2026-11-01';
    const tag = randomUUID().slice(0, 8);
    let saved: { max_pending_signups: number; signup_mode: string };

    beforeAll(async () => {
      saved = (await getPool().query('SELECT max_pending_signups, signup_mode FROM installation_settings')).rows[0];
      await getPool().query("UPDATE installation_settings SET max_pending_signups = 50, signup_mode = 'approval'");
    });

    afterAll(async () => {
      await getPool().query('UPDATE installation_settings SET max_pending_signups = $1, signup_mode = $2', [
        saved.max_pending_signups,
        saved.signup_mode,
      ]);
      await getPool().query('DELETE FROM users WHERE email LIKE $1', [`%-${tag}@legal.example.com`]);
    });

    const accepted = async (userId: string) =>
      (await getPool().query<{ version: string }>('SELECT version FROM legal_acceptances WHERE user_id = $1 ORDER BY version', [userId])).rows.map(
        (row) => row.version,
      );

    it('stores the version a sign-up agreed to with the request, and nothing while there is none', async () => {
      const ask = (name: string, legalVersion: string | null) =>
        queries.createSignupRequest({
          email: `${name}-${tag}@legal.example.com`,
          passwordHash: 'hash',
          timezone: 'UTC',
          language: 'en',
          legalVersion,
        }) as Promise<{ userId: string }>;
      const agreed = await ask('agreed', VERSION);
      expect(await accepted(agreed.userId)).toEqual([VERSION]);
      // The same address asking again, still unverified: the one record stays.
      await ask('agreed', VERSION);
      expect(await accepted(agreed.userId)).toEqual([VERSION]);
      const none = await ask('none', null);
      expect(await accepted(none.userId)).toEqual([]);
    });

    it('records an acceptance once, keeping the first time, and one row per version', async () => {
      const user = (
        await getPool().query<{ id: string }>(
          `INSERT INTO users (email, status, llm_cap_micro_usd) VALUES ($1, 'active', 0) RETURNING id`,
          [`twice-${tag}@legal.example.com`],
        )
      ).rows[0]!.id;
      await queries.recordLegalAcceptance(user, VERSION);
      const first = (await getPool().query('SELECT accepted_at FROM legal_acceptances WHERE user_id = $1', [user])).rows[0]!.accepted_at;
      await queries.recordLegalAcceptance(user, VERSION);
      const again = (await getPool().query('SELECT accepted_at FROM legal_acceptances WHERE user_id = $1', [user])).rows[0]!.accepted_at;
      expect(again).toEqual(first);
      await queries.recordLegalAcceptance(user, '2026-12-01');
      expect(await accepted(user)).toEqual([VERSION, '2026-12-01']);
      expect(await queries.hasAcceptedLegalVersion(user, VERSION)).toBe(true);
      expect(await queries.hasAcceptedLegalVersion(user, '2027-01-01')).toBe(false);
    });

    it("reads with the session whether the user accepted the current version, true while there is none", async () => {
      const user = (
        await getPool().query<{ id: string }>(
          `INSERT INTO users (email, status, llm_cap_micro_usd) VALUES ($1, 'active', 0) RETURNING id`,
          [`session-${tag}@legal.example.com`],
        )
      ).rows[0]!.id;
      const hash = sessionTokenHash(randomUUID());
      await queries.createSession({ userId: user, tokenHash: hash, ttlHours: 1, userAgent: null, ipAddress: null, maxPerUser: SESSIONS_PER_USER_MAX });
      const read = async (version: string | null) => (await queries.getSessionUser(user, hash, 300, version))!.legal_accepted;
      expect(await read(null)).toBe(true);
      expect(await read(VERSION)).toBe(false);
      await queries.recordLegalAcceptance(user, VERSION);
      expect(await read(VERSION)).toBe(true);
      // A newer version asks again (D265).
      expect(await read('2026-12-01')).toBe(false);
    });

    it('serves a Telegram chat, and pushes to it, only once its user accepted - the admin always (D320)', async () => {
      const user = (
        await getPool().query<{ id: string }>(
          `INSERT INTO users (email, status, llm_cap_micro_usd) VALUES ($1, 'active', 0) RETURNING id`,
          [`telegram-${tag}@legal.example.com`],
        )
      ).rows[0]!.id;
      const chat = String(Math.floor(Math.random() * 1e12));
      await getPool().query('INSERT INTO telegram_bindings (user_id, chat_id) VALUES ($1, $2)', [user, chat]);
      try {
        expect(await queries.findTelegramBindingByChat(chat, null)).toMatchObject({ user_id: user, legal_accepted: true });
        expect(await queries.findTelegramPushChat(user, null)).toEqual({ chat_id: chat, active: true, legal_accepted: true });
        expect(await queries.findTelegramBindingByChat(chat, VERSION)).toMatchObject({ legal_accepted: false });
        expect(await queries.findTelegramPushChat(user, VERSION)).toMatchObject({ legal_accepted: false });
        await queries.recordLegalAcceptance(user, VERSION);
        expect(await queries.findTelegramBindingByChat(chat, VERSION)).toMatchObject({ legal_accepted: true });
        expect(await queries.findTelegramPushChat(user, VERSION)).toMatchObject({ legal_accepted: true });
        await getPool().query("UPDATE users SET role = 'admin' WHERE id = $1", [user]);
        expect(await queries.findTelegramPushChat(user, '2027-01-01')).toMatchObject({ legal_accepted: true });
        // The admin's one-time password (D162): the chat is not answered, and nothing is pushed to it.
        await getPool().query('UPDATE users SET password_must_change = true WHERE id = $1', [user]);
        expect(await queries.findTelegramBindingByChat(chat, null)).toBeNull();
        expect(await queries.findTelegramPushChat(user, null)).toMatchObject({ chat_id: chat, active: false });
        await getPool().query('UPDATE users SET password_must_change = false WHERE id = $1', [user]);
        // A closed account is sent nothing, its chat kept (D264, D320).
        await getPool().query("UPDATE users SET status = 'disabled' WHERE id = $1", [user]);
        expect(await queries.findTelegramPushChat(user, null)).toMatchObject({ chat_id: chat, active: false });
      } finally {
        await getPool().query('DELETE FROM telegram_bindings WHERE user_id = $1', [user]);
        await getPool().query("UPDATE users SET role = 'user', status = 'active' WHERE id = $1", [user]);
      }
    });
  });

  describe('the agent review (0079, D335-D338)', () => {
    // As the seeded admin, like the scans above: traders_app may not delete a scan.
    const SEED_ADMIN = '00000000-0000-0000-0000-000000000001';
    const newAgent = async () =>
      (
        await getPool().query(
          `INSERT INTO agents (user_id, slug, name, persona, budget_minor)
           VALUES ($1, $2, $2, 'Patient.', 100000) RETURNING id`,
          [SEED_ADMIN, `review-${randomUUID().slice(0, 8)}`],
        )
      ).rows[0].id as string;

    it('reads the window: counted scans only, newest first, with deposits and cash', async () => {
      const pool = getPool();
      const agent = await newAgent();
      const scan = (startedAt: string, outcome: string, trigger = 'schedule') =>
        pool.query(
          `INSERT INTO agent_scans (user_id, agent_id, trigger, started_at, finished_at, outcome, briefing)
           VALUES ($1, $2, $3, $4, $4::timestamptz + interval '10 seconds', $5, '{}')`,
          [SEED_ADMIN, agent, trigger, startedAt, outcome],
        );
      await scan('2026-10-19T13:00:00Z', 'trade');
      await scan('2026-10-20T13:00:00Z', 'no_trade');
      await scan('2026-10-21T13:00:00Z', 'failed');
      await scan('2026-10-22T13:00:00Z', 'no_trade', 'manual');
      const window = await queries.readReviewWindow(SEED_ADMIN, agent, ['trade', 'no_trade'], 2);
      expect(window).toMatchObject({
        counted: '3',
        scans: '2',
        trade_scans: '0',
        since: new Date('2026-10-20T13:00:00Z'),
        fills: '0',
        fees_minor: '0',
        deposits_minor: '100000',
        cash_minor: '100000',
      });
    });

    it('stores a window once, and a later window of the same rule supersedes the open one', async () => {
      const agent = await newAgent();
      const suggestion = (key: string) => ({
        rule: 'idle_cash',
        dedupeKey: key,
        evidence: { scans: 10 },
        change: { setting: 'risk_level' as const, from: null, to: 1 },
      });
      const [first] = await queries.insertSuggestions(SEED_ADMIN, agent, [suggestion('w1:idle_cash')]);
      expect(await queries.insertSuggestions(SEED_ADMIN, agent, [suggestion('w1:idle_cash')])).toEqual([]);
      const [second] = await queries.insertSuggestions(SEED_ADMIN, agent, [suggestion('w2:idle_cash')]);
      const open = await queries.listOpenSuggestions(SEED_ADMIN, agent);
      expect(open.map((row) => row.id)).toEqual([second]);
      const { rows } = await getPool().query('SELECT status FROM agent_suggestions WHERE id = $1', [first]);
      expect(rows[0].status).toBe('superseded');
    });

    it('applies only while the setting is what the review read, and closes the suggestion either way', async () => {
      const pool = getPool();
      const agent = await newAgent();
      await pool.query("UPDATE agents SET market_caps = '{mega,large}' WHERE id = $1", [agent]);
      const [caps] = await queries.insertSuggestions(SEED_ADMIN, agent, [
        { rule: 'idle_cash', dedupeKey: 'w1:idle_cash', evidence: {}, change: { setting: 'market_caps', from: ['mega', 'large'], to: ['mega', 'large', 'mid'] } },
      ]);
      expect(await queries.applySuggestion(SEED_ADMIN, agent, caps!)).toEqual({ status: 'applied' });
      expect((await queries.getAgent(SEED_ADMIN, agent))?.market_caps).toEqual(['mega', 'large', 'mid']);
      expect(await queries.applySuggestion(SEED_ADMIN, agent, caps!)).toEqual({ status: 'closed' });

      const [risk] = await queries.insertSuggestions(SEED_ADMIN, agent, [
        { rule: 'fee_drag', dedupeKey: 'w1:fee_drag', evidence: {}, change: { setting: 'max_decisions', from: 3, to: 2 } },
      ]);
      expect(await queries.applySuggestion(SEED_ADMIN, agent, risk!)).toEqual({ status: 'stale' });
      expect((await queries.getAgent(SEED_ADMIN, agent))?.max_decisions).toBe(1);

      const [report] = await queries.insertSuggestions(SEED_ADMIN, agent, [
        { rule: 'benchmark_lag', dedupeKey: 'w1:benchmark_lag', evidence: {}, change: null },
      ]);
      expect(await queries.applySuggestion(SEED_ADMIN, agent, report!)).toEqual({ status: 'nothing_to_apply' });
      expect(await queries.dismissSuggestion(SEED_ADMIN, agent, report!)).toBe(true);
      expect(await queries.dismissSuggestion(SEED_ADMIN, agent, report!)).toBe(false);
      expect(await queries.applySuggestion(USER, agent, report!)).toEqual({ status: 'not_found' });
    });
  });
});
