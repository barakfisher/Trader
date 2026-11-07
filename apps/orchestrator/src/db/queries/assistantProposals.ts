import type { ActionableRating, AssistantProposalPayload, LocalizedTexts } from '@traders/shared';

import { query, queryOne, transaction } from '../pool.js';
import { applyProposalTransitionIn } from './proposals.js';

/**
 * Ask's drafted proposals (D393, migration 0086). The AI service stores a draft on
 * the reply that wrote it; this side reads it, and writes the observation and
 * proposal only when the user taps Add to proposals.
 */

/** What the AI service stored in `assistant_messages.proposal_draft`. */
export interface StoredProposalDraft {
  action: ActionableRating;
  symbol: string;
  instrument_id: string;
  reason: string;
}

export interface AssistantDraftRow {
  message_id: string;
  conversation_id: string;
  user_id: string;
  created_at: Date;
  proposal_draft: StoredProposalDraft;
  proposal_draft_state: 'open' | 'added' | 'closed';
  proposal_draft_proposal_id: string | null;
  primary_agent_id: string;
}

export function findAssistantDraft(userId: string, messageId: string): Promise<AssistantDraftRow | null> {
  return queryOne<AssistantDraftRow>(
    `SELECT m.id AS message_id, m.conversation_id, m.user_id, m.created_at, m.proposal_draft,
            m.proposal_draft_state, m.proposal_draft_proposal_id, p.id AS primary_agent_id
       FROM assistant_messages m
       JOIN agents p ON p.user_id = m.user_id AND p.is_primary
      WHERE m.user_id = $1 AND m.id = $2 AND m.proposal_draft IS NOT NULL`,
    [userId, messageId],
  );
}

/**
 * Close an open draft written after `writtenAfter`. Nothing else changes: a draft
 * already added stays added, and one past its deadline stays as it is.
 */
export async function closeAssistantDraft(userId: string, messageId: string, writtenAfter: Date): Promise<void> {
  await query(
    `UPDATE assistant_messages SET proposal_draft_state = 'closed'
      WHERE user_id = $1 AND id = $2 AND proposal_draft_state = 'open' AND created_at > $3`,
    [userId, messageId, writtenAfter],
  );
}

/** The tap found the same word already open: the draft points at that proposal. */
export async function markAssistantDraftAdded(userId: string, messageId: string, proposalId: string): Promise<void> {
  await query(
    `UPDATE assistant_messages SET proposal_draft_state = 'added', proposal_draft_proposal_id = $3
      WHERE user_id = $1 AND id = $2 AND proposal_draft_state = 'open'`,
    [userId, messageId, proposalId],
  );
}

export interface OpenAcknowledgedProposalRow {
  id: string;
  state: 'pending' | 'snoozed';
  action: string;
  evidence: unknown;
}

/** The research and Ask proposals open on a stock: at most one word stands at a time (D392). */
export function listOpenAcknowledgedProposals(
  userId: string,
  primaryAgentId: string,
  symbol: string,
): Promise<OpenAcknowledgedProposalRow[]> {
  return query<OpenAcknowledgedProposalRow>(
    `SELECT p.id, p.state, p.payload ->> 'action' AS action, o.evidence
       FROM proposals p
       JOIN observations o ON o.id = p.observation_id
      WHERE p.user_id = $1 AND p.agent_id = $2 AND p.kind IN ('research', 'assistant')
        AND p.state IN ('pending', 'snoozed') AND p.expires_at > now()
        AND p.payload ->> 'symbol' = $3`,
    [userId, primaryAgentId, symbol],
  );
}

export interface AssistantProposalToCreate {
  userId: string;
  primaryAgentId: string;
  payload: AssistantProposalPayload;
  expiresAt: Date;
  headline: string;
  /** The model's reason, in the language of the question. */
  rationale: string;
  localized: LocalizedTexts;
  /** The open proposals on this stock in another word: this tap is the newer view (D392). */
  contradicting: OpenAcknowledgedProposalRow[];
}

