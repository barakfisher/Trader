/**
 * HTTP-level tests for the API surface: auth gating, the CSRF origin check, the
 * single error shape and the internal-route key. The database layer is mocked so
 * these run with no infrastructure; valuation itself is covered separately in
 * valuation.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnapshotsResponse } from '@traders/shared';

const USER = {
  id: '00000000-0000-0000-0000-000000000001',
  email: null,
  base_currency: 'USD',
  timezone: 'Asia/Jerusalem',
};

const holdingRow = {
  id: 'holding-1',
  user_id: USER.id,
  instrument_id: 'instrument-1',
  quantity: '10',
  cost_basis_minor: '18540',
  currency: 'USD',
  opened_at: null,
  notes: null,
  symbol: 'AAPL',
  name: 'Apple Inc.',
  asset_class: 'equity',
  exchange: 'TEST',
  instrument_currency: 'USD',
};

vi.mock('../src/db/pool.js', () => ({
  queryOne: vi.fn(async () => ({ ok: 1 })),
  query: vi.fn(async () => []),
  transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
  initPool: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../src/db/queries.js', () => ({
  getUser: vi.fn(async () => USER),
  listHoldings: vi.fn(async () => [holdingRow]),
  listSnapshots: vi.fn(async () => []),
  recordQuotes: vi.fn(async () => undefined),
  getHolding: vi.fn(async () => holdingRow),
  upsertInstrument: vi.fn(async () => ({ id: 'instrument-1', symbol: 'AAPL' })),
  upsertHolding: vi.fn(async () => ({ id: 'holding-1', inserted: true })),
  updateHolding: vi.fn(async () => holdingRow),
  deleteHolding: vi.fn(async () => true),
  deleteAllHoldings: vi.fn(async () => 0),
  upsertSnapshot: vi.fn(async () => undefined),
  claimRun: vi.fn(),
  finishRun: vi.fn(async () => undefined),
  listRuns: vi.fn(async () => []),
  insertObservations: vi.fn(async () => ({ created: 0, suppressed: 0, inserted: [] })),
  getOrCreateUserSettings: vi.fn(async () => ({
    proposal_severity: 'high',
    proposal_ttl_hours: 24,
    notify_severity: 'high',
    quiet_hours_start: '22:00',
    quiet_hours_end: '07:00',
    muted_until: null,
  })),
  createProposals: vi.fn(async () => []),
  listObservations: vi.fn(async () => []),
  listRecentDedupeKeys: vi.fn(async () => []),
  listTargetWeights: vi.fn(async () => []),
  findInstrumentsBySymbols: vi.fn(async () => []),
  listInstrumentsWithoutName: vi.fn(async () => []),
  listAnalysedInstruments: vi.fn(async () => [
    { id: 'instrument-1', symbol: 'AAPL', name: 'Apple Inc.', asset_class: 'equity' },
  ]),
  setInstrumentName: vi.fn(async () => true),
  replaceTargetWeights: vi.fn(async () => 0),
  transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
}));

const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');

const fakeAi = await import('./fakeAi.js');
const { createFakeAi } = fakeAi;
const { DISCOVERY_WINDOW_DAYS } = await import('../src/services/topicDiscovery.js');
const queries = await import('../src/db/queries.js');

/** One claim succeeds, every later claim of the same key is refused - which is
 *  what the runs table does, without needing a database in this suite. */
function stubRunClaims() {
  const claimed = new Set<string>();
  vi.mocked(queries.claimRun).mockImplementation(async ({ runKey }) => {
    if (claimed.has(runKey)) {
      return { claimed: false, runId: null, existingStatus: 'ok' };
    }
    claimed.add(runKey);
    return { claimed: true, runId: `run-${claimed.size}` };
  });
}

const ENV = {
  APP_ENV: 'test',
  LOG_LEVEL: 'error',
  APP_PASSPHRASE: 'test-passphrase',
  SESSION_SECRET: 'test-session-secret-value',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  AI_SERVICE_URL: 'http://ai-service:8000',
  INTERNAL_API_KEY: 'internal-test-key',
  ALLOWED_ORIGINS: 'http://localhost:5173',
} as unknown as NodeJS.ProcessEnv;

const ORIGIN = { origin: 'http://localhost:5173', 'content-type': 'application/json' };

let scanStats: Record<string, unknown> = {};

function buildApp() {
  resetConfigForTests();
  return createApp(loadConfig(ENV), createFakeAi({ scanStats }));
}

