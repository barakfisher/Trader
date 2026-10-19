// @vitest-environment jsdom
/** The Agents page: the real portfolio named by the catalogue, every other agent labelled simulated. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

import type { AgentView, UniverseTaxonomyResponse } from '@traders/shared';

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
  waitingForBrief: false,
  mandate: null,
  instructionsConflicts: null,
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

const TAXONOMY: UniverseTaxonomyResponse = {
  sectors: [
    {
      name: 'Energy',
      instruments: 155,
      industries: [{ name: 'Uranium', instruments: 9 }],
      etfCategories: [{ name: 'Equity Energy', instruments: 24 }],
    },
    { name: 'Technology', instruments: 488, industries: [{ name: 'Semiconductors', instruments: 38 }], etfCategories: [] },
  ],
  etfCategories: [{ name: 'Digital Assets', instruments: 33 }],
  updatedAt: '2026-10-18T00:00:00Z',
};

describe('AgentsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    get.mockImplementation(async (path: string) =>
      path === '/portfolio/consolidated'
        ? { agents: [{ agentId: MOMENTUM.id, name: 'Momentum', state: 'paused', currency: 'USD', netWorthMinor: 123456 }] }
        : path === '/universe/taxonomy'
          ? TAXONOMY
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
    expect(screen.getByLabelText('Additional instructions').getAttribute('dir')).toBe('auto');
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
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/agents', {
        name: 'Value',
        budget: '2500.5',
        persona: null,
        mandate: expect.objectContaining({ riskLevel: null, maxPositionBps: null, allowEtfs: true, sectors: [] }),
      }),
    );
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
      path === '/portfolio/consolidated'
        ? { agents: [] }
        : path === '/universe/taxonomy'
          ? TAXONOMY
          : { agents: [PRIMARY, MOMENTUM], agentLimit: { used: 2, max: 3 } },
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
    const persona = screen.getByLabelText('Additional instructions') as HTMLTextAreaElement;
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
    const persona = screen.getByLabelText('Additional instructions') as HTMLTextAreaElement;
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
    fireEvent.change(screen.getByLabelText('Additional instructions'), { target: { value: 'Half a thought' } });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await openCreateForm();
    expect((screen.getByLabelText('Additional instructions') as HTMLTextAreaElement).value).toBe('Half a thought');
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

  it('fills the whole mandate from a template, leaving out what the universe does not hold (D168)', async () => {
    renderPage(<AgentsPage />);
    await openCreateForm();
    fireEvent.click(screen.getByRole('button', { name: templateName('warren') }));
    expect((screen.getByLabelText('Risk appetite') as HTMLInputElement).value).toBe('3');
    expect((screen.getByLabelText('Trading horizon') as HTMLSelectElement).value).toBe('long');
    expect((screen.getByLabelText('Max position (%)') as HTMLInputElement).value).toBe('8');
    expect((screen.getByLabelText('Mega-cap') as HTMLInputElement).checked).toBe(true);
    // Cathie names Technology, Healthcare and two digital-asset categories; this universe holds two of them.
    await screen.findByPlaceholderText('Search sectors, industries, ETF categories');
    fireEvent.click(screen.getByRole('button', { name: templateName('cathie') }));
    const chosen = screen.getByRole('list', { name: 'Chosen' });
    expect(chosen.textContent).toContain('Technology');
    expect(chosen.textContent).toContain('Digital Assets');
    expect(chosen.textContent).not.toContain('Healthcare');
  });

  it('lets the slider propose the limits, but never move one typed by hand (D169)', async () => {
    renderPage(<AgentsPage />);
    await openCreateForm();
    fireEvent.change(screen.getByLabelText('Max holdings'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Risk appetite'), { target: { value: '9' } });
    expect(screen.getByText('Aggressive (9 of 10)')).toBeTruthy();
    expect((screen.getByLabelText('Max position (%)') as HTMLInputElement).value).toBe('25');
    expect((screen.getByLabelText('Cash buffer minimum (%)') as HTMLInputElement).value).toBe('5');
    expect((screen.getByLabelText('Max holdings') as HTMLInputElement).value).toBe('7');
  });

  it('writes the instructions from the settings until they are edited, and rewrites them on request (D174)', async () => {
    renderPage(<AgentsPage />);
    await openCreateForm();
    const instructions = screen.getByLabelText('Additional instructions') as HTMLTextAreaElement;
    fireEvent.change(screen.getByLabelText('Risk appetite'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Trading horizon'), { target: { value: 'long' } });
    expect(instructions.value).toBe(
      'You are a conservative investor: you prefer steady, proven businesses and avoid large swings. ' +
        'You hold positions for months to years and ignore day-to-day noise.',
    );
    // Words, never figures: the limits the slider set are not in the text.
    expect(instructions.value).not.toMatch(/\d/);
    fireEvent.change(instructions, { target: { value: 'Mine now.' } });
    fireEvent.change(screen.getByLabelText('Thesis style'), { target: { value: 'contrarian' } });
    expect(instructions.value).toBe('Mine now.');
    fireEvent.click(screen.getByRole('button', { name: 'Rewrite from settings' }));
    expect(instructions.value).toContain('say why the consensus could be wrong');
  });

  it('sends the mandate in basis points, and refuses a malformed limit before sending', async () => {
    post.mockResolvedValue(MOMENTUM);
    renderPage(<AgentsPage />);
    await openCreateForm();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Miner' } });
    fireEvent.change(screen.getByLabelText('Paper budget (USD)'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('Max position (%)'), { target: { value: '12.555' } });
    const submit = screen.getByRole('button', { name: 'Create agent' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Max position (%)'), { target: { value: '12.5' } });
    fireEvent.click(screen.getByLabelText('Allow ETFs'));
    fireEvent.change(screen.getByLabelText('Blocked tickers'), { target: { value: 'xom, cvx' } });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        '/agents',
        expect.objectContaining({
          mandate: expect.objectContaining({ maxPositionBps: 1250, allowEtfs: false, blockedSymbols: ['XOM', 'CVX'] }),
        }),
      ),
    );
  });

  it('picks sectors and industries from the universe, and removes one', async () => {
    renderPage(<AgentsPage />);
    await openCreateForm();
    const search = await screen.findByPlaceholderText('Search sectors, industries, ETF categories');
    fireEvent.change(search, { target: { value: 'uran' } });
    fireEvent.click(await screen.findByRole('option', { name: /Uranium/ }));
    fireEvent.change(search, { target: { value: 'tech' } });
    fireEvent.click(await screen.findByRole('option', { name: /^Technology/ }));
    const chosen = screen.getByRole('list', { name: 'Chosen' });
    expect(chosen.textContent).toContain('Uranium');
    expect(chosen.textContent).toContain('Technology');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Uranium' }));
    expect(screen.getByRole('list', { name: 'Chosen' }).textContent).not.toContain('Uranium');
  });

  it("checks the user's own instructions after creating, and never text the settings wrote (D176)", async () => {
    post.mockResolvedValue(MOMENTUM);
    renderPage(<AgentsPage />);
    await openCreateForm();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'A' } });
    fireEvent.change(screen.getByLabelText('Paper budget (USD)'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('Trading horizon'), { target: { value: 'long' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(post).not.toHaveBeenCalledWith(`/agents/${MOMENTUM.id}/instructions-check`);

    await openCreateForm();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'B' } });
    fireEvent.change(screen.getByLabelText('Paper budget (USD)'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('Trading horizon'), { target: { value: 'long' } });
    fireEvent.change(screen.getByLabelText('Additional instructions'), { target: { value: 'Day-trade momentum.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/agents/${MOMENTUM.id}/instructions-check`));
  });

  it('marks an agent whose instructions conflict with its settings', async () => {
    get.mockImplementation(async (path: string) =>
      path === '/universe/taxonomy'
        ? TAXONOMY
        : path === '/portfolio/consolidated'
          ? { agents: [] }
          : { agents: [PRIMARY, { ...MOMENTUM, instructionsConflicts: [{ setting: 'horizon', quote: 'x' }] }] },
    );
    renderPage(<AgentsPage />);
    expect(await screen.findByText('Instructions conflict')).toBeTruthy();
  });
});
