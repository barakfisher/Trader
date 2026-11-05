/**
 * Research views as acknowledge-only proposals on the real portfolio (D392).
 *
 * The database is mocked: what is under test is the policy - which ratings
 * raise a proposal, which close one, when it expires, and what the alert says.
 */

import { RESEARCH_STALE_DAYS } from '@traders/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/queries.js', () => ({
  applyProposalTransition: vi.fn(async () => ({ applied: true, intentId: null })),
  createResearchProposal: vi.fn(async () => ({ proposalId: 'p1', observationId: 'o1' })),
  getOrCreateUserSettings: vi.fn(async () => ({
    notify_severity: 'high',
    quiet_hours_start: null,
    quiet_hours_end: null,
    muted_until: null,
    language: 'en',
  })),
  getUser: vi.fn(async () => ({ timezone: 'UTC' })),
  listLatestResearchViews: vi.fn(async () => []),
  listSupersededResearchProposals: vi.fn(async () => []),
  claimNotification: vi.fn(async () => ({ id: 'n1' })),
  settleNotification: vi.fn(async () => {}),
}));

vi.mock('../src/logger.js', () => ({
  logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const queries = await import('../src/db/queries.js');
const { raisesProposal, researchProposalExpiry, sweepResearchProposals } = await import(
  '../src/services/researchProposals.js'
);
const { messagesFor } = await import('../src/notify/messages.js');

const NOW = new Date('2026-11-05T22:00:00.000Z');
const RATED_AT = new Date('2026-11-05T21:00:00.000Z');

function view(overrides: Record<string, unknown> = {}) {
  return {
    rating_id: 'r1',
    user_id: 'u1',
    agent_id: 'a1',
    agent_name: 'Analyst',
    primary_agent_id: 'primary',
    instrument_id: 'i1',
    symbol: 'CCJ',
    rating: 'trim',
    rationale: 'CCJ trades at 54.32.',
    rated_at: RATED_AT,
    previous_rating: 'hold',
    ...overrides,
  };
}

function notifier() {
  return { channel: 'telegram', send: vi.fn(async (_message: unknown) => ({ delivered: true })) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(queries.listLatestResearchViews).mockResolvedValue([]);
  vi.mocked(queries.listSupersededResearchProposals).mockResolvedValue([]);
});

describe('which views raise a proposal', () => {
  it('raises on Buy more, Trim, Sell and Buy, only when the word changed', () => {
    for (const rating of ['buy_more', 'trim', 'sell', 'buy']) {
      expect(raisesProposal({ rating, previous_rating: 'hold' }), rating).toBe(true);
      expect(raisesProposal({ rating, previous_rating: null }), rating).toBe(true);
      expect(raisesProposal({ rating, previous_rating: rating }), rating).toBe(false);
    }
  });

  it('raises nothing on Hold, Wait or Avoid, nor on a word stored before D392', () => {
    for (const rating of ['hold', 'wait', 'avoid', 'bullish', 'bearish', 'neutral']) {
      expect(raisesProposal({ rating, previous_rating: 'trim' }), rating).toBe(false);
    }
  });

  it('counts a word stored before D392 as a different word', () => {
    expect(raisesProposal({ rating: 'sell', previous_rating: 'bearish' })).toBe(true);
  });

  it('expires when the rating goes stale', () => {
    expect(researchProposalExpiry(RATED_AT).getTime() - RATED_AT.getTime()).toBe(RESEARCH_STALE_DAYS * 86_400_000);
  });
});

describe('the sweep', () => {
  it('writes the view on the real portfolio, with no quantity or price, and announces it', async () => {
    vi.mocked(queries.listLatestResearchViews).mockResolvedValue([view(), view({ rating_id: 'r2', rating: 'hold' })]);
    const channel = notifier();

    expect(await sweepResearchProposals(channel as never, NOW)).toEqual({ superseded: 0, raised: 1 });

    const created = vi.mocked(queries.createResearchProposal).mock.calls[0]![0];
    expect(created.primaryAgentId).toBe('primary');
    expect(created.payload).toEqual({
      action: 'trim',
      symbol: 'CCJ',
      instrumentId: 'i1',
      ratingId: 'r1',
      researchAgentId: 'a1',
      researchAgentName: 'Analyst',
    });
    expect(created.expiresAt).toEqual(researchProposalExpiry(RATED_AT));
    expect(created.headline).toBe(messagesFor('en').researchProposalHeadline('Analyst', 'trim', 'CCJ'));
    expect(created.localized.he?.headline).toBe(messagesFor('he').researchProposalHeadline('Analyst', 'trim', 'CCJ'));
    expect(created.localized.he?.explanation).toBe('CCJ trades at 54.32.');

    // Pushed above a `high` floor, as a trade is, and ending with the catalogue's lines.
    const sent = channel.send.mock.calls[0]![0] as { body: string; proposalId: string; trade?: boolean };
    const en = messagesFor('en');
    expect(sent.proposalId).toBe('p1');
    expect(sent.trade).toBeUndefined();
    expect(sent.body.endsWith(`${en.researchAcknowledgeOnly}\n\n${en.researchNotAdvice}`)).toBe(true);
    expect(sent.body.startsWith('CCJ trades at 54.32.')).toBe(true);
  });

  it('announces nothing for a view already written', async () => {
    vi.mocked(queries.listLatestResearchViews).mockResolvedValue([view()]);
    vi.mocked(queries.createResearchProposal).mockResolvedValueOnce(null);
    const channel = notifier();
    expect(await sweepResearchProposals(channel as never, NOW)).toEqual({ superseded: 0, raised: 0 });
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('closes an open view a newer rating changed, as an expiry by the system', async () => {
    vi.mocked(queries.listSupersededResearchProposals).mockResolvedValue([
      { id: 'p-old', user_id: 'u1', state: 'snoozed', evidence: { symbol: 'CCJ' } },
    ]);
    expect(await sweepResearchProposals(notifier() as never, NOW)).toEqual({ superseded: 1, raised: 0 });
    expect(queries.applyProposalTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: 'p-old',
        fromState: 'snoozed',
        toState: 'expired',
        surface: 'system',
        actorUserId: null,
        intent: null,
      }),
    );
  });

  it("keeps going past one user's failure", async () => {
    vi.mocked(queries.listLatestResearchViews).mockResolvedValue([view(), view({ rating_id: 'r2', user_id: 'u2' })]);
    vi.mocked(queries.createResearchProposal).mockRejectedValueOnce(new Error('boom'));
    expect(await sweepResearchProposals(notifier() as never, NOW)).toEqual({ superseded: 0, raised: 1 });
  });
});
