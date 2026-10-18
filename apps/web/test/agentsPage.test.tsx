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
const { templateName, templatePersona } = await import('../src/lib/personaTemplates.ts');

/** The form lives in a drawer the header's button opens. */
async function openCreateForm() {
  await screen.findByText('Main portfolio');
  fireEvent.click(screen.getByRole('button', { name: 'New agent' }));
  return screen.getByRole('dialog', { name: 'New agent' });
}

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
    await openCreateForm();
    expect(screen.getByLabelText('Name').getAttribute('dir')).toBe('auto');
    expect(screen.getByLabelText('Persona').getAttribute('dir')).toBe('auto');
  });

  it('sends the budget as the decimal string typed, and refuses a third decimal before sending', async () => {
    post.mockResolvedValue(MOMENTUM);
    renderPage(<AgentsPage />);
    await openCreateForm();
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
    await openCreateForm();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Momentum' } });
    fireEvent.change(screen.getByLabelText('Paper budget (USD)'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    expect(await screen.findByText('You already have an agent with that name.')).toBeTruthy();
  });

  it('shows how many agents count against the limit, and refuses a new one at it (D72)', async () => {
    get.mockImplementation(async (path: string) =>
      path === '/portfolio/consolidated' ? { agents: [] } : { agents: [PRIMARY, MOMENTUM], agentLimit: { used: 3, max: 3 } },
    );
    renderPage(<AgentsPage />);
    expect(await screen.findByText('3 of 3 agents')).toBeTruthy();
    expect(screen.getByText(/You have 3 agents, the most this installation allows/)).toBeTruthy();
    // At the limit the form does not open at all.
    expect((screen.getByRole('button', { name: 'New agent' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says the limit in the reader\'s words when the server refuses a racing create', async () => {
    get.mockImplementation(async (path: string) =>
      path === '/portfolio/consolidated' ? { agents: [] } : { agents: [PRIMARY, MOMENTUM], agentLimit: { used: 2, max: 3 } },
    );
    post.mockRejectedValue(new ApiRequestError('limit', 409, 'agent_limit_reached'));
    renderPage(<AgentsPage />);
    expect(await screen.findByText('2 of 3 agents')).toBeTruthy();
    await openCreateForm();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Third' } });
    fireEvent.change(screen.getByLabelText('Paper budget (USD)'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    expect(await screen.findByText(/You already have as many agents as this installation allows/)).toBeTruthy();
  });

  it('fills an empty name and persona from a template, and switches between templates', async () => {
    renderPage(<AgentsPage />);
    await openCreateForm();
    const name = screen.getByLabelText('Name') as HTMLInputElement;
    const persona = screen.getByLabelText('Persona') as HTMLTextAreaElement;
    fireEvent.click(screen.getByRole('button', { name: templateName('warren') }));
    expect(name.value).toBe(templateName('warren'));
    expect(persona.value).toBe(templatePersona('warren'));
    // Untouched template words are the template's, not the user's: a second click replaces them.
    fireEvent.click(screen.getByRole('button', { name: templateName('cathie') }));
    expect(name.value).toBe(templateName('cathie'));
    expect(persona.value).toBe(templatePersona('cathie'));
  });

  it('never replaces a persona or a name the user wrote', async () => {
    renderPage(<AgentsPage />);
    await openCreateForm();
    const name = screen.getByLabelText('Name') as HTMLInputElement;
    const persona = screen.getByLabelText('Persona') as HTMLTextAreaElement;
    fireEvent.change(name, { target: { value: 'My value fund' } });
    fireEvent.click(screen.getByRole('button', { name: templateName('ray') }));
    expect(name.value).toBe('My value fund');
    expect(persona.value).toBe(templatePersona('ray'));
    // An edited template is the user's persona now.
    fireEvent.change(persona, { target: { value: `${templatePersona('ray')} Avoid China.` } });
    const george = screen.getByRole('button', { name: templateName('george') }) as HTMLButtonElement;
    expect(george.disabled).toBe(true);
    fireEvent.click(george);
    expect(persona.value).toBe(`${templatePersona('ray')} Avoid China.`);
  });

  it('opens the form in a drawer, and keeps the draft when the drawer is closed', async () => {
    renderPage(<AgentsPage />);
    expect(await screen.findByText('Main portfolio')).toBeTruthy();
    expect(screen.queryByLabelText('Name')).toBeNull();
    await openCreateForm();
    fireEvent.change(screen.getByLabelText('Persona'), { target: { value: 'Half a thought' } });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await openCreateForm();
    expect((screen.getByLabelText('Persona') as HTMLTextAreaElement).value).toBe('Half a thought');
  });

  it('closes the drawer and clears the draft once the agent is created', async () => {
    post.mockResolvedValue(MOMENTUM);
    renderPage(<AgentsPage />);
    await openCreateForm();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Value' } });
    fireEvent.change(screen.getByLabelText('Paper budget (USD)'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await openCreateForm();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('');
  });
});
