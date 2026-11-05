// @vitest-environment jsdom
/**
 * A user's own models (D244, D283-D285): the picker searches OpenRouter's list,
 * puts the tested model first, says when a saved model has fallen back, and
 * saves only on *Save*; the Dashboard banner lists every fallback. Ask is chosen
 * in Settings, explanations on the main portfolio's page, and the admin chooses
 * everything the same way (D360).
 */

import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import en from '../src/i18n/locales/en.json';
import type { ListedModelView, ModelChoicesResponse } from '@traders/shared';

const get = vi.fn();
const put = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>('../src/api/client.ts');
  return { ...actual, api: { get, post: vi.fn(), put, delete: vi.fn(), postForm: vi.fn() } };
});

const { AgentModelCard, AskModelCard, ExplainModelCard } = await import('../src/components/ModelChoiceCards.tsx');
const { ModelFallbackBanner } = await import('../src/components/ModelFallbackBanner.tsx');
const { MAX_SHOWN_MODELS, matching } = await import('../src/components/ModelPicker.tsx');
const { renderPage } = await import('./serverStateHarness.tsx');

const TESTED = 'google/gemini-3.5-flash-lite';
const ASK_DEFAULT = 'google/gemini-3.7-flash';
const SCANS: ListedModelView['testedFor'] = ['explain', 'agent', 'assistant'];
const AGENT = '11111111-1111-4111-8111-111111111111';

function model(id: string, name: string, testedFor: ListedModelView['testedFor'] = []): ListedModelView {
  return { id, name, promptUsdPerMtok: '0.3', completionUsdPerMtok: '2.5', testedFor, scanEstimateMicroUsd: 900 };
}

let data: ModelChoicesResponse;

function choices(overrides: Partial<ModelChoicesResponse> = {}): ModelChoicesResponse {
  return {
    choosable: true,
    live: true,
    defaultModels: { explain: TESTED, agent: TESTED, assistant: ASK_DEFAULT },
    models: [
      model('acme/zeta', 'Acme: Zeta'),
      model(TESTED, 'Google: Gemini 3.5 Flash-Lite', SCANS),
      model('acme/alpha', 'Acme: Alpha'),
      model(ASK_DEFAULT, 'Google: Gemini 3.7 Flash', ['assistant']),
    ],
    choices: {
      assistant: { saved: 'acme/retired', effective: TESTED, fallback: true },
      explain: { saved: null, effective: TESTED, fallback: false },
    },
    agents: [{ agentId: AGENT, name: 'Tech Agent', saved: 'acme/gone', effective: TESTED, fallback: true }],
    ...overrides,
  };
}

function render(ui: React.ReactElement, role: 'user' | 'admin' = 'user') {
  const result = renderPage(ui);
  act(() => {
    result.root.auth.user = { id: 'u', role, baseCurrency: 'USD', timezone: 'Asia/Jerusalem' } as never;
    result.root.auth.initialised = true;
  });
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  data = choices();
  get.mockImplementation((path: string) =>
    path === '/settings/llm-models' ? Promise.resolve(data) : new Promise(() => {}),
  );
  put.mockImplementation(() => Promise.resolve(data));
});
afterEach(cleanup);

