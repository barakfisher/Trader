// @vitest-environment jsdom
/**
 * The admin page: linked from the dashboard for an admin only, and a
 * non-admin who reaches its address is told so without a request being made.
 * The server's refusal is what protects the data (orchestrator
 * `adminGuard.test.ts`); these are about not offering a door that is locked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
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
const { AccountResetCard } = await import('../src/components/AccountResetCard.tsx');

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

const SETTINGS = {
  maxAgentsPerUser: 3,
  assistantDailyBudgetMicroUsd: 500_000,
  maxPendingSignups: 5,
  updatedAt: '2026-10-08T09:00:00Z',
};

const SIGNUPS = {
  pending: [
    { userId: 'u-noa', email: 'noa@example.com', timezone: 'Europe/London', status: 'pending', requestedAt: '2026-10-19T08:00:00Z' },
  ],
  rejected: [
    { userId: 'u-omer', email: 'omer@example.com', timezone: 'Asia/Jerusalem', status: 'rejected', requestedAt: '2026-10-18T08:00:00Z' },
  ],
};

const USERS = {
  users: [
    {
      userId: 'u-admin', email: 'admin@example.com', role: 'admin', status: 'active', timezone: 'Asia/Jerusalem',
      spentThisMonthMicroUsd: 0, ownKey: 'none', lastSignInAt: '2026-10-21T05:00:00Z', approvedAt: null,
    },
    {
      userId: 'u-dana', email: 'dana@example.com', role: 'user', status: 'active', timezone: 'Europe/London',
      spentThisMonthMicroUsd: 1_250_000, ownKey: 'valid', lastSignInAt: null, approvedAt: '2026-10-20T12:00:00Z',
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
          : path === '/admin/settings'
            ? Promise.resolve(SETTINGS)
          : path === '/admin/signups'
            ? Promise.resolve(SIGNUPS)
          : path === '/admin/signups/count'
            ? Promise.resolve({ pending: SIGNUPS.pending.length })
          : path === '/admin/users'
            ? Promise.resolve(USERS)
          : path.startsWith('/admin/llm')
            ? Promise.resolve(LLM_PANEL)
            : new Promise(() => {}),
    );
    window.scrollTo = () => {};
  });
  afterEach(cleanup);

  it('is linked from the account menu for an admin', async () => {
    renderAt('/', ADMIN);
    fireEvent.click(await screen.findByRole('button', { name: 'Account' }));
    const link = await screen.findByRole('link', { name: /Admin/ });
    expect(link.getAttribute('href')).toBe('/admin');
  });

  it('counts the sign-up requests waiting on the Admin link (D188)', async () => {
    renderAt('/', ADMIN);
    fireEvent.click(await screen.findByRole('button', { name: 'Account' }));
    expect(await screen.findByRole('link', { name: /Admin\s*1/ })).toBeTruthy();
  });

  it('approves a request with no amount, and rejects another (D188, D279)', async () => {
    post.mockResolvedValue({ applied: true, status: 'active' });
    renderAt('/admin', ADMIN);
    const row = within((await screen.findByText('noa@example.com')).closest('li')!);
    // Users run on their own key only (D245): there is no cap to type.
    expect(row.queryByRole('textbox')).toBeNull();
    await act(async () => {
      fireEvent.click(row.getByRole('button', { name: 'Approve' }));
    });
    expect(post).toHaveBeenCalledWith('/admin/signups/u-noa/approve', {});
    await act(async () => {
      fireEvent.click(row.getByRole('button', { name: 'Reject' }));
    });
    expect(post).toHaveBeenCalledWith('/admin/signups/u-noa/reject', undefined);
  });

  it('keeps rejected requests folded away, each with an undo', async () => {
    post.mockResolvedValue({ applied: true, status: 'pending' });
    renderAt('/admin', ADMIN);
    fireEvent.click(await screen.findByText('1 rejected request'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo rejection' }));
    });
    expect(post).toHaveBeenCalledWith('/admin/signups/u-omer/restore', undefined);
  });

  it('sets how many requests may wait, 0 closing sign-up, and offers no cap', async () => {
    put.mockResolvedValue({ ...SETTINGS, maxPendingSignups: 0 });
    renderAt('/admin', ADMIN);
    const max = (await screen.findByLabelText('Requests that may wait at once')) as HTMLInputElement;
    expect(max.value).toBe('5');
    expect(screen.queryByLabelText(/cap/i)).toBeNull();
    const save = within(max.closest('form')!).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    fireEvent.change(max, { target: { value: '51' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(max, { target: { value: '0' } });
    await act(async () => {
      fireEvent.click(save);
    });
    expect(put).toHaveBeenCalledWith('/admin/settings', { maxPendingSignups: 0 });
  });

  it('is not linked for anyone else', async () => {
    renderAt('/', USER);
    fireEvent.click(await screen.findByRole('button', { name: 'Account' }));
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
    // What is in use stays selected. Agents may not use the free route, so nothing offered is in
    // use: the picker says so instead of showing the first model as chosen, and cannot save it.
    expect(explain.value).toBe('nvidia/nemotron-3.5-lightning:free');
    expect(agents.value).toBe('');
    expect(agents.selectedOptions[0]!.textContent).toBe('Not chosen – using nvidia/nemotron-3.5-lightning:free');
    expect([...agents.options].map((option) => option.value)).not.toContain('nvidia/nemotron-3.5-lightning:free');
    const [, agentSave] = screen.getAllByRole('button', { name: 'Use this model' }) as HTMLButtonElement[];
    expect(agentSave!.disabled).toBe(true);
    expect(screen.getByText('Together: about $0 a day, $0 a month')).toBeTruthy();

    fireEvent.change(agents, { target: { value: 'anthropic/claude-sonnet-5.5' } });
    expect(agentSave!.disabled).toBe(false);
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

  it('sets how many agents a user may have, within 1 and the ceiling (D72)', async () => {
    put.mockResolvedValue({ ...SETTINGS, maxAgentsPerUser: 5, updatedAt: '2026-10-08T10:00:00Z' });
    renderAt('/admin', ADMIN);
    const field = (await screen.findByLabelText('Most simulated agents a user may have active at once')) as HTMLInputElement;
    expect(field.value).toBe('3');
    const form = within(field.closest('form')!);
    const save = form.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(field, { target: { value: '51' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(field, { target: { value: '5' } });
    await act(async () => {
      fireEvent.click(save);
    });
    expect(put).toHaveBeenCalledWith('/admin/settings', { maxAgentsPerUser: 5 });
    expect(await form.findByText('Saved')).toBeTruthy();
  });

  it("sets the assistant's daily limit in dollars and cents, sent as integer micro-USD", async () => {
    put.mockResolvedValue({ ...SETTINGS, assistantDailyBudgetMicroUsd: 1_250_000, updatedAt: '2026-10-12T10:00:00Z' });
    renderAt('/admin', ADMIN);
    const field = (await screen.findByLabelText("Most one user's questions may cost a day, in US dollars")) as HTMLInputElement;
    expect(field.value).toBe('0.50');
    const form = within(field.closest('form')!);
    const save = form.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    for (const refused of ['1.255', '-1', 'abc', '100.01']) {
      fireEvent.change(field, { target: { value: refused } });
      expect(save.disabled, refused).toBe(true);
    }
    fireEvent.change(field, { target: { value: '1.25' } });
    await act(async () => {
      fireEvent.click(save);
    });
    expect(put).toHaveBeenCalledWith('/admin/settings', { assistantDailyBudgetMicroUsd: 1_250_000 });
  });

  it('never shows a settings field empty while its value is stored', async () => {
    // Every committed frame, recorded as it happens: a field filled one render after the form
    // appeared was read as '' by whichever assertion ran in between.
    const labels = [
      'Requests that may wait at once',
      "Most one user's questions may cost a day, in US dollars",
      'Most simulated agents a user may have active at once',
    ];
    const frames: string[][] = [];
    const observer = new MutationObserver(() => {
      const fields = labels.map((label) => screen.queryByLabelText(label) as HTMLInputElement | null);
      if (fields.some(Boolean)) frames.push(fields.map((field) => field?.value ?? 'absent'));
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    renderAt('/admin', ADMIN);
    await screen.findByLabelText(labels[0]!);
    observer.disconnect();
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) expect(frame).toEqual(['5', '0.50', '3']);
  });

  it('offers the assistant a model picker of its own, with no estimate until one is measured', async () => {
    renderAt('/admin', ADMIN);
    expect(await screen.findByLabelText('Assistant')).toBeTruthy();
    expect(screen.getByText(/No estimate yet/)).toBeTruthy();
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

  it("resets only the ticked groups, and only once the word is typed - each user's own, on Settings (D162)", async () => {
    post.mockResolvedValue({
      resetId: 'b-42',
      groups: ['main_portfolio', 'agents_trading'],
      erased: { holdings: 2, observations: 104, topics: 0 },
    });
    renderWithServerState(<AccountResetCard />);
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
    expect(post).toHaveBeenCalledWith('/account/reset', {
      groups: ['main_portfolio', 'agents_trading'],
      confirm: 'RESET',
    });
    expect(await screen.findByText('Done: 106 rows erased. Backup b-42.')).toBeTruthy();
  });

  it('cannot reset with nothing ticked', async () => {
    renderWithServerState(<AccountResetCard />);
    for (const label of ['Main portfolio', "Agents' trading", 'Followed topics']) {
      fireEvent.click(await screen.findByRole('checkbox', { name: new RegExp(label) }));
    }
    fireEvent.change(screen.getByLabelText('Type RESET to confirm'), { target: { value: 'RESET' } });
    expect(screen.getByText('Nothing is ticked, so there is nothing to erase.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Erase the ticked groups' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists the users' operations, never their finances, and acts only on a user who is not the admin (D162, D239)", async () => {
    post.mockResolvedValue({ userId: 'u-dana', password: 'Abc123-xyz_PQRstuvW' });
    renderAt('/admin', ADMIN);
    expect(await screen.findByText('dana@example.com')).toBeTruthy();
    expect(screen.getByText(/\$1\.25 this month on their own key/)).toBeTruthy();
    expect(screen.getByText(/this month on the installation's key/)).toBeTruthy();
    expect(screen.getByText(/own key working/)).toBeTruthy();
    // One row of actions: Dana's. The admin's row has none.
    expect(screen.getAllByRole('button', { name: 'Disable' })).toHaveLength(1);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'One-time password' }));
    });
    expect(post).toHaveBeenCalledWith('/admin/users/u-dana/one-time-password');
    expect(await screen.findByText('Abc123-xyz_PQRstuvW')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    });
    expect(post).toHaveBeenCalledWith('/admin/users/u-dana/disable');
  });

  it('offers no cap to change: it is retired (D279)', async () => {
    renderAt('/admin', ADMIN);
    expect(await screen.findByText('dana@example.com')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /cap/i })).toBeNull();
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
