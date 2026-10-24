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
 * the other user's ids in turn - agent, holding, topic, conversation,
 * observation, proposal - and every combination of them where it takes two,
 * and must answer without any of the other user's marks.
 *
 * M10 extends it to writes (D266): every POST, PUT, PATCH and DELETE is asked
 * with the other user's ids too, and must answer 404 - or 403 behind the admin
 * gate - and leave every one of the other user's rows exactly as it was. "Every
 * row" is read from the schema (each table with a `user_id`), so a table added
 * later is fingerprinted without editing this file either. Telegram is tried
 * the same way: a tap on the other user's proposal and a question, both from
 * this user's chat.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TEST_SESSION_SECRET, sessionCookie } from './session.js';
import { memoryRateLimits } from '../src/http/rateLimits.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';

if (DATABASE_URL === '' && process.env.INTEGRATION_REQUIRED === '1') {
  throw new Error('INTEGRATION_REQUIRED=1 but TEST_DATABASE_URL is not set');
}

/** Prefixes that are not a signed-in user's: the gate, the bot, the probes and the installation's. */
const NOT_USER_FACING = ['/admin', '/internal', '/auth', '/health', '/healthz', '/readyz', '/telegram/webhook'];

/** Prefixes no signed-in user's request reaches: the scheduler's (a key) and Telegram's (a secret header). */
const NOT_A_USERS_WRITE = ['/internal', '/telegram/webhook'];

/**
 * A body for every write a signed-in user can send, keyed `METHOD path`, valid
 * enough to get past the route's own checks to its lookup - a 400 for a
 * malformed body would say nothing about whose rows the lookup reads. `null`:
 * the route reads no body. An id inside a body is Omer's (`OMERS`), filled in
 * when the test runs. A write route added later fails "describes every write"
 * until it has an entry here: the list is checked against the app, so it cannot
 * silently fall behind it.
 */
const OMERS = {
  conversation: '<omer.conversation>',
  symbol: '<omer.symbol>',
  agent: '<omer.agent>',
} as const;

const WRITE_BODIES: Record<string, unknown> = {
  'POST /account/reset': {},
  'POST /admin/signups/:userId/approve': {},
  'POST /admin/signups/:userId/reject': null,
  'POST /admin/signups/:userId/restore': null,
  'POST /admin/universe/rescreen': {},
  'POST /admin/users/:userId/disable': null,
  'POST /admin/users/:userId/enable': null,
  'POST /admin/users/:userId/one-time-password': null,
  'PUT /admin/llm/models/:scope': { model: 'test/model' },
  'PUT /admin/settings': {},
  'POST /agents': {},
  'PATCH /agents/:id': { name: 'Renamed' },
  'PUT /agents/:id/model': { model: 'google/gemini-3.5-flash-lite' },
  'POST /agents/:id/instructions-check': null,
  'POST /agents/:id/instructions-check/dismiss': null,
  'POST /agents/:id/scans': null,
  'POST /agents/:id/top-ups': { amount: '10' },
  'POST /agents/:id/trades': { symbol: OMERS.symbol, side: 'buy', quantity: '1' },
  'POST /agents/:id/trades/preview': { symbol: OMERS.symbol, side: 'buy', quantity: '1' },
  'POST /assistant/messages': { message: 'What do I hold?', conversationId: OMERS.conversation },
  'DELETE /assistant/conversations/:id': null,
  'POST /auth/email': { email: 'someone@example.com', currentPassword: 'not the password' },
  'POST /auth/login': {},
  'POST /auth/logout': null,
  'POST /auth/password': { currentPassword: 'not the password', newPassword: 'a new password here' },
  'POST /auth/signup': {},
  'POST /auth/timezone': { timezone: 'Europe/London' },
  'POST /holdings': {},
  'PATCH /holdings/:id': { notes: 'changed' },
  'DELETE /holdings/:id': null,
  'POST /imports/commit': {},
  'POST /imports/preview': {},
  'POST /notifications/digest/seen': { sentAt: '2099-01-01T00:00:00Z' },
  'POST /observations/seen': { upTo: '2099-01-01T00:00:00Z' },
  'POST /proposals/:id/confirm': { shownPriceMinor: 10000 },
  'POST /proposals/:id/decision': { action: 'reject' },
  'POST /proposals/:id/preview': null,
  'POST /proposals/:id/recheck': null,
  'PUT /settings': {},
  'PUT /settings/llm-key': {},
  'DELETE /settings/llm-key': null,
  'PUT /settings/llm-safety-limit': { limitMicroUsd: 20_000_000 },
  'PUT /settings/llm-models/:scope': { model: 'google/gemini-3.5-flash-lite' },
  'PUT /research/agent': { agentId: OMERS.agent },
  'POST /research/runs': null,
  'POST /telegram/bind-token': null,
  'PUT /targets': {},
  'POST /topics': {},
  'POST /topics/resolve': {},
  // AAPL, which the fake resolves: an unresolvable symbol is refused (422) before the topic is looked up.
  'PUT /topics/:id': { label: 'Renamed', symbols: ['AAPL'] },
  'DELETE /topics/:id': null,
  'POST /topics/:id/reject': null,
};

