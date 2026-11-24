/**
 * Approving a trade for the open (D398-D401): queueing and cancelling it, and
 * what the minute tick does with it once the market opens - fills it with
 * Approve's checks, retries only a passing refusal, and tells the user once.
 *
 * The SQL is pinned in queries.postgres.test.ts; the money path is
 * tradeApproval's, mocked here so each outcome can be asked for by name.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { feeMinor } from '@traders/shared';

import type { OutboundNotification } from '../src/notify/notifier.js';

const USER = '00000000-0000-0000-0000-000000000001';
const AGENT = '90000000-0000-0000-0000-000000000001';
const PROPOSAL = '50000000-0000-0000-0000-000000000001';
/** 16:20 in Jerusalem on a Wednesday: ten minutes before New York opens. */
const BEFORE_OPEN = new Date('2026-11-18T14:20:00Z');
const OPENS_AT = new Date('2026-11-18T14:30:00Z');
const AFTER_OPEN = new Date('2026-11-18T14:31:00Z');
const EXPIRES_AT = new Date('2026-11-18T15:30:00Z');

let row: Record<string, unknown>;
let language = 'en';
/** The agent's balance, its holding of the proposal's symbol, and what already waits (D428). */
let cash = 1_000_000n;
let held = '0';
let queued: Record<string, string | boolean>[] = [];
const CLIENT = { client: true };

function proposalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROPOSAL,
    user_id: USER,
    agent_id: AGENT,
    agent_name: 'Warren',
    kind: 'buy',
    payload: { symbol: 'NVDA', quantity: '3', priceMinor: 15_546, currency: 'USD' },
    state: 'pending',
    expires_at: EXPIRES_AT,
    snoozed_until: null,
    decided_at: null,
    evidence: {},
    opens_at: OPENS_AT,
    open_approval: 'queued',
    open_approval_surface: 'telegram',
    open_approval_at: BEFORE_OPEN,
    open_approval_reason: null,
    ...overrides,
  };
}

vi.mock('../src/db/queries.js', () => ({
  transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(CLIENT)),
  lockAgentCash: vi.fn(async () => cash),
  lockAgentHolding: vi.fn(async () => (held === '0' ? null : { quantity: held, cost_basis_minor: '10000' })),
  findTradableInstrument: vi.fn(async () => ({ id: 'i-nvda', symbol: 'NVDA' })),
  listQueuedTrades: vi.fn(async () => queued),
  findProposal: vi.fn(async () => row),
  getUser: vi.fn(async () => ({ id: USER, timezone: 'Asia/Jerusalem' })),
  getOrCreateUserSettings: vi.fn(async () => ({
    notify_severity: 'high',
    quiet_hours_start: '22:00',
    quiet_hours_end: '07:00',
    muted_until: null,
    language,
  })),
  queueOpenApproval: vi.fn(async () => true),
  cancelOpenApproval: vi.fn(async () => true),
  settleOpenApproval: vi.fn(async () => true),
  listDueOpenApprovals: vi.fn(async () => [{ id: PROPOSAL, user_id: USER, agent_id: AGENT }]),
  supersedeOpenApprovals: vi.fn(async () => []),
  applyProposalTransition: vi.fn(async () => ({ applied: true, intentId: null })),
  claimNotification: vi.fn(async () => ({ id: 'n-1' })),
  settleNotification: vi.fn(async () => undefined),
}));

vi.mock('../src/services/tradeApproval.js', () => ({
  previewTradeApproval: vi.fn(),
  confirmTradeApproval: vi.fn(),
}));

vi.mock('../src/telegram/proposalMessages.js', () => ({
  redrawProposalMessages: vi.fn(async () => undefined),
}));

