/**
 * M9's exit test (docs/MILESTONES.md): two users on one installation, each
 * seeing only their own - proved over real SQL, with the real app, signed in as
 * one user and asking every user-facing GET route for the other's data; the
 * scheduled work runs for both; and no run falls back to a default account.
 *
 * Opt-in by `TEST_DATABASE_URL`, like `queries.postgres.test.ts`, whose rules
 * it follows: a `_ci` or `_test` database at head, never read from `.env`.
 *
 * The routes are read from the app itself, so a route added later is covered
 * without editing this file. A route with a parameter is asked with each of
 * the other user's ids in turn - agent, holding, topic, conversation - and must
 * answer without any of the other user's marks.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TEST_SESSION_SECRET, sessionCookie } from './session.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';

if (DATABASE_URL === '' && process.env.INTEGRATION_REQUIRED === '1') {
  throw new Error('INTEGRATION_REQUIRED=1 but TEST_DATABASE_URL is not set');
}

/** Prefixes that are not a signed-in user's: the gate, the bot, the probes and the installation's. */
const NOT_USER_FACING = ['/admin', '/internal', '/auth', '/health', '/healthz', '/readyz', '/telegram/webhook'];

describe.skipIf(DATABASE_URL === '')("M9's exit: two users, each seeing only their own", async () => {
  const { getPool, initPool } = await import('../src/db/pool.js');
  const { loadConfig, resetConfigForTests } = await import('../src/config.js');
  const { createApp } = await import('../src/http/app.js');
  const { createFakeAi } = await import('./fakeAi.js');

  const run = randomUUID().slice(0, 8);
  const dana = { id: randomUUID(), mark: `DANA-${run}`, ids: [] as string[] };
  const omer = { id: randomUUID(), mark: `OMER-${run}`, ids: [] as string[] };
  const disabled = randomUUID();
  let app: ReturnType<typeof createApp>;

  async function seed(user: { id: string; mark: string; ids: string[] }): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO users (id, email, status, llm_cap_micro_usd, timezone)
       VALUES ($1, $2, 'active', 5000000, 'Europe/London')`,
      [user.id, `${user.mark.toLowerCase()}@example.com`],
    );
    const primary = (await pool.query<{ id: string }>('SELECT id FROM agents WHERE user_id = $1 AND is_primary', [user.id])).rows[0]!.id;
    const agent = (
      await pool.query<{ id: string }>(
        `INSERT INTO agents (user_id, slug, name, persona, budget_minor)
         VALUES ($1, $2, $3, $4, 100000) RETURNING id`,
        [user.id, `agent-${user.mark.toLowerCase()}`, `${user.mark} agent`, `${user.mark} persona`],
      )
    ).rows[0]!.id;
    const instrument = (
      await pool.query<{ id: string }>(
        `INSERT INTO instruments (symbol, asset_class, name) VALUES ($1, 'equity', $2) RETURNING id`,
        [user.mark.replace('-', '').slice(0, 12), `${user.mark} Corp`],
      )
    ).rows[0]!.id;
    const holding = (
      await pool.query<{ id: string }>(
        `INSERT INTO holdings (user_id, agent_id, instrument_id, quantity, cost_basis_minor, notes)
         VALUES ($1, $2, $3, 3, 10000, $4) RETURNING id`,
        [user.id, primary, instrument, `${user.mark} note`],
      )
    ).rows[0]!.id;
    const topic = (
      await pool.query<{ id: string }>(
        `INSERT INTO topics (user_id, label, status, created_by, confirmed_at)
         VALUES ($1, $2, 'active', 'user', now()) RETURNING id`,
        [user.id, `${user.mark} topic`],
      )
    ).rows[0]!.id;
    const conversation = (
      await pool.query<{ id: string }>(
        `INSERT INTO assistant_conversations (user_id, title) VALUES ($1, $2) RETURNING id`,
        [user.id, `${user.mark} conversation`],
      )
    ).rows[0]!.id;
    user.ids.push(primary, agent, holding, topic, conversation);
  }

  beforeAll(async () => {
    const name = new URL(DATABASE_URL).pathname.slice(1);
    if (!/_(ci|test)$/.test(name)) throw new Error(`TEST_DATABASE_URL names '${name}'; it must end in _ci or _test`);
    initPool(DATABASE_URL);
    await seed(dana);
    await seed(omer);
    await getPool().query(
      `INSERT INTO users (id, status, llm_cap_micro_usd) VALUES ($1, 'disabled', 0)`,
      [disabled],
    );
    resetConfigForTests();
    app = createApp(
      loadConfig({
        APP_ENV: 'test',
        LOG_LEVEL: 'error',
        SESSION_SECRET: TEST_SESSION_SECRET,
        DATABASE_URL,
        AI_SERVICE_URL: 'http://ai-service:8000',
        INTERNAL_API_KEY: 'internal-test-key',
        ALLOWED_ORIGINS: 'http://localhost:5173',
      } as unknown as NodeJS.ProcessEnv),
      createFakeAi(),
    );
  });

  afterAll(async () => {
    const pool = getPool();
    const users = [dana.id, omer.id, disabled];
    // Not every table cascades from `users` (0052's conversations do not).
    await pool.query('DELETE FROM assistant_conversations WHERE user_id = ANY($1::uuid[])', [users]);
    await pool.query('DELETE FROM runs WHERE user_id = ANY($1::uuid[])', [users]);
    // `agent_cash` names the user without a cascade; the agent's own delete takes it.
    await pool.query('DELETE FROM agents WHERE user_id = ANY($1::uuid[]) AND NOT is_primary', [users]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
    await pool.query('DELETE FROM instruments WHERE name = ANY($1::text[])', [[`${dana.mark} Corp`, `${omer.mark} Corp`]]);
    await pool.end();
  });

  function userFacingGets(): string[] {
    const paths = app.routes
      .filter((route) => route.method === 'GET')
      .map((route) => route.path)
      .filter((path) => !NOT_USER_FACING.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)))
      .filter((path) => !path.includes('*'));
    return [...new Set(paths)];
  }

  async function read(path: string): Promise<{ status: number; text: string }> {
    const response = await app.request(path, { headers: { cookie: sessionCookie(dana.id) } });
    return { status: response.status, text: await response.text() };
  }

  function leaks(text: string): string[] {
    return [omer.mark, omer.id, ...omer.ids].filter((mark) => text.includes(mark));
  }

  it('reads a user-facing route list worth testing', () => {
    const paths = userFacingGets();
    for (const expected of ['/portfolio', '/agents', '/agents/:id', '/topics', '/assistant/conversations', '/settings']) {
      expect(paths.some((path) => path.startsWith(expected.split(':')[0]!)), expected).toBe(true);
    }
  });

  it("shows Dana her own agents, topics and conversations - so 'nothing of Omer's' is not an empty page", async () => {
    for (const path of ['/agents', '/topics', '/assistant/conversations']) {
      const { status, text } = await read(path);
      expect(status, path).toBe(200);
      expect(text, path).toContain(dana.mark);
    }
  });

  it("never answers Dana with anything of Omer's, on any GET route, with any of his ids", async () => {
    const found: string[] = [];
    for (const path of userFacingGets()) {
      const asked = path.includes(':')
        ? omer.ids.map((id) => path.replace(/:[A-Za-z]+/g, id))
        : [path];
      for (const concrete of asked) {
        const { status, text } = await read(concrete);
        const leaked = leaks(text);
        if (leaked.length > 0) found.push(`${concrete} -> ${status}: ${leaked.join(', ')}`);
        if (path.includes(':') && status === 200 && text.length > 0) {
          // A detail route asked for someone else's id is "not found", or a
          // page about nothing - never a 200 about the id itself.
          expect(text, concrete).not.toContain(omer.mark);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('runs a user\'s scheduled work for both, and for nobody who is disabled (D161)', async () => {
    const response = await app.request('/internal/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': 'internal-test-key' },
      body: JSON.stringify({ kind: 'daily_digest', for: 'every_active_user', trigger: 'test' }),
    });
    const body = (await response.json()) as { results: { userId: string }[] };
    const ran = body.results.map((result) => result.userId);
    expect(ran).toEqual(expect.arrayContaining([dana.id, omer.id]));
    expect(ran).not.toContain(disabled);
    const { rows } = await getPool().query<{ user_id: string }>(
      `SELECT user_id FROM runs WHERE kind = 'daily_digest' AND user_id = ANY($1::uuid[])`,
      [[dana.id, omer.id, disabled]],
    );
    expect(rows.map((row) => row.user_id).sort()).toEqual([dana.id, omer.id].sort());
  });

  it('refuses a run that names no user, rather than running it as anybody', async () => {
    const response = await app.request('/internal/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': 'internal-test-key' },
      body: JSON.stringify({ kind: 'portfolio_scan', trigger: 'test' }),
    });
    expect(response.status).toBe(400);
  });

  it("refuses a disabled user's session at once (D160, D239)", async () => {
    const response = await app.request('/portfolio', { headers: { cookie: sessionCookie(disabled) } });
    expect(response.status).toBe(401);
  });
});
