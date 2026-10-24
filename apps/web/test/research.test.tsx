// @vitest-environment jsdom
/**
 * Research on the main portfolio (D254, D289-D293): the page carries the
 * disclaimer, each rating shows its word (never the colour alone), its agent,
 * its date and a stale mark past the set age, and the rationale is marked as
 * the English a model wrote. Assigning an agent and starting a run go to the
 * routes, and a refusal is said in the reader's words.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

import type { AgentView, ResearchResponse } from '@traders/shared';

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>('../src/api/client.ts');
  return { ...actual, api: { get, post, put, patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() } };
});

const { ApiRequestError } = await import('../src/api/client.ts');
const { ResearchPage } = await import('../src/pages/ResearchPage.tsx');
const { renderPage } = await import('./serverStateHarness.tsx');
const { t } = await import('../src/i18n/index.ts');

const ANALYST = {
  id: '90000000-0000-0000-0000-0000000000a1',
  name: 'Analyst',
  isPrimary: false,
  state: 'active',
} as unknown as AgentView;

const RESEARCH: ResearchResponse = {
  agent: { id: ANALYST.id, name: 'Analyst', state: 'active' },
  run: {
    id: 'r1',
    trigger: 'manual',
    status: 'done',
    holdings: 2,
    rated: 2,
    startedAt: '2026-10-23T20:00:00Z',
    finishedAt: '2026-10-23T20:05:00Z',
    error: null,
  },
  holdings: [
    {
      instrumentId: 'i1',
      symbol: 'CCJ',
      name: 'Cameco',
      latest: {
        rating: 'bullish',
        rationale: 'CCJ trades at 54.32.',
        findings: ['Steady news.'],
        agentName: 'Analyst',
        ratedAt: '2026-10-23T20:01:00Z',
        stale: false,
      },
      lastAttempt: null,
    },
    {
      instrumentId: 'i2',
      symbol: 'NXE',
      name: null,
      latest: {
        rating: 'bearish',
        rationale: 'NXE fell.',
        findings: [],
        agentName: 'Analyst',
        ratedAt: '2026-10-01T20:01:00Z',
        stale: true,
      },
      lastAttempt: { status: 'refused', at: '2026-10-23T20:02:00Z' },
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  get.mockImplementation(async (path: string) => {
    if (path === '/research') return RESEARCH;
    if (path === '/agents') return { agents: [ANALYST], agentLimit: null };
    return new Promise(() => {});
  });
  post.mockResolvedValue({ run_id: 'r2', holdings: 2 });
  put.mockResolvedValue(RESEARCH);
});
afterEach(cleanup);

describe('the research page', () => {
  it('heads with the disclaimer and says a rating is not advice about the position', async () => {
    renderPage(<ResearchPage />);
    await screen.findByText('CCJ');
    expect(screen.getByText(t('disclaimer'))).toBeTruthy();
    expect(screen.getByText(t('research.notAdvice'))).toBeTruthy();
  });

  it("shows each rating's word, agent and date, a stale mark, and the rationale as English", async () => {
    renderPage(<ResearchPage />);
    expect(await screen.findByText(t('research.ratings.bullish'))).toBeTruthy();
    expect(screen.getByText(t('research.ratings.bearish'))).toBeTruthy();
    expect(screen.getAllByText(/Analyst\u2069, /)).toHaveLength(2);
    expect(screen.getAllByText(t('research.staleLong'))).toHaveLength(1);
    const rationale = screen.getByText('CCJ trades at 54.32.');
    expect(rationale.getAttribute('lang')).toBe('en');
    expect(screen.getByText(/The latest attempt, .*, was refused/)).toBeTruthy();
  });

  it('assigns an agent and starts a run', async () => {
    renderPage(<ResearchPage />);
    const select = (await screen.findByRole('combobox')) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2));
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(put).toHaveBeenCalledWith('/research/agent', { agentId: null }));
    fireEvent.click(screen.getByRole('button', { name: t('research.run') }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/research/runs', {}));
  });

  it("says a refusal in the reader's words", async () => {
    post.mockRejectedValueOnce(new ApiRequestError('no key', 409, 'own_key_required'));
    renderPage(<ResearchPage />);
    fireEvent.click(await screen.findByRole('button', { name: t('research.run') }));
    expect(await screen.findByText(t('research.refusals.own_key_required'))).toBeTruthy();
  });
});
