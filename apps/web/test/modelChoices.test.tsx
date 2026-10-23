// @vitest-environment jsdom
/**
 * A user's own models (D244, D282-D284): the picker searches OpenRouter's list,
 * puts the tested model first, says when a saved model has fallen back, and
 * saves only on *Save*; the Dashboard banner lists every fallback, for nobody
 * but a user on their own key.
 */

import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ListedModelView, ModelChoicesResponse } from '@traders/shared';

const get = vi.fn();
const put = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>('../src/api/client.ts');
  return { ...actual, api: { get, post: vi.fn(), put, delete: vi.fn(), postForm: vi.fn() } };
});

const { UserModelsCard } = await import('../src/components/ModelChoiceCards.tsx');
const { ModelFallbackBanner } = await import('../src/components/ModelFallbackBanner.tsx');
const { MAX_SHOWN_MODELS, matching } = await import('../src/components/ModelPicker.tsx');
const { renderPage } = await import('./serverStateHarness.tsx');

const TESTED = 'google/gemini-3.5-flash-lite';
const AGENT = '11111111-1111-4111-8111-111111111111';

function model(id: string, name: string, tested = false): ListedModelView {
  return { id, name, promptUsdPerMtok: '0.3', completionUsdPerMtok: '2.5', tested, scanEstimateMicroUsd: 900 };
}

let data: ModelChoicesResponse;

function choices(overrides: Partial<ModelChoicesResponse> = {}): ModelChoicesResponse {
  return {
    admin: false,
    choosable: true,
    live: true,
    fallbackModel: TESTED,
    models: [model('acme/zeta', 'Acme: Zeta'), model(TESTED, 'Google: Gemini 3.5 Flash-Lite', true), model('acme/alpha', 'Acme: Alpha')],
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
  it('offers the tested model first, then by name, and says a saved model has fallen back', async () => {
    render(<UserModelsCard />);
    const ask = (await screen.findByLabelText('Ask')) as HTMLSelectElement;
    const labels = [...ask.options].map((option) => option.textContent);
    expect(labels).toEqual([
      expect.stringMatching(/^Not chosen: the tested model/),
      expect.stringMatching(/acme\/retired.*no longer offered/),
      'Google: Gemini 3.5 Flash-Lite (tested)',
      'Acme: Alpha',
      'Acme: Zeta',
    ]);
    expect(screen.getAllByRole('status')[0]!.textContent).toMatch(/acme\/retired.*no longer offered by OpenRouter/);
  });

  it('saves only on Save, and "not chosen" as null', async () => {
    render(<UserModelsCard />);
    const explain = (await screen.findByLabelText('Explanations of findings')) as HTMLSelectElement;
    const save = screen.getAllByRole('button', { name: 'Save' })[1]!;
    expect(save).toHaveProperty('disabled', true);
    fireEvent.change(explain, { target: { value: 'acme/alpha' } });
    expect(put).not.toHaveBeenCalled();
    fireEvent.click(save);
    await waitFor(() => expect(put).toHaveBeenCalledWith('/settings/llm-models/explain', { model: 'acme/alpha' }));

    const ask = screen.getByLabelText('Ask') as HTMLSelectElement;
    fireEvent.change(ask, { target: { value: '' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]!);
    await waitFor(() => expect(put).toHaveBeenCalledWith('/settings/llm-models/assistant', { model: null }));
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
    render(<UserModelsCard />);
    const explain = (await screen.findByLabelText('Explanations of findings')) as HTMLSelectElement;
    // "Not chosen" plus the matches shown.
    expect(explain.options).toHaveLength(1 + MAX_SHOWN_MODELS);
    expect(screen.getAllByText(`Showing ${MAX_SHOWN_MODELS} of ${MAX_SHOWN_MODELS + 1} models; search to narrow the list.`)).not.toHaveLength(0);
  });

  it('is not shown to the admin, who chooses on the Admin page', () => {
    render(<UserModelsCard />, 'admin');
    expect(screen.queryByText('Models')).toBeNull();
    expect(get).not.toHaveBeenCalled();
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

  it('says nothing when nothing fell back, or to the admin', async () => {
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
    cleanup();
    vi.clearAllMocks();
    render(<ModelFallbackBanner />, 'admin');
    expect(get).not.toHaveBeenCalled();
  });
});
