/**
 * The user's tap on a proposal Ask drafted (D393, D387 case 4).
 *
 * The model only drafts, on its reply. This is the one write behind it, and the
 * only caller is a button the user pressed, in the app or in Telegram. Approving
 * the proposal later only acknowledges it: no holding changes until the user
 * records the trade they made at the broker (D387), and the `0086` trigger refuses
 * a quantity, a price or any fill on the primary.
 *
 * **One word per stock (D392):** the same word already open writes nothing and
 * points the draft at that proposal; another word closes the open one as a system
 * expiry, because this tap is the newer view, in the same transaction as the write.
 *
 * **Told nobody else.** The user has just pressed the button, so unlike a research
 * view this sends no alert; it waits in the inbox and on `/pending`.
 */

import {
  ASSISTANT_DRAFT_VALID_DAYS,
  UI_LANGUAGES,
  type AssistantProposalDraftView,
  type AssistantProposalPayload,
  type LocalizedTexts,
  type TranslatedLanguage,
} from '@traders/shared';

import {
  applyProposalTransition,
  closeAssistantDraft,
  createAssistantProposal,
  findAssistantDraft,
  listOpenAcknowledgedProposals,
  listSupersededAssistantProposals,
  markAssistantDraftAdded,
  type AssistantDraftRow,
} from '../db/queries.js';
import { logger } from '../logger.js';
import { messagesFor } from '../notify/messages.js';
import { isAdvisory } from './advisoryMode.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A draft's deadline, and the proposal's after it: counted from the writing, not the tap. */
export function assistantDraftExpiry(draftedAt: Date): Date {
  return new Date(draftedAt.getTime() + ASSISTANT_DRAFT_VALID_DAYS * DAY_MS);
}

export function draftView(
  row: Pick<AssistantDraftRow, 'created_at' | 'proposal_draft' | 'proposal_draft_state' | 'proposal_draft_proposal_id'>,
  now: Date,
  alreadyOpen = false,
): AssistantProposalDraftView {
  const expiresAt = assistantDraftExpiry(row.created_at);
  const state = row.proposal_draft_state;
  return {
    action: row.proposal_draft.action,
    symbol: row.proposal_draft.symbol,
    reason: row.proposal_draft.reason,
    state: state === 'open' && expiresAt <= now ? 'expired' : state,
    expiresAt: expiresAt.toISOString(),
    proposalId: row.proposal_draft_proposal_id,
    alreadyOpen,
  };
}

async function refreshed(userId: string, messageId: string, now: Date, alreadyOpen = false) {
  const row = await findAssistantDraft(userId, messageId);
  return row === null ? null : draftView(row, now, alreadyOpen);
}

/**
 * What the user sees after Add to proposals; null when this user has no such
 * draft, and for a user who may not receive advice (`isAdvisory`, D388), who is
 * never shown one either.
 */
export async function addDraftToProposals(
  userId: string,
  messageId: string,
  now: Date = new Date(),
): Promise<AssistantProposalDraftView | null> {
  if (!(await isAdvisory(userId))) return null;
  const row = await findAssistantDraft(userId, messageId);
  if (row === null) return null;
  const view = draftView(row, now);
  if (view.state !== 'open') return view;

  const { action, symbol, instrument_id: instrumentId, reason } = row.proposal_draft;
  const open = await listOpenAcknowledgedProposals(userId, row.primary_agent_id, symbol);
  const same = open.find((proposal) => proposal.action === action);
  if (same !== undefined) {
    await markAssistantDraftAdded(userId, messageId, same.id);
    return refreshed(userId, messageId, now, true);
  }
  const payload: AssistantProposalPayload = {
    action,
    symbol,
    instrumentId,
    messageId,
    conversationId: row.conversation_id,
  };
  const headlineIn = (language: string) => messagesFor(language).assistantProposalHeadline(action, symbol);
  // The reason is in the question's language: every UI language shows the
  // catalogue's headline over the same words, as a research view does.
  const localized: LocalizedTexts = Object.fromEntries(
    UI_LANGUAGES.filter((language): language is TranslatedLanguage => language !== 'en').map((language) => [
      language,
      { headline: headlineIn(language), explanation: reason },
    ]),
  );
  const proposalId = await createAssistantProposal({
    userId,
    primaryAgentId: row.primary_agent_id,
    payload,
    expiresAt: assistantDraftExpiry(row.created_at),
    headline: headlineIn('en'),
    rationale: reason,
    localized,
    contradicting: open,
  });
  if (proposalId !== null) logger().info({ proposalId, messageId, action }, 'proposal.assistant_raised');
  // Null is a tap that lost the race: what the other one did is what is true.
  return refreshed(userId, messageId, now);
}

/** Close: the draft stays in the conversation, marked, and no proposal is written. */
export async function closeDraft(
  userId: string,
  messageId: string,
  now: Date = new Date(),
): Promise<AssistantProposalDraftView | null> {
  if (!(await isAdvisory(userId))) return null;
  // Past the deadline there is nothing to close: the draft says it has expired.
  await closeAssistantDraft(userId, messageId, new Date(now.getTime() - ASSISTANT_DRAFT_VALID_DAYS * DAY_MS));
  return refreshed(userId, messageId, now);
}

/** Close the open Ask proposals a newer research rating changed (D393). */
export async function sweepSupersededAssistantProposals(): Promise<number> {
  let superseded = 0;
  for (const row of await listSupersededAssistantProposals()) {
    const result = await applyProposalTransition({
      proposalId: row.id,
      userId: row.user_id,
      fromState: row.state,
      toState: 'expired',
      surface: 'system',
      actorUserId: null,
      snoozedUntil: null,
      evidenceSnapshot: row.evidence,
      idempotencyKey: null,
      intent: null,
      revokeIntent: false,
    });
    if (result.applied) superseded += 1;
  }
  if (superseded > 0) logger().info({ superseded }, 'proposal.assistant_superseded');
  return superseded;
}
