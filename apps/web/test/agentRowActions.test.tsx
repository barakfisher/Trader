// @vitest-environment jsdom
/**
 * An agent's quick actions on its row of the Agents page (D252): Run scan and
 * Pause/Resume as named icon buttons, "⋯" with its pending proposals and its
 * page; none for the main portfolio or an archived agent; the name stays the link.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

import type { AgentView, Proposal } from '@traders/shared';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>('../src/api/client.ts');
  return { ...actual, api: { get, post, put: vi.fn(), patch, delete: vi.fn(), postForm: vi.fn() } };
});

const { ApiRequestError } = await import('../src/api/client.ts');
const { AgentsPage } = await import('../src/pages/AgentsPage.tsx');
const { renderPage } = await import('./serverStateHarness.tsx');
const { t } = await import('../src/i18n/index.ts');

const PRIMARY: AgentView = {
  id: '90000000-0000-0000-0000-000000000001',
  name: 'Stored name',
  isPrimary: true,
  persona: null,
  budgetMinor: null,
  cashMinor: null,
  currency: 'USD',
  state: 'active',
  holdingsCount: 10,
  createdAt: '2026-10-05T10:00:00Z',
  scanSchedule: null,
  maxDecisions: null,
  runningScan: null,
  llmBudgetMicroUsd: null,
  llmSpentTodayMicroUsd: null,
  scanCost: null,
  waitingForBrief: false,
  mandate: null,
  instructionsConflicts: null,
};
const TECH: AgentView = {
  ...PRIMARY,
  id: '90000000-0000-0000-0000-0000000000a1',
  name: 'Tech',
  isPrimary: false,
  persona: 'Buys tech.',
  budgetMinor: 100000,
  holdingsCount: 0,
  llmBudgetMicroUsd: 500_000,
  llmSpentTodayMicroUsd: 0,
};
const PAUSED: AgentView = { ...TECH, id: '90000000-0000-0000-0000-0000000000a2', name: 'Sleepy', state: 'paused' };
const ARCHIVED: AgentView = { ...TECH, id: '90000000-0000-0000-0000-0000000000a3', name: 'Gone', state: 'archived' };

const pending = (agentId: string, n = 1) => ({ id: `p-${agentId}-${n}`, agentId, state: 'pending' }) as unknown as Proposal;

beforeEach(() => {
  vi.clearAllMocks();
  get.mockImplementation(async (path: string) => {
    if (path === '/agents') return { agents: [PRIMARY, TECH, PAUSED, ARCHIVED], agentLimit: { used: 1, max: 5, total: 3 } };
    if (path === '/proposals?state=open') return { proposals: [pending(TECH.id), pending(TECH.id, 2), pending(PAUSED.id)] };
    if (path.startsWith('/proposals')) return { proposals: [] };
    // A scan's settle re-reads the agents' standings; one that never answered would hold it pending.
    if (path === '/portfolio/consolidated') return { agents: [], rows: [], pendingTrades: [], currency: 'USD' };
    return new Promise(() => {});
  });
  post.mockResolvedValue({ scan_id: 's1', outcome: 'no_trade', steps: 1, cost_micro_usd: 100, model: null, answer: {} });
  patch.mockImplementation(async (_path: string, body: { state: string }) => ({ ...TECH, state: body.state }));
});
afterEach(cleanup);

describe("an agent's row", () => {
  it('offers its actions only on a simulated agent that is not archived, and keeps the name as the link', async () => {
    renderPage(<AgentsPage />);
    await screen.findByRole('button', { name: 'Run a scan of Tech now' });
    expect(screen.getByRole('button', { name: 'Run a scan of Sleepy now' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run a scan of Gone now' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Run a scan of Main portfolio/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Tech' }).getAttribute('href')).toBe(`/agents/${TECH.id}`);
  });

  it('runs a scan from the row and links to what it decided', async () => {
    renderPage(<AgentsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run a scan of Tech now' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/agents/${TECH.id}/scans`, {}));
    const see = await screen.findByRole('link', { name: 'See what it decided' });
    expect(see.getAttribute('href')).toBe(`/agents/${TECH.id}?tab=scans&scan=s1`);
  });

  it("can't scan a paused agent, and says why", async () => {
    renderPage(<AgentsPage />);
    const run = (await screen.findByRole('button', { name: 'Run a scan of Sleepy now' })) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(run.title).toMatch(/paused|resume/i);
  });

  it('pauses an active agent and resumes a paused one', async () => {
    renderPage(<AgentsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pause Tech' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith(`/agents/${TECH.id}`, { state: 'paused' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resume Sleepy' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith(`/agents/${PAUSED.id}`, { state: 'active' }));
  });

  it("says a refused resume in the reader's words", async () => {
    patch.mockRejectedValueOnce(new ApiRequestError('server words', 409, 'agent_limit_reached'));
    renderPage(<AgentsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Resume Sleepy' }));
    expect(await screen.findByText(t('agents.errors.limitReached'))).toBeTruthy();
    expect(screen.queryByText('server words')).toBeNull();
  });

  it("counts the agent's pending proposals and links the inbox to them", async () => {
    renderPage(<AgentsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'More actions for Tech' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/proposals?state=open'));
    const link = await screen.findByRole('link', { name: '2 pending proposals' });
    expect(link.getAttribute('href')).toBe(`/insights?tab=proposals&agent=${TECH.id}`);
  });
});
