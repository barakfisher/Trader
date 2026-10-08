// @vitest-environment jsdom
/** The Agents page: the real portfolio named by the catalogue, every other agent labelled simulated. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

import type { AgentView } from '@traders/shared';

const get = vi.fn();
const post = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>('../src/api/client.ts');
  return { ...actual, api: { get, post, put: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() } };
});

const { ApiRequestError } = await import('../src/api/client.ts');
const { AgentsPage } = await import('../src/pages/AgentsPage.tsx');
const { renderPage } = await import('./serverStateHarness.tsx');

const PRIMARY: AgentView = {
  id: '90000000-0000-0000-0000-000000000001',
  // Stored English; the page must not show it.
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
  llmBudgetMicroUsd: null,
  llmSpentTodayMicroUsd: null,
  scanCost: null,
  waitingForPersona: false,
};
const MOMENTUM: AgentView = {
  ...PRIMARY,
  id: '90000000-0000-0000-0000-0000000000a1',
  name: 'Momentum',
  isPrimary: false,
  budgetMinor: 100050,
  state: 'paused',
  holdingsCount: 0,
};

describe('AgentsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    get.mockImplementation(async (path: string) =>
      path === '/portfolio/consolidated'
        ? { agents: [{ agentId: MOMENTUM.id, name: 'Momentum', state: 'paused', currency: 'USD', netWorthMinor: 123456 }] }
        : { agents: [PRIMARY, MOMENTUM] },
    );
  });
  afterEach(cleanup);

  it('names the real portfolio from the catalogue and labels the rest simulated', async () => {
    renderPage(<AgentsPage />);
    expect(await screen.findByText('Main portfolio')).toBeTruthy();
    expect(screen.queryByText('Stored name')).toBeNull();
    expect(screen.getByText('Real')).toBeTruthy();
    expect(screen.getByText('Simulated')).toBeTruthy();
    expect(screen.getByText('Paused')).toBeTruthy();
    // A simulated agent's net worth, valued as its own page values it (D19).
    expect(await screen.findByText('Net worth $1,234.56 · paper budget $1,000.50')).toBeTruthy();
  });

  it('lets a name and a persona take the direction of what is typed in them', async () => {
    // A Hebrew page with an English persona put its full stop on the wrong side
    // until these followed their content (found in the preview).
    renderPage(<AgentsPage />);
    await screen.findByText('Main portfolio');
    expect(screen.getByLabelText('Name').getAttribute('dir')).toBe('auto');
    expect(screen.getByLabelText('Persona').getAttribute('dir')).toBe('auto');
  });

  it('sends the budget as the decimal string typed, and refuses a third decimal before sending', async () => {
    post.mockResolvedValue(MOMENTUM);
    renderPage(<AgentsPage />);
    await screen.findByText('Main portfolio');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Value' } });
    fireEvent.change(screen.getByLabelText('Paper budget (USD)'), { target: { value: '10.005' } });
    const submit = screen.getByRole('button', { name: 'Create agent' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Paper budget (USD)'), { target: { value: '2500.5' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/agents', { name: 'Value', budget: '2500.5', persona: null }));
  });

  it('says a taken name in the reader\'s words, not the server\'s', async () => {
    post.mockRejectedValue(new ApiRequestError('you already have an agent with that name', 409, 'agent_name_taken'));
    renderPage(<AgentsPage />);
    await screen.findByText('Main portfolio');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Momentum' } });
    fireEvent.change(screen.getByLabelText('Paper budget (USD)'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    expect(await screen.findByText('You already have an agent with that name.')).toBeTruthy();
  });
});
