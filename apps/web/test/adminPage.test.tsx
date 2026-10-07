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
const put = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>(
    '../src/api/client.ts',
  );
  return {
    ...actual,
    api: { get, post, put, delete: vi.fn(), postForm: vi.fn() },
  };
});

const { App } = await import('../src/App.tsx');
const { createAppRouter } = await import('../src/router.tsx');
const { renderWithServerState } = await import('./serverStateHarness.tsx');
const { duration } = await import('../src/pages/AdminPage.tsx');

const estimate = (daily: number) => ({ dailyMicroUsd: daily, monthlyMicroUsd: daily * 30 });
/** Nothing chosen yet, the free route configured, ten dollars bought. */
const MODELS = {
  provider: 'openrouter',
  choosable: true,
  configuredModel: 'nvidia/nemotron-3.5-lightning:free',
  choices: [
    { scope: 'explain', chosen: null, effective: 'nvidia/nemotron-3.5-lightning:free' },
    { scope: 'agent', chosen: null, effective: 'nvidia/nemotron-3.5-lightning:free' },
  ],
  models: [
    {
      id: 'anthropic/claude-sonnet-5.5',
      label: 'Claude Sonnet 5.5',
      promptUsdPerMtok: '2',
      completionUsdPerMtok: '10',
      supportsTools: true,
      free: false,
      scopes: ['explain', 'agent'],
      estimates: { explain: estimate(19_000), agent: estimate(110_000) },
      scanEstimateMicroUsd: 110_000,
    },
    {
      id: 'anthropic/claude-haiku-4.5',
      label: 'Claude Haiku 4.5',
      promptUsdPerMtok: '1',
      completionUsdPerMtok: '5',
      supportsTools: true,
      free: false,
      scopes: ['explain', 'agent'],
      estimates: { explain: estimate(9_500), agent: estimate(55_000) },
      scanEstimateMicroUsd: 55_000,
    },
    {
      id: 'nvidia/nemotron-3.5-lightning:free',
      label: 'Nemotron 3.5 Lightning (free)',
      promptUsdPerMtok: '0',
      completionUsdPerMtok: '0',
      supportsTools: true,
      free: true,
      scopes: ['explain'],
      estimates: { explain: estimate(0), agent: null },
      scanEstimateMicroUsd: null,
    },
  ],
  explainBasis: { windowDays: 7, promptTokensPerDay: 3500, completionTokensPerDay: 700 },
  agentBasis: {
    scanningAgents: 1,
    scansPerDay: 1,
    promptTokensPerScan: 45_000,
    completionTokensPerScan: 2_000,
    source: 'assumed',
  },
  credits: { purchasedUsd: '10', usedUsd: '0.10290792', remainingUsd: '9.89709208' },
};

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
  purposes: [
    {
      purpose: 'narration',
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
      purpose: 'ask',
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
      purpose: 'narration',
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
          : path === '/admin/llm/models'
            ? Promise.resolve(MODELS)
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

  it('shows model calls per purpose, a free route as such, and what is not measured', async () => {
    renderAt('/admin', ADMIN);
    expect(await screen.findByText('free route')).toBeTruthy();
    expect(screen.getByText('850 ms / 30.0 s')).toBeTruthy();
    expect(screen.getByText('1 answered, 1 provider error')).toBeTruthy();
    expect(screen.getByText('HTTP 429 from openrouter')).toBeTruthy();
    expect(screen.getByText(/Not measured: time to first token/)).toBeTruthy();
    expect(get).toHaveBeenCalledWith('/admin/llm?days=7');
  });

  it('shows each model choice with its cost, the total and the balance', async () => {
    renderAt('/admin', ADMIN);
    const explain = (await screen.findByLabelText('Narration and questions')) as HTMLSelectElement;
    const agents = screen.getByLabelText('Agents') as HTMLSelectElement;
    // What is in use stays selected; agents may not use the free route, so they start on the first offered.
    expect(explain.value).toBe('nvidia/nemotron-3.5-lightning:free');
    expect(agents.value).toBe('anthropic/claude-sonnet-5.5');
    expect([...agents.options].map((option) => option.value)).not.toContain('nvidia/nemotron-3.5-lightning:free');
    expect(screen.getByText('About $0.11 a day, $3.30 a month')).toBeTruthy();
    expect(screen.getByText(/assumed until real scans are recorded/)).toBeTruthy();
    expect(screen.getByText('Together: about $0.11 a day, $3.30 a month')).toBeTruthy();
    expect(screen.getByText('OpenRouter balance: $9.8971 left ($0.1029 used of $10.00)')).toBeTruthy();
    expect(screen.getByText('At this rate the balance lasts about 89 days.')).toBeTruthy();

    // A different selection is estimated before anything is saved.
    fireEvent.change(explain, { target: { value: 'anthropic/claude-sonnet-5.5' } });
    expect(screen.getByText('Together: about $0.129 a day, $3.87 a month')).toBeTruthy();
    expect(put).not.toHaveBeenCalled();
  });

  it('saves a choice for its scope only when it differs from the one in use', async () => {
    put.mockResolvedValue({ ...MODELS, choices: [{ scope: 'explain', chosen: 'anthropic/claude-haiku-4.5', effective: 'anthropic/claude-haiku-4.5' }, MODELS.choices[1]] });
    renderAt('/admin', ADMIN);
    const explain = (await screen.findByLabelText('Narration and questions')) as HTMLSelectElement;
    fireEvent.change(explain, { target: { value: 'anthropic/claude-haiku-4.5' } });
    const [explainSave] = screen.getAllByRole('button', { name: 'Use this model' });
    await act(async () => {
      fireEvent.click(explainSave!);
    });
    expect(put).toHaveBeenCalledWith('/admin/llm/models/explain', { model: 'anthropic/claude-haiku-4.5' });
    expect(await screen.findByText('In use: anthropic/claude-haiku-4.5')).toBeTruthy();
  });

  it('says when nothing is left on the account', async () => {
    get.mockImplementation((path: string) =>
      path === '/admin/llm/models'
        ? Promise.resolve({ ...MODELS, credits: { purchasedUsd: '0', usedUsd: '0.10290792', remainingUsd: '-0.10290792' } })
        : new Promise(() => {}),
    );
    renderAt('/admin', ADMIN);
    expect(await screen.findByText(/No credit left: paid models will fail/)).toBeTruthy();
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

  it('resets only the ticked groups, and only once the word is typed', async () => {
    post.mockResolvedValue({
      resetId: 'b-42',
      groups: ['main_portfolio', 'agents_trading'],
      erased: { holdings: 2, observations: 104, topics: 0 },
    });
    renderAt('/admin', ADMIN);
    const submit = (await screen.findByRole('button', { name: 'Erase the ticked groups' })) as HTMLButtonElement;
    // Every group starts ticked: the default is a full reset.
    for (const label of ['Main portfolio', "Agents' trading", 'Followed topics']) {
      expect((screen.getByRole('checkbox', { name: new RegExp(label) }) as HTMLInputElement).checked).toBe(true);
    }
    fireEvent.click(screen.getByRole('checkbox', { name: /Followed topics/ }));
    const word = screen.getByLabelText('Type RESET to confirm');
    fireEvent.change(word, { target: { value: 'reset' } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(word, { target: { value: 'RESET' } });
    expect(submit.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(submit);
    });
    expect(post).toHaveBeenCalledWith('/admin/account/reset', {
      groups: ['main_portfolio', 'agents_trading'],
      confirm: 'RESET',
    });
    expect(await screen.findByText('Done: 106 rows erased. Backup b-42.')).toBeTruthy();
  });

  it('cannot reset with nothing ticked', async () => {
    renderAt('/admin', ADMIN);
    for (const label of ['Main portfolio', "Agents' trading", 'Followed topics']) {
      fireEvent.click(await screen.findByRole('checkbox', { name: new RegExp(label) }));
    }
    fireEvent.change(screen.getByLabelText('Type RESET to confirm'), { target: { value: 'RESET' } });
    expect(screen.getByText('Nothing is ticked, so there is nothing to erase.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Erase the ticked groups' }) as HTMLButtonElement).disabled).toBe(true);
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
