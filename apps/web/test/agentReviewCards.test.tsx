// @vitest-environment jsdom
/**
 * The agent review's cards, rendered (D340-D343): each says what its rule
 * found with the figures from its evidence, and the one change it proposes;
 * Apply and Dismiss call their routes; a suggestion with no change offers
 * Dismiss only; a stale Apply says why in the reader's language; Hebrew
 * renders from its own catalogue.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

import type { AgentSuggestion, AgentSuggestionsResponse, AgentView } from '@traders/shared';

const get = vi.fn();
const post = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>('../src/api/client.ts');
  return { ...actual, api: { get, post, put: vi.fn(), delete: vi.fn(), postForm: vi.fn() } };
});

const { ApiRequestError } = await import('../src/api/client.ts');
const { AgentReviewCards } = await import('../src/components/AgentReviewCards.tsx');
const { applyLanguage } = await import('../src/i18n/index.ts');
const { renderWithServerState } = await import('./serverStateHarness.tsx');

const AGENT = { id: 'agent-1', isPrimary: false, state: 'active' } as AgentView;

const IDLE: AgentSuggestion = {
  id: 's-idle',
  rule: 'idle_cash',
  status: 'open',
  createdAt: '2026-10-27T13:00:00Z',
  evidence: {
    scans: 10,
    tradeScans: 0,
    since: '2026-10-19T13:00:00Z',
    currency: 'USD',
    cashMinor: 100_000,
    depositsMinor: 100_000,
    cashShareBps: 10_000,
  },
  change: { setting: 'market_caps', from: ['mega', 'large'], to: ['mega', 'large', 'mid'] },
};

const LAG: AgentSuggestion = {
  id: 's-lag',
  rule: 'benchmark_lag',
  status: 'open',
  createdAt: '2026-10-27T13:00:00Z',
  evidence: {
    scans: 10,
    tradeScans: 4,
    since: '2026-10-19T13:00:00Z',
    currency: 'USD',
    returnPct: -3.5,
    benchmarkReturnPct: 2.25,
    differencePts: -5.75,
    day: '2026-10-26',
  },
  change: null,
};

function serve(suggestions: AgentSuggestion[]) {
  get.mockImplementation((path: string) =>
    path === `/agents/${AGENT.id}/suggestions`
      ? Promise.resolve({ suggestions } satisfies AgentSuggestionsResponse)
      : new Promise(() => {}),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue(undefined);
});
afterEach(async () => {
  cleanup();
  await act(() => applyLanguage('en'));
});

it('shows each finding with its figures and the change it proposes', async () => {
  serve([IDLE, LAG]);
  renderWithServerState(<AgentReviewCards agent={AGENT} />);
  expect(await screen.findByText('Cash is sitting idle')).toBeTruthy();
  expect(screen.getByText(/0 of the last 10 scans ended in a trade, and cash is \$1,000\.00 of \$1,000\.00 deposited \(100%\)/)).toBeTruthy();
  expect(screen.getByText(/Company size:/).textContent).toContain('Mega-cap, Large-cap');
  expect(screen.getByText(/Company size:/).textContent).toContain('Mega-cap, Large-cap, Mid-cap');
  expect(screen.getByText(/returned \u2066-3\.50%\u2069, against \u2066\+2\.25%\u2069 .* 5\.75 points behind/)).toBeTruthy();
  // The lag proposes nothing to apply: Dismiss only.
  expect(screen.getAllByRole('button', { name: 'Apply' })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(2);
});

it('applies and dismisses through their routes', async () => {
  serve([IDLE]);
  renderWithServerState(<AgentReviewCards agent={AGENT} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
  await waitFor(() => expect(post).toHaveBeenCalledWith(`/agents/${AGENT.id}/suggestions/s-idle/apply`));
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  await waitFor(() => expect(post).toHaveBeenCalledWith(`/agents/${AGENT.id}/suggestions/s-idle/dismiss`));
});

it('says why a stale suggestion was not applied', async () => {
  serve([IDLE]);
  post.mockRejectedValueOnce(new ApiRequestError('changed', 409, 'suggestion_stale'));
  renderWithServerState(<AgentReviewCards agent={AGENT} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
  expect((await screen.findByRole('alert')).textContent).toBe('This setting changed since the review, so nothing was applied.');
});

it('offers no Apply on an archived agent, and renders nothing without suggestions', async () => {
  serve([IDLE]);
  const { unmount } = renderWithServerState(<AgentReviewCards agent={{ ...AGENT, state: 'archived' }} />);
  await screen.findByText('Cash is sitting idle');
  expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
  unmount();
  serve([]);
  renderWithServerState(<AgentReviewCards agent={AGENT} />);
  await waitFor(() => expect(get).toHaveBeenCalled());
  expect(screen.queryByText('Suggestions from the review')).toBeNull();
});

it('speaks Hebrew from its own catalogue', async () => {
  serve([IDLE]);
  renderWithServerState(<AgentReviewCards agent={AGENT} />);
  await screen.findByText('Cash is sitting idle');
  await act(() => applyLanguage('he'));
  expect(await screen.findByText('המזומן לא מושקע')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'החל' })).toBeTruthy();
});
