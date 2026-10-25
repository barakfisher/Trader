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

import type { Proposal, ProposalDetailResponse, ProposalRecheck } from '@traders/shared';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>(
    '../src/api/client.ts',
  );
  return { ...actual, api: { get, post, patch, put: vi.fn(), delete: vi.fn(), postForm: vi.fn() } };
});

const { ApiRequestError } = await import('../src/api/client.ts');
const { App } = await import('../src/App.tsx');
const { RECENT_APPROVALS } = await import('../src/queries/proposals.ts');
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
    agentId: 'agent-main',
    agentName: 'Main portfolio',
    agentIsPrimary: true,
    scanId: null,
    evidenceChecked: null,
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
    const detail: ProposalDetailResponse = { proposal: proposal(), transitions: [], attempts: [], recheck: null };
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
      attempts: [],
      recheck: null,
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

describe("an agent's trade proposal", () => {
  const TRADE = proposal({
    id: 'p-trade',
    kind: 'buy',
    payload: { symbol: 'INTC', quantity: '3', priceMinor: 11_250, priceAsOf: null, currency: 'USD' },
    severity: 'notable',
    subjectRef: 'instrument:INTC',
    headline: 'Value proposes to buy 3 INTC at 112.50',
    explanation: 'INTC fell 3.18% to 112.50 with no news against it.',
    evidence: {},
    agentId: 'agent-value',
    agentName: 'Value',
    agentIsPrimary: false,
    scanId: 'scan-1',
    evidenceChecked: {
      checks: [
        { tool: 'get_price_history', subject: 'INTC', days: 21 },
        { tool: 'get_news', subject: 'INTC', days: 7 },
        { tool: 'get_position', subject: null, days: null },
        { tool: 'explain_concept', subject: 'drawdown', days: null },
      ],
      otherCalls: 1,
    },
  });
  const PREVIEW = {
    proposalId: 'p-trade',
    agentPriceMinor: 11_250,
    distanceBps: 120,
    maxDistanceBps: 300,
    trade: {
      symbol: 'INTC',
      name: 'Intel',
      side: 'buy',
      quantity: '3',
      priceSource: 'quote',
      priceMinor: 11_385,
      quoteAsOf: '2026-10-07T14:45:00.000Z',
      quoteDelaySeconds: 900,
      notionalMinor: 34_155,
      feeMinor: 150,
      cashChangeMinor: -34_305,
      cashMinor: 1_000_000,
      cashAfterMinor: 965_695,
      heldQuantity: '0',
      heldAfterQuantity: '3',
      currency: 'USD',
      warnings: [],
    },
    mandateBreaches: [],
  };

  const serveTrade = (trade: Proposal) =>
    serve({
      '/proposals/p-trade': { proposal: trade, transitions: [], attempts: [] },
      '/proposals?state=open': { proposals: [] },
      [`/proposals?state=approved&limit=${RECENT_APPROVALS}`]: { proposals: [] },
    });

  it('says what the scan checked, in words, and links to its transcript', async () => {
    serveTrade(TRADE);
    renderAt('/proposals/p-trade');
    const line = await screen.findByRole('region', { name: 'Evidence checked' });
    expect(line.querySelector('p')!.textContent).toBe(
      'Evidence checked: price history INTC (21 trading days) · news INTC (7 days) · position · glossary “drawdown” · 1 other tool',
    );
    // Tool names come from the catalogue, never as the scan called them.
    expect(line.textContent).not.toMatch(/get_|explain_concept/);
    expect(screen.getByRole('link', { name: "Full transcript in the agent's decisions" }).getAttribute('href')).toBe(
      '/agents/agent-value?tab=scans&scan=scan-1',
    );
  });

  it('says so when the scan checked nothing', async () => {
    serveTrade({ ...TRADE, evidenceChecked: { checks: [], otherCalls: 0 } });
    renderAt('/proposals/p-trade');
    const line = await screen.findByRole('region', { name: 'Evidence checked' });
    expect(line.textContent).toContain('nothing - the agent decided from its briefing alone');
  });

  it('shows no line on a proposal without a scan', async () => {
    serveTrade({ ...TRADE, scanId: null, evidenceChecked: null });
    renderAt('/proposals/p-trade');
    expect(await screen.findByText('INTC fell 3.18% to 112.50 with no news against it.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Evidence checked' })).toBeNull();
  });

  it('approves through a preview at the live price, then confirms at the price it showed', async () => {
    serve({
      '/proposals/p-trade': { proposal: TRADE, transitions: [], attempts: [] },
      // The app bar's inbox count: confirming re-reads it, and waits for it.
      '/proposals?state=open': { proposals: [] },
      [`/proposals?state=approved&limit=${RECENT_APPROVALS}`]: { proposals: [] },
    });
    post.mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith('/preview')
          ? PREVIEW
          : {
              state: 'approved',
              fill: {
                id: 'f-1', symbol: 'INTC', side: 'buy', quantity: '3', priceMinor: 11_385, notionalMinor: 34_155,
                feeMinor: 150, currency: 'USD', priceSource: 'quote', quoteAsOf: null, quoteDelaySeconds: 900,
                source: 'agent', createdAt: '2026-10-07T15:00:00.000Z',
              },
              cashMinor: 965_695,
              heldQuantity: '3',
            },
      ),
    );

    renderAt('/proposals/p-trade');

    expect(await screen.findByText('INTC fell 3.18% to 112.50 with no news against it.')).toBeTruthy();
    expect(screen.getByText(/the agent's price \$112\.50/)).toBeTruthy();
    // A trade has no snooze and no undo (D48).
    expect(screen.queryByRole('button', { name: /Snooze/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/proposals/p-trade/preview', {}));
    expect(await screen.findByText(/the live price is \+1\.2% from it/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm: pay $343.05' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/proposals/p-trade/confirm', { shownPriceMinor: 11_385 }),
    );
    expect(await screen.findByText('Bought 3 INTC at $113.85, fee $1.50.')).toBeTruthy();
  });

  it("warns of the agent's limits a buy breaks, offers the setting, and still confirms (D299)", async () => {
    serve({
      '/proposals/p-trade': { proposal: TRADE, transitions: [], attempts: [] },
      '/proposals?state=open': { proposals: [] },
      [`/proposals?state=approved&limit=${RECENT_APPROVALS}`]: { proposals: [] },
      // The agent's own words are empty, so a settings change needs no instructions check (D176).
      '/agents/agent-value': { id: 'agent-value', persona: null, mandate: null, runningScan: null, scheduling: null },
    });
    const breach = {
      rule: 'max_position',
      limitBps: 1_000,
      capitalMinor: 1_000_000,
      positionAfterMinor: 142_000,
      positionAfterBps: 1_420,
      overByMinor: 42_000,
      suggestedBps: 1_500,
    };
    let previews = 0;
    post.mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith('/preview') ? { ...PREVIEW, mandateBreaches: previews++ === 0 ? [breach] : [] } : {},
      ),
    );
    patch.mockResolvedValue({});

    renderAt('/proposals/p-trade');
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    const warning = await screen.findByRole('alert', { name: "Outside the agent's limits" });
    expect(warning.textContent).toContain(
      "Over the agent's max position: INTC would be 14.2% of capital ($1,420.00 of $10,000.00), $420.00 past its 10% limit.",
    );
    expect(warning.textContent).toContain('approving overrides the agent');
    expect(screen.getByRole('link', { name: 'Agent settings' }).getAttribute('href')).toBe(
      '/agents/agent-value?tab=settings',
    );
    // A warning, never a refusal: Confirm is there beside it.
    expect(screen.getByRole('button', { name: 'Confirm: pay $343.05' })).toBeTruthy();

    const set = await screen.findByRole('button', { name: 'Set Max position to 15%' });
    await waitFor(() => expect((set as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(set);
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/agents/agent-value', { mandate: { maxPositionBps: 1_500 } }),
    );
    // The preview is asked again, and the limit it now meets says nothing.
    await waitFor(() => expect(screen.queryByRole('alert', { name: "Outside the agent's limits" })).toBeNull());
    expect(previews).toBe(2);
    expect(post.mock.calls.some(([path]) => String(path).includes('instructions-check'))).toBe(false);
  });

  it('checks instructions in the user\'s own words again after the setting changes (D176)', async () => {
    serve({
      '/proposals/p-trade': { proposal: TRADE, transitions: [], attempts: [] },
      '/proposals?state=open': { proposals: [] },
      [`/proposals?state=approved&limit=${RECENT_APPROVALS}`]: { proposals: [] },
      '/agents/agent-value': {
        id: 'agent-value',
        persona: 'Hold no more than five names.',
        mandate: null,
        runningScan: null,
        scheduling: null,
      },
    });
    post.mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith('/preview')
          ? { ...PREVIEW, mandateBreaches: [{ rule: 'max_holdings', limit: 5, heldCount: 5, suggestedLimit: 6 }] }
          : {},
      ),
    );
    patch.mockResolvedValue({});

    renderAt('/proposals/p-trade');
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect((await screen.findByRole('alert', { name: "Outside the agent's limits" })).textContent).toContain(
      "Over the agent's max holdings: this would be instrument number 6, past its limit of 5.",
    );
    const set = screen.getByRole('button', { name: 'Set Max holdings to 6' });
    await waitFor(() => expect((set as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(set);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/agents/agent-value/instructions-check'));
    expect(patch).toHaveBeenCalledWith('/agents/agent-value', { mandate: { maxHoldings: 6 } });
  });

  it("says why an approval was refused, and the page lists each refused try", async () => {
    serve({
      '/proposals/p-trade': {
        proposal: TRADE,
        transitions: [],
        attempts: [
          {
            surface: 'web', reason: 'price_far_from_agent', agentPriceMinor: 11_250, livePriceMinor: 11_700,
            quoteAsOf: null, at: '2026-10-07T14:00:00.000Z',
          },
        ],
      },
    });
    post.mockRejectedValue(
      new ApiRequestError('far', 422, 'price_far_from_agent', {
        agentPriceMinor: 11_250,
        livePriceMinor: 11_700,
        distanceBps: 400,
      }),
    );

    renderAt('/proposals/p-trade');

    expect(await screen.findByText(/The price had moved more than 3% from the agent's/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/The price is \$117\.00, \+4\.0% from the agent's \$112\.50/)).toBeTruthy();
    // Still open: it can be tried again, or rejected.
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
  });
});

describe('re-checking an expired trade proposal (D212)', () => {
  const TRADE = proposal({
    id: 'p-trade',
    kind: 'buy',
    state: 'expired',
    storedState: 'expired',
    payload: { symbol: 'INTC', quantity: '3', priceMinor: 11_250, priceAsOf: null, currency: 'USD' },
    headline: 'Value proposes to buy 3 INTC at 112.50',
    explanation: 'INTC fell.',
    evidence: {},
    agentId: 'agent-value',
    agentName: 'Value',
    agentIsPrimary: false,
    scanId: 'scan-1',
  });
  const AT = '2026-10-20T15:00:00.000Z';

  const serveRecheck = (recheck: Omit<ProposalRecheck, 'supersededBy'> & { supersededBy?: string }) =>
    serve({
      '/proposals/p-trade': {
        proposal: TRADE,
        transitions: [],
        attempts: [],
        recheck: { supersededBy: null, ...recheck },
      },
      '/proposals?state=open': { proposals: [] },
      [`/proposals?state=approved&limit=${RECENT_APPROVALS}`]: { proposals: [] },
    });

  it('offers it once, and says why the agent proposed nothing', async () => {
    serveRecheck({ available: true, last: null });
    post.mockResolvedValue({
      outcome: 'declined',
      scanId: 's-2',
      at: AT,
      reason: { kind: 'agent', thesis: 'INTC is above where it was worth buying.' },
    });
    renderAt('/proposals/p-trade');
    expect(await screen.findByText(/can be re-checked once, up to 7 days after it expired/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/proposals/p-trade/recheck', {}));
    expect(await screen.findByText('INTC is above where it was worth buying.')).toBeTruthy();
    expect(screen.getByText(/no new proposal/)).toBeTruthy();
    // Once: the answer takes the button away.
    expect(screen.queryByRole('button', { name: 'Re-check' })).toBeNull();
  });

  it('links to the new proposal a re-check raised, with no button', async () => {
    serveRecheck({ available: false, last: { outcome: 'proposed', scanId: 's-2', at: AT, proposalId: 'p-new' } });
    renderAt('/proposals/p-trade');
    const link = await screen.findByRole('link', { name: 'Open the new proposal' });
    expect(link.getAttribute('href')).toBe('/proposals/p-new');
    expect(screen.queryByRole('button', { name: 'Re-check' })).toBeNull();
  });

  it("says a server check's refusal in the catalogue's words", async () => {
    serveRecheck({
      available: false,
      last: { outcome: 'declined', scanId: 's-2', at: AT, reason: { kind: 'check', check: 'mandate' } },
    });
    renderAt('/proposals/p-trade');
    expect(await screen.findByText("The trade no longer fits the agent's settings.")).toBeTruthy();
  });

  it('keeps the button after a re-check that reached no answer, and says why', async () => {
    serveRecheck({ available: true, last: { outcome: 'unanswered', scanId: 's-2', at: AT, cause: 'cap_reached' } });
    renderAt('/proposals/p-trade');
    expect(await screen.findByText(/your monthly safety limit on AI spending is reached\. You can try again\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Re-check' })).toBeTruthy();
  });

  it('says a refusal before any model call in the user\'s language', async () => {
    serveRecheck({ available: true, last: null });
    post.mockRejectedValue(new ApiRequestError('spent', 409, 'budget_spent'));
    renderAt('/proposals/p-trade');
    fireEvent.click(await screen.findByRole('button', { name: 'Re-check' }));
    expect(await screen.findByText("The agent's AI budget for today is spent.")).toBeTruthy();
  });

  it('says a later approved proposal already made the trade, and links to it (D218)', async () => {
    serveRecheck({ available: false, last: null, supersededBy: 'p-later' });
    renderAt('/proposals/p-trade');
    expect(await screen.findByText(/A later proposal for the same trade was approved/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open that proposal' }).getAttribute('href')).toBe('/proposals/p-later');
    expect(screen.queryByRole('button', { name: 'Re-check' })).toBeNull();
  });

  it('shows nothing on a proposal that was never offered one', async () => {
    serveRecheck({ available: false, last: null });
    renderAt('/proposals/p-trade');
    expect(await screen.findByText('INTC fell.')).toBeTruthy();
    expect(screen.queryByText('Re-check')).toBeNull();
  });
});
