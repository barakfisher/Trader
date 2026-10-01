// @vitest-environment jsdom
/**
 * The admin page: linked from the dashboard for an admin only, and a
 * non-admin who reaches its address is told so without a request being made.
 * The server's refusal is what protects the data (orchestrator
 * `adminGuard.test.ts`); these are about not offering a door that is locked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';

const get = vi.fn();
const post = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>(
    '../src/api/client.ts',
  );
  return {
    ...actual,
    api: { get, post, put: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  };
});

const { App } = await import('../src/App.tsx');
const { createAppRouter } = await import('../src/router.tsx');
const { renderWithServerState } = await import('./serverStateHarness.tsx');
const { duration } = await import('../src/pages/AdminPage.tsx');

const ADMIN = { id: 'u', baseCurrency: 'USD', timezone: 'Asia/Jerusalem', role: 'admin' };
const USER = { ...ADMIN, role: 'user' };

const FREE = 'nvidia/nemotron-3.5-lightning:free';
const zeroOutcomes = { ok: 0, provider_error: 0, budget_exhausted: 0, no_provider: 0 };
const zeroVerdicts = {
  accepted: 0,
  malformed: 0,
  unsourced_figures: 0,
  empty_completion: 0,
  degenerate_completion: 0,
  not_judged: 0,
};
/** The shape measured on compose on 2026-09-30, plus one narration call. */
const LLM_PANEL = {
  window: { days: 7, since: '2026-09-24T00:00:00Z' },
  firstCallAt: '2026-09-30T22:18:16Z',
  agents: [
    {
      agent: 'narration',
      calls: 2,
      outcomes: { ...zeroOutcomes, ok: 1, provider_error: 1 },
      verdicts: { ...zeroVerdicts, accepted: 1 },
      latency: { sample: 2, p50Ms: 850, p95Ms: 30000 },
      promptTokens: 400,
      completionTokens: 90,
      costMicroUsd: 0,
      models: [{ model: FREE, calls: 2, free: true }],
    },
    {
      agent: 'ask',
      calls: 0,
      outcomes: zeroOutcomes,
      verdicts: zeroVerdicts,
      latency: null,
      promptTokens: 0,
      completionTokens: 0,
      costMicroUsd: 0,
      models: [],
    },
  ],
  narrationFallbacks: [
    { reason: 'unsourced_figures', count: 17 },
    { reason: 'none', count: 10 },
  ],
  reconciliation: {
    since: '2026-09-30T22:18:16Z',
    rows: [
      { reason: 'none', explanations: 1, calls: 1 },
      { reason: 'provider_error', explanations: 2, calls: 1 },
    ],
  },
  recent: [
    {
      id: 'c1',
      agent: 'narration',
      model: FREE,
      outcome: 'provider_error',
      verdict: null,
      error: 'HTTP 429 from openrouter',
      latencyMs: 30000,
      promptTokens: 0,
      completionTokens: 0,
      costMicroUsd: 0,
      startedAt: '2026-10-01T06:00:00Z',
    },
  ],
};

function renderAt(path: string, user: typeof ADMIN) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  const result = renderWithServerState(<App router={router} />);
  act(() => {
    result.root.auth.user = user as never;
    result.root.auth.initialised = true;
  });
  return result;
}