/** Writes with no id in the path that name one of Omer's in the body - so they, too, must answer "not found". */
const NAMES_OMERS_ROW_IN_BODY = new Set(['POST /assistant/messages', 'PUT /research/agent']);

interface SeededUser {
  id: string;
  mark: string;
  symbol: string;
  chatId: number;
  /** Every id of the user's rows, asked of each route with a parameter. */
  ids: string[];
  proposal: string;
  conversation: string;
  /** The simulated agent, for the Telegram agent controls (M11 A2). */
  agent: string;
}

function newUser(mark: string): SeededUser {
  return {
    id: randomUUID(),
    mark,
    symbol: mark.replace('-', '').slice(0, 12),
    chatId: 1_000_000 + Math.floor(Math.random() * 1_000_000_000),
    ids: [],
    proposal: '',
    conversation: '',
    agent: '',
  };
}

describe.skipIf(DATABASE_URL === '')("M9's exit: two users, each seeing only their own", async () => {
  const { getPool, initPool } = await import('../src/db/pool.js');
  const { loadConfig, resetConfigForTests } = await import('../src/config.js');
  const { createApp } = await import('../src/http/app.js');
  const { createFakeAi } = await import('./fakeAi.js');
  const { AiServiceError } = await import('@traders/shared/ai');

  const run = randomUUID().slice(0, 8);
  const dana = newUser(`DANA-${run}`);
  const omer = newUser(`OMER-${run}`);
  const disabled = randomUUID();
  let app: ReturnType<typeof createApp>;

  async function seed(user: SeededUser): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO users (id, email, status, llm_cap_micro_usd, timezone)
       VALUES ($1, $2, 'active', 5000000, 'Europe/London')`,
      [user.id, `${user.mark.toLowerCase()}@example.com`],
    );
    const primary = (await pool.query<{ id: string }>('SELECT id FROM agents WHERE user_id = $1 AND is_primary', [user.id])).rows[0]!.id;
    const agent = (
      await pool.query<{ id: string }>(
        `INSERT INTO agents (user_id, slug, name, persona, budget_minor, model)
         VALUES ($1, $2, $3, $4, 100000, 'acme/retired-model') RETURNING id`,
        [user.id, `agent-${user.mark.toLowerCase()}`, `${user.mark} agent`, `${user.mark} persona`],
      )
    ).rows[0]!.id;
    const instrument = (
      await pool.query<{ id: string }>(
        `INSERT INTO instruments (symbol, asset_class, name) VALUES ($1, 'equity', $2) RETURNING id`,
        [user.symbol, `${user.mark} Corp`],
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
    // An observation and the rebalance proposed on it - the rows the proposal
    // routes and Telegram's buttons act on. A rebalance rather than a buy: a
    // buy needs its agent scan, and the app's role cannot delete scans (they
    // are history), so a user who has one could not be removed afterwards. The
    // lookup every proposal route makes is the same for both kinds.
    const observation = (
      await pool.query<{ id: string }>(
        `INSERT INTO observations (user_id, agent_id, kind, severity, subject_ref, headline, dedupe_key)
         VALUES ($1, $2, 'price_move', 'notable', $3, $4, $5) RETURNING id`,
        [user.id, primary, `instrument:${user.symbol}`, `${user.mark} headline`, `${user.mark}-observation`],
      )
    ).rows[0]!.id;
    const proposal = (
      await pool.query<{ id: string }>(
        `INSERT INTO proposals (user_id, agent_id, observation_id, kind, expires_at)
         VALUES ($1, $2, $3, 'rebalance', now() + interval '1 day') RETURNING id`,
        [user.id, primary, observation],
      )
    ).rows[0]!.id;
    await pool.query(
      `INSERT INTO notifications (user_id, agent_id, channel, ref_kind, ref_id, route, reason, dedupe_key)
       VALUES ($1, $2, 'digest', 'observation', $3, 'digest', 'above_floor', $4)`,
      [user.id, primary, observation, `${user.mark}-notification`],
    );
    await pool.query(
      `INSERT INTO portfolio_snapshots (user_id, agent_id, as_of, total_minor, currency)
       VALUES ($1, $2, current_date, 30000, 'USD')`,
      [user.id, primary],
    );
    await pool.query(
      `INSERT INTO target_weights (user_id, agent_id, instrument_id, weight) VALUES ($1, $2, $3, 0.5)`,
      [user.id, primary, instrument],
    );
    await pool.query(`INSERT INTO telegram_bindings (user_id, chat_id) VALUES ($1, $2)`, [user.id, user.chatId]);
    await pool.query(
      `INSERT INTO user_settings (user_id, llm_explain_model, llm_assistant_model)
       VALUES ($1, 'acme/explain-model', 'acme/retired-model') ON CONFLICT DO NOTHING`,
      [user.id],
    );
    // A fallback the AI service recorded (D286), so its table is fingerprinted with a row.
    const fallback = (
      await pool.query<{ id: string }>(
        `INSERT INTO model_fallbacks (user_id, agent_id, scope, saved_model, effective_model)
         VALUES ($1, $2, 'agent', 'acme/retired-model', 'google/gemini-3.5-flash-lite') RETURNING id`,
        [user.id, agent],
      )
    ).rows[0]!.id;
    // The agent assigned to research the main portfolio, a run and its rating (D254).
    await pool.query(`UPDATE user_settings SET research_agent_id = $2 WHERE user_id = $1`, [user.id, agent]);
    const research = (
      await pool.query<{ id: string }>(
        `INSERT INTO research_runs (user_id, agent_id, trigger, status, holdings, rated, finished_at)
         VALUES ($1, $2, 'manual', 'done', 1, 1, now()) RETURNING id`,
        [user.id, agent],
      )
    ).rows[0]!.id;
    await pool.query(
      `INSERT INTO research_ratings (run_id, user_id, agent_id, instrument_id, symbol, status, rating, rationale)
       VALUES ($1, $2, $3, $4, $5, 'rated', 'bullish', $6)`,
      [research, user.id, agent, instrument, user.symbol, `${user.mark} rationale`],
    );
    user.proposal = proposal;
    user.agent = agent;
    user.conversation = conversation;
    user.ids.push(primary, agent, holding, topic, conversation, observation, proposal, fallback, research);
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
      isolationAi(),
    );
  });

  /** Who the app asked the assistant for, in the order it asked. */
  const askedFor: string[] = [];

  /**
   * The fake AI service, plus the two calls the writes reach that it lacks.
   * The assistant answers as the real service does (`assistant/conversations.py`
   * `find`, proved by `test_another_users_conversation_is_not_found`): a
   * conversation that is not the asking user's is 404. So the app passing on
   * the signed-in user's id is what makes Omer's conversation "not found" here -
   * had it sent his id, the stub would have answered.
   */
  function isolationAi(): ReturnType<typeof createFakeAi> {
    return {
      ...createFakeAi(),
      async resolveTopic(topic: string) {
        return {
          topic,
          verdict: 'none',
          ambiguous: false,
          best_similarity: null,
          confident_above: 0.5,
          refuse_below: 0.3,
          embedding_model: 'fixture',
          vector_is_semantic: false,
          interpretations: [],
          universe: { state: 'loaded', profiles: 0, embedded: 0 },
        };
      },
      async assistantMessage(request: { user_id: string; conversation_id?: string | null }) {
        askedFor.push(request.user_id);
        const { rows } = await getPool().query(
          'SELECT 1 FROM assistant_conversations WHERE id = $1 AND user_id = $2',
          [request.conversation_id, request.user_id],
        );
        if (rows.length === 0) throw new AiServiceError('no such conversation', 404);
        throw new Error('only a refusal is expected of this stub');
      },
    } as unknown as ReturnType<typeof createFakeAi>;
  }

  afterAll(async () => {
    const pool = getPool();
    const users = [dana.id, omer.id, disabled];
    // Not every table cascades from `users` (M9-MEASUREMENT §7): those that do
    // not go first, proposals before the scans they name.
    await pool.query('DELETE FROM proposals WHERE user_id = ANY($1::uuid[])', [users]);
    // Scans, fills, cash movements and refused attempts are history the app's
    // role cannot delete, and no request here makes one - Omer's ids are refused.
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

  /**
   * Every concrete path for a route asked with Omer's ids: each id in each
   * parameter, so a route with two (`/agents/:id/scans/:scanId`) is asked with
   * his agent and his scan together, not only the same id twice.
   */
  function withOmersIds(path: string): string[] {
    let paths = [path];
    while (paths.some((candidate) => /:[A-Za-z]+/.test(candidate))) {
      paths = paths.flatMap((candidate) => omer.ids.map((id) => candidate.replace(/:[A-Za-z]+/, id)));
    }
    return paths;
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
      for (const concrete of withOmersIds(path)) {
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
  /** Every route a signed-in user could send a write to, as `METHOD path`. */
  function userWrites(): string[] {
    const writes = app.routes
      .filter((route) => route.method !== 'GET' && route.method !== 'ALL')
      .filter((route) => !NOT_A_USERS_WRITE.some((prefix) => route.path === prefix || route.path.startsWith(`${prefix}/`)))
      .filter((route) => !route.path.includes('*'))
      .map((route) => `${route.method} ${route.path}`);
    return [...new Set(writes)].sort();
  }

  /**
   * A fingerprint of every row of Omer's: each table with a `user_id`, read from
   * the schema, plus his own `users` row. Equal before and after means nothing
   * of his changed - inserted, updated or deleted.
   */
  async function omersRows(): Promise<Record<string, string>> {
    const pool = getPool();
    const { rows: tables } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'user_id' ORDER BY table_name`,
    );
    const fingerprint: Record<string, string> = {};
    for (const { table_name: table } of tables) {
      const { rows } = await pool.query<{ digest: string; count: number }>(
        `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest, count(*)::int AS count
         FROM ${table} t WHERE user_id = $1`,
        [omer.id],
      );
      fingerprint[table] = `${rows[0]!.count}:${rows[0]!.digest}`;
    }
    const { rows } = await pool.query<{ row: string }>(`SELECT u::text AS row FROM users u WHERE id = $1`, [omer.id]);
    fingerprint.users = rows[0]!.row;
    return fingerprint;
  }

  function bodyFor(write: string): string | undefined {
    const body = WRITE_BODIES[write];
    if (body === null || body === undefined) return undefined;
    return JSON.stringify(body)
      .replaceAll(OMERS.conversation, omer.conversation)
      .replaceAll(OMERS.symbol, omer.symbol)
      .replaceAll(OMERS.agent, omer.agent);
  }

  it('describes every write a signed-in user can send, so a new one is not skipped (D266)', () => {
    const writes = userWrites();
    expect(writes.length).toBeGreaterThan(30);
    expect(writes.filter((write) => !(write in WRITE_BODIES))).toEqual([]);
    // And nothing listed that the app no longer has, so the list stays the app's.
    expect(Object.keys(WRITE_BODIES).filter((write) => !writes.includes(write))).toEqual([]);
  });

  it("never lets Dana change or read anything of Omer's, through any write, with any of his ids (D266)", async () => {
    const before = await omersRows();
    const wrong: string[] = [];
    for (const write of userWrites()) {
      const [method, path] = write.split(' ') as [string, string];
      const expected = path.startsWith('/admin') ? 403 : path.includes(':') || NAMES_OMERS_ROW_IN_BODY.has(write) ? 404 : null;
      for (const concrete of withOmersIds(path)) {
        const body = bodyFor(write);
        const response = await app.request(concrete, {
          method,
          headers: {
            cookie: sessionCookie(dana.id),
            origin: 'http://localhost:5173',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body }),
        });
        const text = await response.text();
        const leaked = leaks(text);
        if (leaked.length > 0) wrong.push(`${method} ${concrete} -> ${response.status} leaked ${leaked.join(', ')}`);
        if (expected !== null && response.status !== expected) {
          wrong.push(`${method} ${concrete} -> ${response.status}, expected ${expected}: ${text.slice(0, 120)}`);
        }
      }
    }
    expect(wrong).toEqual([]);
    expect(await omersRows()).toEqual(before);
    // Ask was reached, and asked only ever for the signed-in user.
    expect(askedFor.length).toBeGreaterThan(0);
    expect(new Set(askedFor)).toEqual(new Set([dana.id]));
  });

  it("does nothing to Omer's proposal when Dana's chat taps any of its buttons (D266)", async () => {
    const { buildNotifier } = await import('../src/notify/factory.js');
    const { encodeCallbackData, mintNonce } = await import('../src/telegram/callbackToken.js');
    const { handleTelegramUpdate } = await import('../src/telegram/updates.js');
    resetConfigForTests();
    const config = loadConfig({
      APP_ENV: 'test',
      LOG_LEVEL: 'error',
      SESSION_SECRET: TEST_SESSION_SECRET,
      DATABASE_URL,
      AI_SERVICE_URL: 'http://ai-service:8000',
      INTERNAL_API_KEY: 'internal-test-key',
      TELEGRAM_SIGNING_SECRET: 'telegram-signing-secret-for-tests',
    } as unknown as NodeJS.ProcessEnv);
    const deps = { config, notifier: buildNotifier(config), ai: createFakeAi(), rateLimits: memoryRateLimits() };

    const before = await omersRows();
    for (const action of ['approve', 'confirm', 'reject', 'snooze', 'undo', 'recheck'] as const) {
      const data = encodeCallbackData(
        { proposalId: omer.proposal, action, nonce: mintNonce(), ...(action === 'confirm' ? { priceMinor: 10000n } : {}) },
        config.TELEGRAM_SIGNING_SECRET!,
      );
      await handleTelegramUpdate(deps, {
        update_id: 1,
        callback_query: { id: `tap-${action}`, data, message: { message_id: 1, text: 'x', chat: { id: dana.chatId, type: 'private' } } },
      });
    }
    expect(await omersRows()).toEqual(before);

    // The control: the same tap on Dana's own proposal does take - so the taps
    // above reached the decision and were refused there, not lost on the way.
    await handleTelegramUpdate(deps, {
      update_id: 1,
      callback_query: {
        id: 'tap-own',
        data: encodeCallbackData({ proposalId: dana.proposal, action: 'reject', nonce: mintNonce() }, config.TELEGRAM_SIGNING_SECRET!),
        message: { message_id: 1, text: 'x', chat: { id: dana.chatId, type: 'private' } },
      },
    });
    const { rows } = await getPool().query<{ state: string }>('SELECT state FROM proposals WHERE id = $1', [dana.proposal]);
    expect(rows[0]!.state).toBe('rejected');
  });

  it("changes nothing of Omer's agent when Dana's chat taps its signed controls (D274)", async () => {
    const { TelegramNotifier } = await import('../src/telegram/client.js');
    const { encodeAgentActionData } = await import('../src/telegram/agentActionToken.js');
    const { handleTelegramUpdate } = await import('../src/telegram/updates.js');
    resetConfigForTests();
    const secret = 'telegram-signing-secret-for-tests';
    const config = loadConfig({
      APP_ENV: 'test',
      LOG_LEVEL: 'error',
      SESSION_SECRET: TEST_SESSION_SECRET,
      DATABASE_URL,
      AI_SERVICE_URL: 'http://ai-service:8000',
      INTERNAL_API_KEY: 'internal-test-key',
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_SIGNING_SECRET: secret,
    } as unknown as NodeJS.ProcessEnv);
    // A recording client: with no Telegram channel the bot would not act at all,
    // and "nothing changed" would prove nothing.
    const answered: string[] = [];
    const notifier = new TelegramNotifier({
      botToken: 'bot-token',
      callbackSecret: secret,
      resolveChatId: async () => String(dana.chatId),
      fetchImpl: async (url, init) => {
        if (url.endsWith('/answerCallbackQuery')) answered.push(String(JSON.parse(String(init?.body)).callback_query_id));
        return new Response('{"ok":true}', { status: 200 });
      },
    });
    const scanAgent = vi.fn(async () => {
      throw new Error('no scan may start for Omer');
    });
    const deps = { config, notifier, ai: { ...createFakeAi(), scanAgent } as never, rateLimits: memoryRateLimits() };
    const tap = async (id: string, data: string) => {
      await handleTelegramUpdate(deps, {
        update_id: 3,
        callback_query: { id, data, message: { message_id: 1, text: 'x', chat: { id: dana.chatId, type: 'private' } } },
      });
      await vi.waitFor(() => expect(answered).toContain(id));
    };

    const before = await omersRows();
    const payloads = [
      { agentId: omer.agent, action: 'pause' },
      { agentId: omer.agent, action: 'resume' },
      { agentId: omer.agent, action: 'run' },
      { agentId: omer.agent, action: 'schedule', schedule: { everyHours: 1, preOpen: false, postClose: true } },
    ] as const;
    for (const [index, payload] of payloads.entries()) await tap(`omer-${index}`, encodeAgentActionData(payload, secret));
    expect(await omersRows()).toEqual(before);
    expect(scanAgent).not.toHaveBeenCalled();

    // The control: Dana pausing her own agent does take - so the taps above
    // reached the service and were refused there, not lost on the way.
    await tap('dana-pause', encodeAgentActionData({ agentId: dana.agent, action: 'pause' }, secret));
    const { rows } = await getPool().query<{ state: string }>('SELECT state FROM agents WHERE id = $1', [dana.agent]);
    expect(rows[0]!.state).toBe('paused');
  });

  it("treats a disabled user's chat as unbound: no question, scan or change (D278)", async () => {
    const { TelegramNotifier } = await import('../src/telegram/client.js');
    const { encodeAgentActionData } = await import('../src/telegram/agentActionToken.js');
    const { findTelegramBindingByChat } = await import('../src/db/queries.js');
    const { handleTelegramUpdate } = await import('../src/telegram/updates.js');
    const pool = getPool();
    const chatId = 2_000_000_000 + Math.floor(Math.random() * 1_000_000);
    const agent = (
      await pool.query<{ id: string }>(
        `INSERT INTO agents (user_id, slug, name, persona, budget_minor, state)
         VALUES ($1, 'agent-disabled', 'Disabled agent', 'A persona', 100000, 'paused') RETURNING id`,
        [disabled],
      )
    ).rows[0]!.id;
    await pool.query(`INSERT INTO telegram_bindings (user_id, chat_id) VALUES ($1, $2)`, [disabled, chatId]);
    try {
      expect(await findTelegramBindingByChat(String(chatId))).toBeNull();

      resetConfigForTests();
      const secret = 'telegram-signing-secret-for-tests';
      const config = loadConfig({
        APP_ENV: 'test',
        LOG_LEVEL: 'error',
        SESSION_SECRET: TEST_SESSION_SECRET,
        DATABASE_URL,
        AI_SERVICE_URL: 'http://ai-service:8000',
        INTERNAL_API_KEY: 'internal-test-key',
        TELEGRAM_BOT_TOKEN: 'bot-token',
        TELEGRAM_SIGNING_SECRET: secret,
      } as unknown as NodeJS.ProcessEnv);
      const answered: string[] = [];
      const notifier = new TelegramNotifier({
        botToken: 'bot-token',
        callbackSecret: secret,
        resolveChatId: async () => String(chatId),
        fetchImpl: async (url, init) => {
          if (url.endsWith('/answerCallbackQuery')) answered.push(String(JSON.parse(String(init?.body)).text));
          return new Response('{"ok":true}', { status: 200 });
        },
      });
      const assistantMessage = vi.fn();
      const scanAgent = vi.fn();
      const deps = { config, notifier, ai: { ...createFakeAi(), assistantMessage, scanAgent } as never, rateLimits: memoryRateLimits() };
      const chat = { id: chatId, type: 'private' };

      await handleTelegramUpdate(deps, { update_id: 4, message: { text: 'What do I hold?', chat } });
      await handleTelegramUpdate(deps, {
        update_id: 5,
        callback_query: {
          id: 'disabled-resume',
          data: encodeAgentActionData({ agentId: agent, action: 'resume' }, secret),
          message: { message_id: 1, text: 'x', chat },
        },
      });
      await vi.waitFor(() => expect(answered).toHaveLength(1));
      expect(assistantMessage).not.toHaveBeenCalled();
      expect(scanAgent).not.toHaveBeenCalled();
      const { rows } = await pool.query<{ state: string }>('SELECT state FROM agents WHERE id = $1', [agent]);
      expect(rows[0]!.state).toBe('paused');
    } finally {
      await pool.query('DELETE FROM telegram_bindings WHERE user_id = $1', [disabled]);
      await pool.query('DELETE FROM agents WHERE id = $1', [agent]);
    }
  });

  it("answers a question from Dana's chat as Dana, never in Omer's conversation (D266)", async () => {
    const { buildNotifier } = await import('../src/notify/factory.js');
    const { handleTelegramUpdate } = await import('../src/telegram/updates.js');
    resetConfigForTests();
    const config = loadConfig({
      APP_ENV: 'test',
      LOG_LEVEL: 'error',
      SESSION_SECRET: TEST_SESSION_SECRET,
      DATABASE_URL,
      AI_SERVICE_URL: 'http://ai-service:8000',
      INTERNAL_API_KEY: 'internal-test-key',
    } as unknown as NodeJS.ProcessEnv);
    const asked: { user_id: string; conversation_id?: string | null }[] = [];
    const ai = {
      ...createFakeAi(),
      async assistantMessage(request: { user_id: string; conversation_id?: string | null }) {
        asked.push(request);
        throw new Error('answered elsewhere: this test reads only who asked');
      },
    } as unknown as ReturnType<typeof createFakeAi>;

    await handleTelegramUpdate(
      { config, notifier: buildNotifier(config), ai, rateLimits: memoryRateLimits() },
      { update_id: 2, message: { text: 'What do I hold?', chat: { id: dana.chatId, type: 'private' } } },
    );
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]!.user_id).toBe(dana.id);
    expect(asked[0]!.conversation_id ?? null).not.toBe(omer.conversation);
  });
});