describe('the model picker', () => {
  it("offers the models tested for Ask first, then by name, and says a saved model has fallen back", async () => {
    render(<AskModelCard />);
    const ask = (await screen.findByLabelText('Ask')) as HTMLSelectElement;
    const labels = [...ask.options].map((option) => option.textContent);
    expect(labels).toEqual([
      en.models.notChosen,
      expect.stringMatching(/acme\/retired.*no longer offered/),
      'Google: Gemini 3.5 Flash-Lite (tested)',
      'Google: Gemini 3.7 Flash (tested)',
      'Acme: Alpha',
      'Acme: Zeta',
    ]);
    expect(screen.getAllByRole('status')[0]!.textContent).toMatch(/acme\/retired.*no longer offered by OpenRouter/);
  });

  it('saves only on Save, and "not chosen" as null', async () => {
    render(<ExplainModelCard />);
    const explain = (await screen.findByLabelText('Explanations of findings')) as HTMLSelectElement;
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toHaveProperty('disabled', true);
    fireEvent.change(explain, { target: { value: 'acme/alpha' } });
    expect(put).not.toHaveBeenCalled();
    fireEvent.click(save);
    await waitFor(() => expect(put).toHaveBeenCalledWith('/settings/llm-models/explain', { model: 'acme/alpha' }));
    cleanup();

    render(<AskModelCard />);
    const ask = (await screen.findByLabelText('Ask')) as HTMLSelectElement;
    fireEvent.change(ask, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/settings/llm-models/assistant', { model: null }));
  });

  it('keeps Ask in Settings and explanations on the main portfolio page, each alone', async () => {
    render(<AskModelCard />);
    await screen.findByLabelText('Ask');
    expect(screen.queryByLabelText('Explanations of findings')).toBeNull();
    cleanup();
    render(<ExplainModelCard />);
    await screen.findByLabelText('Explanations of findings');
    expect(screen.queryByLabelText('Ask')).toBeNull();
  });

  it('searches by name or id, whatever the case', () => {
    const models = [model('acme/alpha', 'Acme: Alpha'), model('other/beta', 'Other: Beta')];
    expect(matching(models, 'ALPHA').map((m) => m.id)).toEqual(['acme/alpha']);
    expect(matching(models, 'other/').map((m) => m.id)).toEqual(['other/beta']);
    expect(matching(models, '  ')).toEqual(models);
  });

  it('offers at most MAX_SHOWN_MODELS matches at once and says how many there are', async () => {
    const many = Array.from({ length: MAX_SHOWN_MODELS + 1 }, (_, i) => model(`acme/m-${i}`, `Acme ${i}`));
    data = choices({ models: many });
    render(<ExplainModelCard />);
    const explain = (await screen.findByLabelText('Explanations of findings')) as HTMLSelectElement;
    // "Not chosen" plus the matches shown.
    expect(explain.options).toHaveLength(1 + MAX_SHOWN_MODELS);
    expect(screen.getAllByText(`Showing ${MAX_SHOWN_MODELS} of ${MAX_SHOWN_MODELS + 1} models; search to narrow the list.`)).not.toHaveLength(0);
  });

  it('is shown to the admin too, who chooses like every user (D360)', async () => {
    render(<AskModelCard />, 'admin');
    expect(await screen.findByLabelText('Ask')).toBeTruthy();
    expect(get).toHaveBeenCalledWith('/settings/llm-models');
  });
});

describe('the fallback banner', () => {
  it('names every fallback with the way to choose again', async () => {
    render(<ModelFallbackBanner />);
    const banner = await screen.findByRole('status');
    expect(banner.textContent).toMatch(/acme\/retired.*Ask/);
    expect(banner.textContent).toMatch(/acme\/gone.*Tech Agent/);
    expect(screen.getByRole('link', { name: 'Choose in Settings' }).getAttribute('href')).toBe('/settings');
    expect(screen.getByRole('link', { name: "Choose on the agent's page" }).getAttribute('href')).toBe(
      `/agents/${AGENT}?tab=settings`,
    );
  });

  it('says nothing when nothing fell back', async () => {
    data = choices({
      choices: {
        assistant: { saved: null, effective: TESTED, fallback: false },
        explain: { saved: null, effective: TESTED, fallback: false },
      },
      agents: [],
    });
    render(<ModelFallbackBanner />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();
  });

  it("names the admin's Ask that fell back, as a user's (D360)", async () => {
    render(<ModelFallbackBanner />, 'admin');
    const banner = await screen.findByRole('status');
    expect(banner.textContent).toMatch(/acme\/retired.*Ask/);
    expect(screen.getByRole('link', { name: 'Choose in Settings' })).toBeTruthy();
  });

  it("sends a fallen-back explanations model to the main portfolio's page", async () => {
    const PRIMARY = '22222222-2222-4222-8222-222222222222';
    data = choices({
      choices: {
        assistant: { saved: null, effective: TESTED, fallback: false },
        explain: { saved: 'acme/retired', effective: TESTED, fallback: true },
      },
      agents: [],
    });
    get.mockImplementation((path: string) =>
      path === '/settings/llm-models'
        ? Promise.resolve(data)
        : path === '/agents'
          ? Promise.resolve({ agents: [{ id: PRIMARY, isPrimary: true }], agentLimit: null })
          : new Promise(() => {}),
    );
    render(<ModelFallbackBanner />);
    const link = await screen.findByRole('link', { name: 'Choose on the Main portfolio page' });
    expect(link.getAttribute('href')).toBe(`/agents/${PRIMARY}`);
  });
});

describe("an agent's model", () => {
  it('says "not chosen" is the scans\' default, to the admin as to a user (D360, D380)', async () => {
    data = choices({ agents: [{ agentId: AGENT, name: 'Tech Agent', saved: null, effective: TESTED, fallback: false }] });
    for (const role of ['user', 'admin'] as const) {
      render(<AgentModelCard agentId={AGENT} />, role);
      const select = (await screen.findByLabelText('The model this agent scans with')) as HTMLSelectElement;
      expect(select.options[0]!.textContent).toBe(en.models.notChosen);
      // The option no longer names the default, so the line above the field does.
      expect(screen.getByText(/^In use: .*Gemini 3\.5 Flash-Lite/)).toBeTruthy();
      // Tested for Ask only, so not marked tested for scans.
      expect([...select.options].map((option) => option.textContent)).toContain('Google: Gemini 3.7 Flash');
      cleanup();
    }
  });

  it('saves the chosen model for the agent', async () => {
    render(<AgentModelCard agentId={AGENT} />, 'admin');
    const select = (await screen.findByLabelText('The model this agent scans with')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'acme/alpha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith(`/agents/${AGENT}/model`, { model: 'acme/alpha' }));
  });
});