/**
 * The draft's new state, the views it replaces closed, the observation and the
 * proposal, in one transaction: a failure leaves the old view standing. The draft
 * is claimed first, so a second tap or a Close that got there first answers null
 * and writes nothing.
 */
export function createAssistantProposal(proposal: AssistantProposalToCreate): Promise<string | null> {
  return transaction(async (client) => {
    const claimed = await client.query(
      `UPDATE assistant_messages SET proposal_draft_state = 'added'
        WHERE user_id = $1 AND id = $2 AND proposal_draft_state = 'open'`,
      [proposal.userId, proposal.payload.messageId],
    );
    if (claimed.rowCount === 0) return null;
    for (const contradicting of proposal.contradicting) {
      await applyProposalTransitionIn(client, {
        proposalId: contradicting.id,
        userId: proposal.userId,
        fromState: contradicting.state,
        toState: 'expired',
        // The user's tap raised the newer view; nobody decided the older one.
        surface: 'system',
        actorUserId: null,
        snoozedUntil: null,
        evidenceSnapshot: contradicting.evidence,
        idempotencyKey: null,
        intent: null,
        revokeIntent: false,
      });
    }
    const observation = await client.query<{ id: string }>(
      `INSERT INTO observations
         (user_id, agent_id, kind, severity, subject_kind, subject_ref, headline, explanation,
          evidence, dedupe_key, narration_source, localized)
       VALUES ($1, $2, 'assistant_view', 'notable', 'instrument', $3, $4, $5, $6::jsonb, $7, 'llm', $8::jsonb)
       ON CONFLICT (agent_id, dedupe_key) DO NOTHING
       RETURNING id`,
      [
        proposal.userId,
        proposal.primaryAgentId,
        `instrument:${proposal.payload.symbol}`,
        proposal.headline,
        proposal.rationale,
        // What the screens may read out; the ids and the action are in the proposal's payload.
        JSON.stringify({ symbol: proposal.payload.symbol }),
        `assistant:${proposal.payload.messageId}`,
        JSON.stringify(proposal.localized),
      ],
    );
    const observationId = observation.rows[0]!.id;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO proposals (user_id, agent_id, observation_id, kind, payload, expires_at)
       VALUES ($1, $2, $3, 'assistant', $4::jsonb, $5)
       RETURNING id`,
      [proposal.userId, proposal.primaryAgentId, observationId, JSON.stringify(proposal.payload), proposal.expiresAt],
    );
    const proposalId = inserted.rows[0]!.id;
    await client.query(
      `UPDATE assistant_messages SET proposal_draft_proposal_id = $3 WHERE user_id = $1 AND id = $2`,
      [proposal.userId, proposal.payload.messageId, proposalId],
    );
    return proposalId;
  });
}

export interface SupersededAssistantProposalRow {
  id: string;
  user_id: string;
  state: 'pending' | 'snoozed';
  evidence: unknown;
}

/**
 * Open Ask proposals whose stock the user's research agent rated in another word
 * after the proposal was raised (D393): the newer view closes it, as a newer
 * rating closes a research proposal (D392).
 */
export function listSupersededAssistantProposals(): Promise<SupersededAssistantProposalRow[]> {
  return query<SupersededAssistantProposalRow>(
    `-- agent-blind: every user's open Ask proposals, against each user's own research agent.
     SELECT p.id, p.user_id, p.state, o.evidence
       FROM proposals p
       JOIN observations o ON o.id = p.observation_id
       JOIN user_settings s ON s.user_id = p.user_id
      WHERE p.kind = 'assistant' AND p.state IN ('pending', 'snoozed') AND p.expires_at > now()
        AND (SELECT r.rating
               FROM research_ratings r
              WHERE r.user_id = p.user_id
                AND r.agent_id = s.research_agent_id
                AND r.instrument_id = (p.payload ->> 'instrumentId')::uuid
                AND r.status = 'rated'
                AND r.created_at > p.created_at
              ORDER BY r.created_at DESC, r.id DESC
              LIMIT 1) <> (p.payload ->> 'action')`,
  );
}
