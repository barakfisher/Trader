/**
 * The user's tap on a proposal Ask drafted (D393). The database is mocked: what is
 * under test is the policy - what a tap writes, what it closes, when it is refused.
 */

import { ASSISTANT_DRAFT_VALID_DAYS } from '@traders/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/queries.js', () => ({
  applyProposalTransition: vi.fn(async () => ({ applied: true, intentId: null })),
  closeAssistantDraft: vi.fn(async () => undefined),
  createAssistantProposal: vi.fn(async () => 'p-new'),
  findAssistantDraft: vi.fn(),
  listOpenAcknowledgedProposals: vi.fn(async () => []),
  listSupersededAssistantProposals: vi.fn(async () => []),
  markAssistantDraftAdded: vi.fn(async () => undefined),
}));
vi.mock('../src/services/advisoryMode.js', () => ({ isAdvisory: vi.fn(async () => true) }));

const queries = await import('../src/db/queries.js');
const { isAdvisory } = await import('../src/services/advisoryMode.js');
const { addDraftToProposals, assistantDraftExpiry, closeDraft, draftView, sweepSupersededAssistantProposals } = await import(
  '../src/services/assistantProposals.js'
);
const { MESSAGES } = await import('../src/notify/messages.js');

const USER = 'u1';
const MESSAGE = 'm1';
const DRAFTED_AT = new Date('2026-11-01T10:00:00Z');
const NOW = new Date('2026-11-02T10:00:00Z');

function row(overrides: Record<string, unknown> = {}) {
  return {
    message_id: MESSAGE,
    conversation_id: 'c1',
    user_id: USER,
    created_at: DRAFTED_AT,
    proposal_draft: { action: 'trim', symbol: 'CCJ', instrument_id: 'i1', reason: 'It ran hard.' },
    proposal_draft_state: 'open',
    proposal_draft_proposal_id: null,
    primary_agent_id: 'primary',
    ...overrides,
  } as never;
}

function open(action: string, id = 'p-open') {
  return { id, state: 'pending', action, evidence: { symbol: 'CCJ' } } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(queries.findAssistantDraft).mockResolvedValue(row());
  vi.mocked(queries.listOpenAcknowledgedProposals).mockResolvedValue([]);
  vi.mocked(isAdvisory).mockResolvedValue(true);
});

