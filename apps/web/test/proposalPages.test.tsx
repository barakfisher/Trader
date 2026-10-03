// @vitest-environment jsdom
/**
 * The inbox and a proposal's own page, rendered at their addresses.
 *
 * Pinned: evidence reads as money and percentages, never raw keys; the history
 * shows every outcome, an expiry named as unanswered; a proposal's page decides
 * an open proposal through the same store (and its request is what a decision
 * sends - nothing real is clicked), shows a decided one without buttons, tells
 * its audit trail in words, and answers a stale link with "No such proposal".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';

import type { Proposal, ProposalDetailResponse } from '@traders/shared';

const get = vi.fn();
const post = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>(
    '../src/api/client.ts',
  );
  return { ...actual, api: { get, post, put: vi.fn(), delete: vi.fn(), postForm: vi.fn() } };
});

const { ApiRequestError } = await import('../src/api/client.ts');
const { App } = await import('../src/App.tsx');
const { createAppRouter } = await import('../src/router.tsx');
const { renderWithServerState } = await import('./serverStateHarness.tsx');

const EVIDENCE = {
  symbol: 'BTC-USD',
  base_currency: 'USD',
  value_minor: 3499743,
  drift: 0.151565,
  actual_weight: 0.351565,
  target_weight: 0.2,
};

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p-open',
    observationId: 'o-1',
    kind: 'rebalance',
    payload: {},
    state: 'pending',
    storedState: 'pending',
    severity: 'high',
    subjectRef: 'portfolio:allocation:BTC-USD',
    headline: 'BTC-USD is 15.2 percentage points above its 20.0% target',
    explanation: null,
    localized: {},
    evidence: EVIDENCE,
    expiresAt: new Date(Date.now() + 17 * 3_600_000).toISOString(),
    snoozedUntil: null,
    decidedAt: null,
    undoableUntil: null,
    decidedVia: null,
    createdAt: '2026-09-30T05:20:00.000Z',
    ...overrides,
  };
}

const EXPIRED = proposal({
  id: 'p-expired',
  state: 'expired',
  storedState: 'expired',
  headline: 'BTC-USD drifted, never answered',
  decidedAt: '2026-09-29T05:20:00.000Z',
  decidedVia: 'system',
});
const APPROVED = proposal({
  id: 'p-approved',
  state: 'approved',
  storedState: 'approved',
  headline: 'SPY is 16.6 percentage points above its 0.0% target',
  decidedAt: '2026-09-23T11:55:39.000Z',
  decidedVia: 'telegram',
});

function serve(routes: Record<string, unknown>) {
  get.mockImplementation((path: string) => {
    if (path in routes) {
      const answer = routes[path];
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    }
    return new Promise(() => {});
  });
}

function renderAt(path: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  const result = renderWithServerState(<App router={router} />);
  act(() => {
    result.root.auth.user = { id: 'u', baseCurrency: 'USD', timezone: 'Asia/Jerusalem' } as never;
    result.root.auth.initialised = true;
  });
  return { ...result, router };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.scrollTo = () => {};
});
afterEach(cleanup);

describe('the inbox', () => {
  it('reads the evidence in units and shows every past outcome', async () => {
    serve({
      '/proposals?state=open': { proposals: [proposal()] },
      '/proposals?state=approved&limit=10': { proposals: [APPROVED] },
      '/proposals?state=history&limit=20': { proposals: [EXPIRED, APPROVED] },
    });

    renderAt('/proposals');

    expect(await screen.findByText('$34,997.43')).toBeTruthy();
    expect(screen.getByText('+15.16%')).toBeTruthy();
    expect(screen.queryByText('value minor')).toBeNull();
    expect(screen.queryByText('3499743')).toBeNull();

    expect(await screen.findByText('Expired unanswered')).toBeTruthy();
    expect(screen.getByText('Approved from Telegram')).toBeTruthy();
    // An approval outside its Undo window is history, listed once.
    expect(screen.getAllByText(APPROVED.headline)).toHaveLength(1);
    const link = screen.getByRole('link', { name: EXPIRED.headline });
    expect(link.getAttribute('href')).toBe('/proposals/p-expired');
  });
});

describe("a proposal's page", () => {
  it('decides an open proposal through the same request as the inbox', async () => {
    const detail: ProposalDetailResponse = { proposal: proposal(), transitions: [] };
    serve({ '/proposals/p-open': detail });
    post.mockResolvedValue({ outcome: 'applied', state: 'rejected', intentId: null });

    renderAt('/proposals/p-open');
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/proposals/p-open/decision', { action: 'reject' }),
    );
  });

  it('shows a decided proposal without buttons, and its trail in words', async () => {
    const detail: ProposalDetailResponse = {
      proposal: EXPIRED,
      transitions: [
        { from: 'pending', to: 'snoozed', surface: 'telegram', byUser: true, at: '2026-09-28T09:00:00.000Z' },
        { from: 'snoozed', to: 'expired', surface: 'system', byUser: false, at: '2026-09-29T05:20:00.000Z' },
      ],
    };
    serve({ '/proposals/p-expired': detail });

    renderAt('/proposals/p-expired');

    expect(await screen.findByText(/Nobody answered it before its deadline/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByText('Open → Snoozed, from Telegram')).toBeTruthy();
    expect(screen.getByText('Snoozed → Expired, recorded after its deadline passed')).toBeTruthy();
    expect(screen.getByText('$34,997.43')).toBeTruthy();
  });

  it('answers a stale link with "No such proposal"', async () => {
    serve({ '/proposals/p-gone': new ApiRequestError('proposal not found', 404, 'not_found') });
    renderAt('/proposals/p-gone');
    expect(await screen.findByText('No such proposal')).toBeTruthy();
  });

  it('reports a failed read as a failure, not as a missing proposal', async () => {
    serve({ '/proposals/p-open': new ApiRequestError('boom', 502, 'ai_service_error') });
    renderAt('/proposals/p-open');
    expect(await screen.findByText('boom')).toBeTruthy();
    expect(screen.queryByText('No such proposal')).toBeNull();
  });
});