vi.mock('../src/logger.js', () => ({
  logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const queries = await import('../src/db/queries.js');
const { redrawProposalMessages } = await import('../src/telegram/proposalMessages.js');
const approval = await import('../src/services/tradeApproval.js');
const { ApiProblem } = await import('../src/http/errors.js');
const { MESSAGES } = await import('../src/notify/messages.js');
const {
  approveForOpen,
  cancelForOpen,
  fillDueOpenApprovals,
  supersedeOlderApprovals,
  TRANSIENT_OPEN_REFUSALS,
} = await import('../src/services/openApproval.js');
const { createFakeAi } = await import('./fakeAi.js');

function recordingNotifier() {
  const sent: OutboundNotification[] = [];
  return {
    sent,
    notifier: {
      channel: 'telegram',
      send: vi.fn(async (notification: OutboundNotification) => {
        sent.push(notification);
        return { delivered: true };
      }),
    },
  };
}

const PREVIEW = {
  proposalId: PROPOSAL,
  agentPriceMinor: 15_546,
  distanceBps: 40,
  maxDistanceBps: 300,
  trade: { priceMinor: 15_608, symbol: 'NVDA' },
  mandateBreaches: [],
};

const FILLED = {
  state: 'approved',
  fill: { id: 'fill-1', side: 'buy', symbol: 'NVDA', quantity: '3', priceMinor: 15_608, feeMinor: 100, currency: 'USD' },
  cashMinor: 953_076,
  heldQuantity: '3',
};

function tick(now: Date, notifier = recordingNotifier().notifier) {
  return fillDueOpenApprovals({ ai: createFakeAi(), notifier, now: () => now });
}

beforeEach(() => {
  row = proposalRow();
  language = 'en';
  cash = 1_000_000n;
  held = '0';
  queued = [];
  vi.mocked(queries.queueOpenApproval).mockReset().mockResolvedValue(true);
  vi.mocked(queries.cancelOpenApproval).mockReset().mockResolvedValue(true);
  vi.mocked(queries.settleOpenApproval).mockReset().mockResolvedValue(true);
  vi.mocked(queries.claimNotification).mockReset().mockResolvedValue({ id: 'n-1' });
  vi.mocked(queries.applyProposalTransition).mockClear();
  vi.mocked(redrawProposalMessages).mockClear();
  vi.mocked(approval.previewTradeApproval).mockReset().mockResolvedValue(PREVIEW as never);
  vi.mocked(approval.confirmTradeApproval).mockReset().mockResolvedValue(FILLED as never);
});

describe('Approve at the open', () => {
  it('queues a pending trade before its market opens, and says when it fills', async () => {
    row = proposalRow({ open_approval: null, open_approval_surface: null, open_approval_at: null });
    const result = await approveForOpen(USER, PROPOSAL, 'web', BEFORE_OPEN);
    expect(result).toEqual({ outcome: 'queued', opensAt: OPENS_AT.toISOString() });
    expect(queries.queueOpenApproval).toHaveBeenCalledWith(USER, PROPOSAL, 'web', BEFORE_OPEN, CLIENT);
    // The check and the queueing share the lock every fill takes (D428).
    expect(queries.lockAgentCash).toHaveBeenCalledWith(CLIENT, USER, AGENT);
  });

  it('answers a second tap unchanged, writing nothing', async () => {
    const result = await approveForOpen(USER, PROPOSAL, 'telegram', BEFORE_OPEN);
    expect(result.outcome).toBe('unchanged');
    expect(queries.queueOpenApproval).not.toHaveBeenCalled();
  });

  it('refuses once the market has opened: that is Approve at the live price', async () => {
    row = proposalRow({ open_approval: null, open_approval_surface: null, open_approval_at: null });
    vi.mocked(queries.queueOpenApproval).mockResolvedValue(false);
    await expect(approveForOpen(USER, PROPOSAL, 'web', AFTER_OPEN)).rejects.toMatchObject({ code: 'market_open' });
  });

  it('refuses a proposal decided meanwhile', async () => {
    row = proposalRow({ state: 'rejected', open_approval: null, open_approval_surface: null, open_approval_at: null });
    vi.mocked(queries.queueOpenApproval).mockResolvedValue(false);
    await expect(approveForOpen(USER, PROPOSAL, 'web', BEFORE_OPEN)).rejects.toMatchObject({
      code: 'already_decided',
    });
  });

  describe('only when what is free covers it (D428)', () => {
    const unqueued = { open_approval: null, open_approval_surface: null, open_approval_at: null };
    /** The proposal's own cost: 3 NVDA at the agent's price, and the fee. */
    const cost = 3 * 15_546 + Number(feeMinor('3'));
    const WAITING = { id: 'p-other', kind: 'buy', symbol: 'MSFT', quantity: '2', price_minor: '20000', funded: false };
    const waitingCost = 2 * 20_000 + Number(feeMinor('2'));

    it('refuses a buy that other waiting buys leave no cash for, naming what they set aside', async () => {
      row = proposalRow(unqueued);
      queued = [WAITING];
      cash = BigInt(cost + waitingCost - 1);
      await expect(approveForOpen(USER, PROPOSAL, 'web', BEFORE_OPEN)).rejects.toMatchObject({
        code: 'insufficient_cash',
        details: { cashMinor: cost + waitingCost - 1, reservedMinor: waitingCost, requiredMinor: cost },
      });
      expect(queries.queueOpenApproval).not.toHaveBeenCalled();
    });

    it('queues it when the free cash is exactly its cost', async () => {
      row = proposalRow(unqueued);
      queued = [WAITING];
      cash = BigInt(cost + waitingCost);
      expect((await approveForOpen(USER, PROPOSAL, 'web', BEFORE_OPEN)).outcome).toBe('queued');
    });

    it('queues a buy its own scan funded with sells, whose cash has not arrived yet', async () => {
      row = proposalRow({
        ...unqueued,
        payload: { symbol: 'NVDA', quantity: '3', priceMinor: 15_546, currency: 'USD', fundedBy: ['p-sell'] },
      });
      cash = 0n;
      expect((await approveForOpen(USER, PROPOSAL, 'web', BEFORE_OPEN)).outcome).toBe('queued');
    });

    it('refuses a trade it could not measure, funded or not, so none reaches the queue', async () => {
      for (const payload of [
        { symbol: 'NVDA', quantity: '3.5', priceMinor: 15_546, currency: 'USD', fundedBy: ['p-sell'] },
        { symbol: 'NVDA', quantity: '3', priceMinor: 155.46, currency: 'USD' },
        { symbol: 'NVDA', quantity: '3', currency: 'USD' },
      ]) {
        row = proposalRow({ ...unqueued, payload });
        await expect(approveForOpen(USER, PROPOSAL, 'web', BEFORE_OPEN)).rejects.toMatchObject({ code: 'invalid_trade' });
      }
      expect(queries.queueOpenApproval).not.toHaveBeenCalled();
    });

    it('refuses, as a fill would, an agent with no cash account or a symbol nobody knows', async () => {
      row = proposalRow(unqueued);
      vi.mocked(queries.lockAgentCash).mockResolvedValueOnce(null);
      await expect(approveForOpen(USER, PROPOSAL, 'web', BEFORE_OPEN)).rejects.toMatchObject({ code: 'agent_has_no_cash' });

      row = proposalRow({ ...unqueued, kind: 'sell' });
      vi.mocked(queries.findTradableInstrument).mockResolvedValueOnce(null);
      await expect(approveForOpen(USER, PROPOSAL, 'web', BEFORE_OPEN)).rejects.toMatchObject({ status: 404 });
      expect(queries.queueOpenApproval).not.toHaveBeenCalled();
    });

    it('refuses a sell of shares another waiting sell has set aside', async () => {
      row = proposalRow({ ...unqueued, kind: 'sell' });
      held = '4.000000000000000000';
      queued = [{ id: 'p-other', kind: 'sell', symbol: 'NVDA', quantity: '2', price_minor: '15546', funded: false }];
      await expect(approveForOpen(USER, PROPOSAL, 'web', BEFORE_OPEN)).rejects.toMatchObject({
        code: 'insufficient_holding',
        details: { heldQuantity: '4', reservedQuantity: '2' },
      });
      expect(queries.queueOpenApproval).not.toHaveBeenCalled();

      queued = [];
      expect((await approveForOpen(USER, PROPOSAL, 'web', BEFORE_OPEN)).outcome).toBe('queued');
    });
  });

  it('refuses anything that is not a buy or sell', async () => {
    row = proposalRow({ kind: 'rebalance' });
    await expect(approveForOpen(USER, PROPOSAL, 'web', BEFORE_OPEN)).rejects.toMatchObject({ code: 'not_a_trade' });
  });
});

describe('Cancel approval', () => {
  it('takes back a waiting approval', async () => {
    expect(await cancelForOpen(USER, PROPOSAL, 'web')).toEqual({ outcome: 'cancelled' });
  });

  it('answers a second cancel unchanged', async () => {
    row = proposalRow({ open_approval: 'cancelled' });
    vi.mocked(queries.cancelOpenApproval).mockResolvedValue(false);
    expect(await cancelForOpen(USER, PROPOSAL, 'web')).toEqual({ outcome: 'unchanged' });
  });

  it('refuses one the open already settled', async () => {
    row = proposalRow({ open_approval: 'filled' });
    vi.mocked(queries.cancelOpenApproval).mockResolvedValue(false);
    await expect(cancelForOpen(USER, PROPOSAL, 'web')).rejects.toMatchObject({ code: 'open_approval_not_waiting' });
  });
});

describe('the open (D398, D399)', () => {
  it('fills with Approve checks at the price its own preview showed, and says so once', async () => {
    const { sent, notifier } = recordingNotifier();
    expect(await tick(AFTER_OPEN, notifier)).toMatchObject({ filled: 1, retrying: 0 });
    expect(approval.previewTradeApproval).toHaveBeenCalledWith(USER, PROPOSAL, 'telegram', expect.anything());
    expect(approval.confirmTradeApproval).toHaveBeenCalledWith(
      USER,
      PROPOSAL,
      BigInt(PREVIEW.trade.priceMinor),
      'telegram',
      expect.anything(),
      { forOpenApproval: true },
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toContain('bought 3 NVDA at the open');
    expect(sent[0]!.proposalId).toBeUndefined();
    expect(queries.claimNotification).toHaveBeenCalledWith(
      expect.objectContaining({ refKind: 'open_approval', refId: PROPOSAL, dedupeKey: `telegram:open_approval:${PROPOSAL}` }),
    );
  });

  it.each([...TRANSIENT_OPEN_REFUSALS])('leaves it waiting for the next minute on %s, telling nobody', async (code) => {
    vi.mocked(approval.previewTradeApproval).mockRejectedValue(new ApiProblem(422, code, 'passing'));
    const { sent, notifier } = recordingNotifier();
    expect(await tick(AFTER_OPEN, notifier)).toMatchObject({ retrying: 1 });
    expect(queries.settleOpenApproval).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('retries when the AI service does not answer', async () => {
    vi.mocked(approval.previewTradeApproval).mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await tick(AFTER_OPEN)).toMatchObject({ retrying: 1 });
    expect(queries.settleOpenApproval).not.toHaveBeenCalled();
  });

  it('ends it on a price too far from the agent, and says why with both prices', async () => {
    vi.mocked(approval.previewTradeApproval).mockRejectedValue(
      new ApiProblem(422, 'price_far_from_agent', 'far', {
        agentPriceMinor: 17_867,
        livePriceMinor: 17_133,
        distanceBps: -411,
      }),
    );
    const { sent, notifier } = recordingNotifier();
    expect(await tick(AFTER_OPEN, notifier)).toMatchObject({ refused: 1 });
    expect(queries.settleOpenApproval).toHaveBeenCalledWith(USER, PROPOSAL, 'refused', 'price_far_from_agent');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toContain('was not made');
    expect(sent[0]!.body).toContain('$171.33');
    expect(sent[0]!.body).toContain('-4.11%');
  });

  it('says it in the user language', async () => {
    language = 'he';
    vi.mocked(approval.previewTradeApproval).mockRejectedValue(new ApiProblem(422, 'insufficient_cash', 'short'));
    const { sent, notifier } = recordingNotifier();
    await tick(AFTER_OPEN, notifier);
    expect(sent[0]!.title).toContain('שאישרתם לפתיחה לא בוצעה');
    expect(sent[0]!.body).toContain(MESSAGES.he.trade.reasons.insufficient_cash);
  });

  it('announces an approval that expired still waiting', async () => {
    const { sent, notifier } = recordingNotifier();
    expect(await tick(new Date(EXPIRES_AT.getTime() + 60_000), notifier)).toMatchObject({ expired: 1 });
    expect(queries.settleOpenApproval).toHaveBeenCalledWith(USER, PROPOSAL, 'expired');
    expect(approval.previewTradeApproval).not.toHaveBeenCalled();
    expect(sent[0]!.title).toContain('was not made');
  });

  it('closes, silently, one decided by hand since', async () => {
    row = proposalRow({ state: 'rejected' });
    const { sent, notifier } = recordingNotifier();
    expect(await tick(AFTER_OPEN, notifier)).toMatchObject({ closed: 1 });
    expect(queries.settleOpenApproval).toHaveBeenCalledWith(USER, PROPOSAL, 'cancelled');
    expect(sent).toHaveLength(0);
  });

  it('lets a cancel that landed first win over the fill', async () => {
    vi.mocked(approval.confirmTradeApproval).mockRejectedValue(new ApiProblem(409, 'open_approval_gone', 'gone'));
    const { sent, notifier } = recordingNotifier();
    expect(await tick(AFTER_OPEN, notifier)).toMatchObject({ closed: 1 });
    expect(sent).toHaveLength(0);
  });
});

describe('the message the approval was tapped on (D427)', () => {
  it('is redrawn once the open fills it, so Cancel approval is gone', async () => {
    const { notifier } = recordingNotifier();
    await tick(AFTER_OPEN, notifier);
    expect(redrawProposalMessages).toHaveBeenCalledWith(notifier, USER, PROPOSAL, AFTER_OPEN);
  });

  it.each([
    ['refused', () => vi.mocked(approval.previewTradeApproval).mockRejectedValue(new ApiProblem(422, 'insufficient_cash', 'short'))],
    ['closed', () => { row = proposalRow({ state: 'rejected' }); }],
  ])('is redrawn when the open ends it %s', async (_outcome, arrange) => {
    arrange();
    await tick(AFTER_OPEN);
    expect(redrawProposalMessages).toHaveBeenCalledTimes(1);
  });

  it('is redrawn when the approval expired waiting', async () => {
    await tick(new Date(EXPIRES_AT.getTime() + 60_000));
    expect(redrawProposalMessages).toHaveBeenCalledTimes(1);
  });

  it('is left alone while the approval is still waiting for the next minute', async () => {
    vi.mocked(approval.previewTradeApproval).mockRejectedValue(new ApiProblem(422, 'market_closed', 'closed'));
    await tick(AFTER_OPEN);
    expect(redrawProposalMessages).not.toHaveBeenCalled();
  });

  it('is redrawn when a newer proposal replaces the approval', async () => {
    vi.mocked(queries.supersedeOpenApprovals).mockResolvedValue([{ id: PROPOSAL, state: 'pending', kind: 'buy' }]);
    const { notifier } = recordingNotifier();
    await supersedeOlderApprovals(USER, AGENT, 'NVDA', 'newer', notifier, AFTER_OPEN);
    expect(redrawProposalMessages).toHaveBeenCalledWith(notifier, USER, PROPOSAL, AFTER_OPEN);
  });
});

describe('a newer proposal replaces a waiting approval (D400)', () => {
  it('rejects the older proposal by the system and answers what it replaced', async () => {
    vi.mocked(queries.supersedeOpenApprovals).mockResolvedValue([{ id: PROPOSAL, state: 'pending', kind: 'buy' }]);
    const replaced = await supersedeOlderApprovals(USER, AGENT, 'NVDA', 'newer');
    expect(replaced).toEqual({ side: 'buy', quantity: '3', symbol: 'NVDA' });
    expect(queries.applyProposalTransition).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: PROPOSAL, toState: 'rejected', surface: 'system', actorUserId: null }),
    );
  });

  it('replaces nothing when nothing waits', async () => {
    vi.mocked(queries.supersedeOpenApprovals).mockResolvedValue([]);
    expect(await supersedeOlderApprovals(USER, AGENT, 'NVDA', 'newer')).toBeNull();
    expect(queries.applyProposalTransition).not.toHaveBeenCalled();
  });
});