describe('Add to proposals', () => {
  it('writes an acknowledge-only proposal with the catalogue headline, the deadline counted from the draft', async () => {
    await addDraftToProposals(USER, MESSAGE, NOW);

    const written = vi.mocked(queries.createAssistantProposal).mock.calls[0]![0];
    expect(written.payload).toEqual({
      action: 'trim',
      symbol: 'CCJ',
      instrumentId: 'i1',
      messageId: MESSAGE,
      conversationId: 'c1',
    });
    expect(written.payload).not.toHaveProperty('quantity');
    expect(written.payload).not.toHaveProperty('priceMinor');
    expect(written.expiresAt).toEqual(assistantDraftExpiry(DRAFTED_AT));
    expect(written.headline).toBe(MESSAGES.en.assistantProposalHeadline('trim', 'CCJ'));
    expect(written.localized.he).toEqual({
      headline: MESSAGES.he.assistantProposalHeadline('trim', 'CCJ'),
      explanation: 'It ran hard.',
    });
  });

  it('reads the mode before it writes, and a user who may not have advice gets nothing (D388)', async () => {
    vi.mocked(isAdvisory).mockResolvedValue(false);

    expect(await addDraftToProposals(USER, MESSAGE, NOW)).toBeNull();
    expect(queries.createAssistantProposal).not.toHaveBeenCalled();
  });

  it('answers null for a draft this user does not have', async () => {
    vi.mocked(queries.findAssistantDraft).mockResolvedValue(null);

    expect(await addDraftToProposals(USER, MESSAGE, NOW)).toBeNull();
    expect(queries.createAssistantProposal).not.toHaveBeenCalled();
  });

  it('writes nothing new when the same word is open on the stock, and says so', async () => {
    vi.mocked(queries.listOpenAcknowledgedProposals).mockResolvedValue([open('trim')]);
    vi.mocked(queries.findAssistantDraft)
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(row({ proposal_draft_state: 'added', proposal_draft_proposal_id: 'p-open' }));

    const view = await addDraftToProposals(USER, MESSAGE, NOW);

    expect(queries.createAssistantProposal).not.toHaveBeenCalled();
    expect(queries.applyProposalTransition).not.toHaveBeenCalled();
    expect(queries.markAssistantDraftAdded).toHaveBeenCalledWith(USER, MESSAGE, 'p-open');
    expect(view).toMatchObject({ state: 'added', proposalId: 'p-open', alreadyOpen: true });
  });

  it('closes another word as a system expiry, so two contradicting views are never open together (D392)', async () => {
    vi.mocked(queries.listOpenAcknowledgedProposals).mockResolvedValue([open('buy_more')]);

    await addDraftToProposals(USER, MESSAGE, NOW);

    // In the write's own transaction: a failure leaves the old view standing.
    expect(queries.applyProposalTransition).not.toHaveBeenCalled();
    expect(vi.mocked(queries.createAssistantProposal).mock.calls[0]![0].contradicting).toEqual([open('buy_more')]);
  });

  it('refuses a draft past its deadline, a closed one, and a second tap on an added one', async () => {
    const past = new Date(assistantDraftExpiry(DRAFTED_AT).getTime() + 1);
    expect(await addDraftToProposals(USER, MESSAGE, past)).toMatchObject({ state: 'expired' });

    vi.mocked(queries.findAssistantDraft).mockResolvedValue(row({ proposal_draft_state: 'closed' }));
    expect(await addDraftToProposals(USER, MESSAGE, NOW)).toMatchObject({ state: 'closed' });

    vi.mocked(queries.findAssistantDraft).mockResolvedValue(
      row({ proposal_draft_state: 'added', proposal_draft_proposal_id: 'p1' }),
    );
    expect(await addDraftToProposals(USER, MESSAGE, NOW)).toMatchObject({ state: 'added', proposalId: 'p1' });

    expect(queries.createAssistantProposal).not.toHaveBeenCalled();
  });
});

describe('Close', () => {
  it('marks the draft and writes no proposal', async () => {
    vi.mocked(queries.findAssistantDraft).mockResolvedValue(row({ proposal_draft_state: 'closed' }));

    expect(await closeDraft(USER, MESSAGE, NOW)).toMatchObject({ state: 'closed' });
    expect(queries.closeAssistantDraft).toHaveBeenCalledWith(
      USER,
      MESSAGE,
      new Date(NOW.getTime() - ASSISTANT_DRAFT_VALID_DAYS * 86_400_000),
    );
    expect(queries.createAssistantProposal).not.toHaveBeenCalled();
  });

  it('gives a user who may not have advice nothing, and changes nothing (D388)', async () => {
    vi.mocked(isAdvisory).mockResolvedValue(false);

    expect(await closeDraft(USER, MESSAGE, NOW)).toBeNull();
    expect(queries.closeAssistantDraft).not.toHaveBeenCalled();
  });
});

describe('a draft as a reply shows it', () => {
  it('expires ASSISTANT_DRAFT_VALID_DAYS after it was written, whatever it says in the row', () => {
    const expiry = new Date(DRAFTED_AT.getTime() + ASSISTANT_DRAFT_VALID_DAYS * 86_400_000);

    expect(draftView(row(), NOW)).toMatchObject({ state: 'open', expiresAt: expiry.toISOString() });
    expect(draftView(row(), expiry).state).toBe('expired');
    // An added one stays added: the deadline is the draft's question, not its history.
    expect(draftView(row({ proposal_draft_state: 'added' }), expiry).state).toBe('added');
  });
});

describe('a newer research rating', () => {
  it('closes the Ask proposals it changed, as a system expiry', async () => {
    vi.mocked(queries.listSupersededAssistantProposals).mockResolvedValue([
      { id: 'p1', user_id: USER, state: 'pending', evidence: {} },
    ]);

    expect(await sweepSupersededAssistantProposals()).toBe(1);
    expect(queries.applyProposalTransition).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: 'p1', toState: 'expired', surface: 'system' }),
    );
  });
});