describe('the admin page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    get.mockImplementation((path: string) =>
      path === '/admin/runs'
        ? Promise.resolve({
            runs: [
              {
                id: 'r1',
                userId: null,
                kind: 'backfill',
                runKey: 'backfill:k8s:2026-09-30',
                trigger: 'cron',
                status: 'ok',
                startedAt: '2026-09-30T06:45:00Z',
                finishedAt: '2026-09-30T06:45:12Z',
              },
            ],
          })
        : path === '/admin/universe'
          ? Promise.resolve({
              lastLoad: {
                loadedAt: '2026-09-30T21:47:00Z',
                snapshotAsOf: '2026-09-24T12:04:35Z',
                source: 'yahoo',
                manifestCounts: { kept: 5294 },
              },
              database: {
                profiles: 5223,
                equities: 2534,
                etfs: 2689,
                embedded: 5223,
                etfHoldings: 16363,
                onDemand: 2,
                dropped: 0,
              },
              reconciliation: [
                {
                  what: 'etf_holdings',
                  inSnapshot: 16396,
                  inDatabase: 16360,
                  explained: [{ reason: 'weight is not a fraction of the fund', count: 19 }],
                  unexplained: 17,
                },
              ],
            })
        : path === '/admin/gaps'
          ? Promise.resolve({
              gaps: [
                {
                  id: 'g1',
                  kind: 'universe_gap_missing_ticker',
                  userId: 'u',
                  detail: { symbol: 'TINY', source: 'import', gap: 'not_in_universe', rule: null },
                  occurrences: 3,
                  firstSeenAt: '2026-10-01T06:00:00Z',
                  lastSeenAt: '2026-10-01T07:00:00Z',
                  profile: 'on_demand',
                },
              ],
            })
        : path === '/admin/audit'
          ? Promise.resolve({
              entries: [
                {
                  id: '1',
                  adminUserId: 'u',
                  action: 'POST /admin/universe/rescreen',
                  detail: {},
                  ipAddress: '10.0.0.7',
                  requestId: 'r',
                  occurredAt: '2026-10-01T06:00:00Z',
                },
              ],
            })
          : path.startsWith('/admin/llm')
            ? Promise.resolve(LLM_PANEL)
            : new Promise(() => {}),
    );
    window.scrollTo = () => {};
  });
  afterEach(cleanup);

  it('is linked from the dashboard for an admin', async () => {
    renderAt('/', ADMIN);
    const link = await screen.findByRole('link', { name: /Admin/ });
    expect(link.getAttribute('href')).toBe('/admin');
  });

  it('is not linked for anyone else', async () => {
    renderAt('/', USER);
    await screen.findByRole('link', { name: /Settings/ });
    expect(screen.queryByRole('link', { name: /Admin/ })).toBeNull();
  });

  it('shows every run to an admin', async () => {
    renderAt('/admin', ADMIN);
    expect(await screen.findByText('backfill:k8s:2026-09-30')).toBeTruthy();
    expect(screen.getByText('12 s')).toBeTruthy();
  });

  it('names each difference in the universe and flags only what is unexplained', async () => {
    renderAt('/admin', ADMIN);
    expect(await screen.findByText(/ETF holdings: 16,396 in the snapshot, 16,360 in the database/)).toBeTruthy();
    expect(screen.getByText('19: weight is not a fraction of the fund')).toBeTruthy();
    expect(screen.getByText('17 missing from the database, unexplained')).toBeTruthy();
  });

  it('shows a universe gap, counted, with why it is one', async () => {
    renderAt('/admin', ADMIN);
    expect(await screen.findByText('TINY')).toBeTruthy();
    expect(screen.getByText(/below the size floor or listed since the snapshot/)).toBeTruthy();
    expect(screen.getByText(/3×/)).toBeTruthy();
    expect(screen.getByText(/^profiled on demand; no topic is answered from it/)).toBeTruthy();
  });

  it('counts on-demand profiles apart from the members', async () => {
    renderAt('/admin', ADMIN);
    expect(await screen.findByText(/Also 2 profiled on demand for listings users named/)).toBeTruthy();
  });

  it('shows what administrators have done, and from where', async () => {
    renderAt('/admin', ADMIN);
    expect(await screen.findByText('POST /admin/universe/rescreen')).toBeTruthy();
    expect(screen.getByText(/from 10\.0\.0\.7/)).toBeTruthy();
  });

  it('shows model calls per agent, a free route as such, and what is not measured', async () => {
    renderAt('/admin', ADMIN);
    expect(await screen.findByText('free route')).toBeTruthy();
    expect(screen.getByText('850 ms / 30.0 s')).toBeTruthy();
    expect(screen.getByText('1 answered, 1 provider error')).toBeTruthy();
    expect(screen.getByText('HTTP 429 from openrouter')).toBeTruthy();
    expect(screen.getByText(/Not measured: time to first token/)).toBeTruthy();
    expect(get).toHaveBeenCalledWith('/admin/llm?days=7');
  });

  it('counts explanations against calls and flags only a disagreement', async () => {
    renderAt('/admin', ADMIN);
    const agreed = await screen.findByText(/written by the model: 1 stored, 1 call$/);
    expect(agreed.className).not.toContain('text-warn');
    const disagreed = screen.getByText(/provider error: 2 stored, 1 call - these should agree/);
    expect(disagreed.className).toContain('text-warn');
    expect(screen.getByText('refused: figures not in the evidence: 17 of 27')).toBeTruthy();
  });

  it('rescreens only once confirmed, then says where to follow the run', async () => {
    post.mockResolvedValue({ status: 'running', runId: 'r9', runKey: 'universe-rescreen:2026-10-01' });
    renderAt('/admin', ADMIN);
    fireEvent.click(await screen.findByRole('button', { name: 'Rescreen universe' }));
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByText(/rebuilds the universe from Yahoo/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rescreen now' }));
    expect(await screen.findByText(/Rescreen started \(universe-rescreen:2026-10-01\)/)).toBeTruthy();
    expect(post).toHaveBeenCalledWith('/admin/universe/rescreen', {});
  });

  it('says why a rescreen did not start', async () => {
    post.mockResolvedValue({
      status: 'skipped',
      runId: null,
      runKey: 'universe-rescreen:2026-10-01',
      reason: 'this run key was already claimed (ok)',
    });
    renderAt('/admin', ADMIN);
    fireEvent.click(await screen.findByRole('button', { name: 'Rescreen universe' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rescreen now' }));
    expect(await screen.findByText('Not started: this run key was already claimed (ok).')).toBeTruthy();
  });

  it('asks the server for nothing when the account is not an admin', async () => {
    renderAt('/admin', USER);
    expect(await screen.findByText('Administrators only')).toBeTruthy();
    expect(get).not.toHaveBeenCalledWith('/admin/runs');
    expect(get).not.toHaveBeenCalledWith('/admin/audit');
    expect(get).not.toHaveBeenCalledWith('/admin/gaps');
    expect(get).not.toHaveBeenCalledWith('/admin/universe');
    expect(get).not.toHaveBeenCalledWith('/admin/llm?days=7');
  });

  it('says a run is still going rather than giving it a duration', () => {
    expect(duration({ startedAt: '2026-09-30T06:45:00Z', finishedAt: null })).toBe('still running');
    expect(duration({ startedAt: '2026-09-30T06:45:00Z', finishedAt: '2026-09-30T06:50:00Z' })).toBe(
      '5 min',
    );
  });
});