async function loginCookie(app: ReturnType<typeof buildApp>): Promise<string> {
  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: ORIGIN,
    body: JSON.stringify({ passphrase: 'test-passphrase' }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie');
  expect(cookie).toBeTruthy();
  return (cookie as string).split(';')[0]!;
}

describe('API', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    stubRunClaims();
    scanStats = {};
    app = buildApp();
  });

  it('serves liveness without a session', async () => {
    const response = await app.request('/healthz');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', service: 'orchestrator' });
  });

  it('rejects an unauthenticated portfolio read', async () => {
    const response = await app.request('/portfolio');
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('rejects a wrong passphrase without revealing anything', async () => {
    const response = await app.request('/auth/login', {
      method: 'POST',
      headers: ORIGIN,
      body: JSON.stringify({ passphrase: 'wrong' }),
    });
    expect(response.status).toBe(401);
  });

  it('issues an httpOnly session cookie on login', async () => {
    const response = await app.request('/auth/login', {
      method: 'POST',
      headers: ORIGIN,
      body: JSON.stringify({ passphrase: 'test-passphrase' }),
    });
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('returns a valued portfolio for an authenticated session', async () => {
    const cookie = await loginCookie(app);
    const response = await app.request('/portfolio', { headers: { cookie } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { summary: { totalValueMinor: number }; holdings: unknown[] };
    expect(body.summary.totalValueMinor).toBe(232140);
    expect(body.holdings).toHaveLength(1);
  });

  it('reports snapshot completeness on the equity curve', async () => {
    const { listSnapshots } = await import('../src/db/queries.js');
    vi.mocked(listSnapshots).mockResolvedValueOnce([
      {
        as_of: new Date('2026-09-14T00:00:00Z'),
        total_minor: '6785800',
        cost_minor: '5000000',
        currency: 'USD',
        holdings_count: 10,
        priced_count: 9,
        degraded: true,
      },
    ] as never);

    const cookie = await loginCookie(app);
    const response = await app.request('/portfolio/snapshots', { headers: { cookie } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as SnapshotsResponse;
    // A client charting this point has to be able to see that it is incomplete.
    expect(body.snapshots[0]).toEqual({
      asOf: '2026-09-14',
      totalMinor: 6785800,
      costMinor: 5000000,
      currency: 'USD',
      holdingsCount: 10,
      pricedCount: 9,
      degraded: true,
    });
  });

  it('blocks a state-changing request from an unknown origin', async () => {
    const cookie = await loginCookie(app);
    const response = await app.request('/holdings', {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ symbol: 'AAPL', quantity: '1' }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'bad_origin' });
  });

  it('rejects a holding whose symbol no provider can price', async () => {
    const cookie = await loginCookie(app);
    const response = await app.request('/holdings', {
      method: 'POST',
      headers: { ...ORIGIN, cookie },
      body: JSON.stringify({ symbol: 'NOSUCH', quantity: '1' }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: 'unresolved_symbol' });
  });

  it('validates the holding payload', async () => {
    const cookie = await loginCookie(app);
    const response = await app.request('/holdings', {
      method: 'POST',
      headers: { ...ORIGIN, cookie },
      body: JSON.stringify({ symbol: 'AAPL', quantity: 'ten' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_body' });
  });

  it('previews an import without writing anything', async () => {
    const cookie = await loginCookie(app);
    const response = await app.request('/imports/preview', {
      method: 'POST',
      headers: { ...ORIGIN, cookie },
      body: JSON.stringify({
        filename: 'p.csv',
        content: 'symbol,quantity,cost_basis\nAAPL,10,185.40\nNOSUCH,5,1.00\n',
      }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { counts: Record<string, number>; previewId: string };
    expect(body.counts).toMatchObject({ ok: 1, unresolved: 1 });
    expect(body.previewId).toBeTruthy();
  });

  it('rejects an unparseable import as a whole', async () => {
    const cookie = await loginCookie(app);
    const response = await app.request('/imports/preview', {
      method: 'POST',
      headers: { ...ORIGIN, cookie },
      body: JSON.stringify({ filename: 'p.json', content: '{not json' }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: 'unparseable_file' });
  });

  it('refuses a commit for an expired or unknown preview', async () => {
    const cookie = await loginCookie(app);
    const response = await app.request('/imports/commit', {
      method: 'POST',
      headers: { ...ORIGIN, cookie },
      body: JSON.stringify({
        previewId: '11111111-1111-1111-1111-111111111111',
        mode: 'merge',
        lines: [2],
      }),
    });
    expect(response.status).toBe(404);
  });

  it('requires the internal key on scheduled-run triggers', async () => {
    const response = await app.request('/internal/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'snapshot' }),
    });
    expect(response.status).toBe(401);
  });

  it('records the run and its outcome in the runs table', async () => {
    const response = await app.request('/internal/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': 'internal-test-key' },
      body: JSON.stringify({ kind: 'snapshot', trigger: 'test' }),
    });
    expect(response.status).toBe(200);
    expect(queries.claimRun).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'snapshot', trigger: 'test' }),
    );
    expect(queries.finishRun).toHaveBeenCalledWith('run-1', 'ok', expect.anything());
  });

  it('marks a run failed rather than leaving the key claimed', async () => {
    // A claimed key that is never resolved blocks every later attempt until the
    // stale-claim window elapses, so a thrown error must still close the run.
    vi.mocked(queries.listHoldings).mockRejectedValueOnce(new Error('database is down'));
    const response = await app.request('/internal/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': 'internal-test-key' },
      body: JSON.stringify({ kind: 'snapshot' }),
    });
    expect(response.status).toBe(500);
    expect(queries.finishRun).toHaveBeenCalledWith('run-1', 'failed', expect.anything());
  });

  it('deduplicates a repeated run so a double trigger is a no-op', async () => {
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': 'internal-test-key' },
      body: JSON.stringify({ kind: 'snapshot' }),
    };
    const first = (await (await app.request('/internal/runs', init)).json()) as { status: string };
    const second = (await (await app.request('/internal/runs', init)).json()) as { status: string };
    expect(first.status).toBe('ok');
    expect(second.status).toBe('skipped');
  });

  it('keeps market-feed articles for the discovery window plus a proposal lifetime', async () => {
    const response = await app.request('/internal/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': 'internal-test-key' },
      body: JSON.stringify({ kind: 'news_collect' }),
    });
    expect(response.status).toBe(200);
    expect(fakeAi.lastCollectRequest).toMatchObject({
      market_retention_days: DISCOVERY_WINDOW_DAYS + loadConfig(ENV).TOPIC_PROPOSAL_TTL_DAYS,
    });
  });

  it('names instruments that are missing one and reports the ones still unnamed', async () => {
    vi.mocked(queries.listInstrumentsWithoutName).mockResolvedValueOnce([
      { id: 'instrument-1', symbol: 'AAPL' },
      { id: 'instrument-2', symbol: 'ZZZZ' },
    ]);
    const response = await app.request('/internal/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': 'internal-test-key' },
      body: JSON.stringify({ kind: 'instrument_metadata' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      result: { examined: number; named: number; stillUnnamed: string[] };
    };
    // The fake provider knows AAPL and not ZZZZ, so one row is named and the
    // other keeps its null name - which is a clean run, not a degraded one.
    expect(body.status).toBe('ok');
    expect(body.result).toMatchObject({ examined: 2, named: 1, stillUnnamed: ['ZZZZ'] });
    expect(queries.setInstrumentName).toHaveBeenCalledWith('instrument-1', expect.any(String));
  });

  it('runs a portfolio scan and stores what it finds', async () => {
    vi.mocked(queries.insertObservations).mockResolvedValueOnce({ created: 2, suppressed: 1, inserted: [] });
    const response = await app.request('/internal/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': 'internal-test-key' },
      body: JSON.stringify({ kind: 'portfolio_scan' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; result: { created: number } };
    expect(body.result.created).toBe(2);
    expect(queries.insertObservations).toHaveBeenCalled();
  });

  it('stores who wrote each explanation, and why the model did not', async () => {
    // The AI service has always reported both and the insert used to drop them,
    // which left the feed unable to say whether a sentence was a model's or a
    // template's. Asserted against what the fake actually emits rather than a
    // hand-written shape, because the last time a consumer was tested against
    // invented producer output the mismatch reached production.
    vi.mocked(queries.insertObservations).mockResolvedValueOnce({ created: 1, suppressed: 0, inserted: [] });
    const response = await app.request('/internal/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': 'internal-test-key' },
      body: JSON.stringify({ kind: 'portfolio_scan' }),
    });
    expect(response.status).toBe(200);
    expect(queries.insertObservations).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ narrationSource: 'template', fallbackReason: 'no_provider' }),
      ]),
    );
  });

  it('marks a scan degraded when a rule declined to run', async () => {
    // "Nothing was found" and "we could not look" must not report the same way.
    vi.mocked(queries.insertObservations).mockResolvedValueOnce({ created: 0, suppressed: 0, inserted: [] });
    scanStats = { drift_skipped_reason: '1 of 1 holdings could not be priced (AAPL)' };
    app = buildApp();
    const response = await app.request('/internal/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': 'internal-test-key' },
      body: JSON.stringify({ kind: 'portfolio_scan' }),
    });
    const body = (await response.json()) as { status: string; result: { skipped: string[] } };
    expect(body.status).toBe('degraded');
    expect(body.result.skipped[0]).toContain('allocation drift');
  });

  it('requires a session to read the observations feed', async () => {
    expect((await app.request('/observations')).status).toBe(401);
  });

  it('serves the observations feed with its evidence intact', async () => {
    vi.mocked(queries.listObservations).mockResolvedValueOnce([
      {
        id: 'obs-1',
        kind: 'price_move',
        severity: 'high',
        subject_kind: 'instrument',
        subject_ref: 'instrument:NVDA',
        headline: 'NVDA moved -8.5%',
        explanation: 'From $129.45 to $118.45.',
        evidence: { change_pct: -0.085 },
        concept_refs: ['daily-return'],
        created_at: new Date('2026-09-16T14:00:00Z'),
      },
    ] as never);
    const cookie = await loginCookie(app);
    const response = await app.request('/observations', { headers: { cookie } });
    const body = (await response.json()) as { observations: { evidence: unknown }[] };
    // Evidence is returned whole: a claim the reader cannot check is the thing
    // this product exists not to make.
    expect(body.observations[0]!.evidence).toEqual({ change_pct: -0.085 });
  });

  it('returns the standard error shape for an unknown route', async () => {
    const response = await app.request('/nope');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'not_found' });
  });
});
