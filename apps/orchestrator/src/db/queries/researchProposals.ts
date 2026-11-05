import type { LocalizedTexts, ResearchProposalPayload } from '@traders/shared';

import { query, transaction } from '../pool.js';

/**
 * Research views raised as acknowledge-only proposals on the real portfolio
 * (D389, migration 0085). The AI service writes the ratings; the proposal
 * sweep reads them here and writes the observation and proposal of each view
 * that asks for an action.
 */

export interface ResearchViewRow {
  rating_id: string;
  user_id: string;
  /** The research agent that rated. */
  agent_id: string;
  agent_name: string;
  /** The real portfolio's agent: the proposal is asked of it (D1, 0085). */
  primary_agent_id: string;
  instrument_id: string;
  symbol: string;
  rating: string;
  rationale: string;
  rated_at: Date;
  /** The same agent's rated rating of the same stock before this one; null for the first. */
  previous_rating: string | null;
}

/**
 * Each user's latest rating of each stock by the agent assigned now, made
 * after `since`, with the rating before it. A reassignment hides the old
 * agent's ratings here as the page does (D293).
 */
export function listLatestResearchViews(since: Date): Promise<ResearchViewRow[]> {
  return query<ResearchViewRow>(
    `-- agent-blind: every user's research agent, named by user_settings and on each row.
     WITH latest AS (
       SELECT DISTINCT ON (r.user_id, r.instrument_id)
              r.id, r.user_id, r.agent_id, r.instrument_id, r.symbol, r.rating, r.rationale, r.created_at
         FROM research_ratings r
         JOIN user_settings s ON s.user_id = r.user_id AND s.research_agent_id = r.agent_id
        WHERE r.status = 'rated' AND r.created_at > $1
        ORDER BY r.user_id, r.instrument_id, r.created_at DESC, r.id DESC
     )
     SELECT l.id AS rating_id, l.user_id, l.agent_id, a.name AS agent_name, p.id AS primary_agent_id,
            l.instrument_id, l.symbol, l.rating, l.rationale, l.created_at AS rated_at,
            (SELECT b.rating
               FROM research_ratings b
              WHERE b.user_id = l.user_id AND b.agent_id = l.agent_id
                AND b.instrument_id = l.instrument_id AND b.status = 'rated'
                AND (b.created_at, b.id) < (l.created_at, l.id)
              ORDER BY b.created_at DESC, b.id DESC
              LIMIT 1) AS previous_rating
       FROM latest l
       JOIN agents a ON a.id = l.agent_id AND a.user_id = l.user_id
       JOIN agents p ON p.user_id = l.user_id AND p.is_primary
      ORDER BY l.user_id, l.symbol`,
    [since],
  );
}

export interface ResearchProposalToCreate {
  userId: string;
  primaryAgentId: string;
  payload: ResearchProposalPayload;
  expiresAt: Date;
  headline: string;
  /** The rationale, in the language the agent wrote it (D389). */
  rationale: string;
  localized: LocalizedTexts;
  ratedAt: Date;
}

export interface CreatedResearchProposal {
  proposalId: string;
  observationId: string;
}

/** The observation key of a rating's view: one proposal per rating, ever. */
export function researchViewDedupeKey(ratingId: string): string {
  return `research:${ratingId}`;
}

/**
 * The observation carrying the view and the proposal hanging from it, in one
 * transaction. Idempotent per rating: a second sweep over the same rating -
 * and a rating the user already answered - writes nothing and answers null.
 */
export function createResearchProposal(proposal: ResearchProposalToCreate): Promise<CreatedResearchProposal | null> {
  return transaction(async (client) => {
    const dedupeKey = researchViewDedupeKey(proposal.payload.ratingId);
    const observation = await client.query<{ id: string }>(
      `INSERT INTO observations
         (user_id, agent_id, kind, severity, subject_kind, subject_ref, headline, explanation,
          evidence, dedupe_key, narration_source, localized)
       VALUES ($1, $2, 'research_view', 'notable', 'instrument', $3, $4, $5, $6::jsonb, $7, 'llm', $8::jsonb)
       ON CONFLICT (agent_id, dedupe_key) DO NOTHING
       RETURNING id`,
      [
        proposal.userId,
        proposal.primaryAgentId,
        `instrument:${proposal.payload.symbol}`,
        proposal.headline,
        proposal.rationale,
        // What the view is, not its figures: those are the rating's own evidence,
        // which the research page shows and `ratingId` names.
        JSON.stringify({
          symbol: proposal.payload.symbol,
          rating: proposal.payload.action,
          research_agent: proposal.payload.researchAgentName,
          rated_at: proposal.ratedAt.toISOString(),
        }),
        dedupeKey,
        JSON.stringify(proposal.localized),
      ],
    );
    const observationId = observation.rows[0]?.id;
    if (observationId === undefined) return null;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO proposals (user_id, agent_id, observation_id, kind, payload, expires_at)
       VALUES ($1, $2, $3, 'research', $4::jsonb, $5)
       RETURNING id`,
      [proposal.userId, proposal.primaryAgentId, observationId, JSON.stringify(proposal.payload), proposal.expiresAt],
    );
    return { proposalId: inserted.rows[0]!.id, observationId };
  });
}

export interface SupersededResearchProposalRow {
  id: string;
  user_id: string;
  state: 'pending' | 'snoozed';
  evidence: unknown;
}

/**
 * Open research proposals whose stock the same agent has rated differently
 * since (D389: a change closes the open view). A newer rating in the same word
 * leaves it open: the view still stands.
 */
export function listSupersededResearchProposals(): Promise<SupersededResearchProposalRow[]> {
  return query<SupersededResearchProposalRow>(
    `-- agent-blind: every user's open research proposals; each names its research agent.
     SELECT p.id, p.user_id, p.state, o.evidence
       FROM proposals p
       JOIN observations o ON o.id = p.observation_id
      WHERE p.kind = 'research' AND p.state IN ('pending', 'snoozed') AND p.expires_at > now()
        AND (SELECT r.rating
               FROM research_ratings r
              WHERE r.user_id = p.user_id
                AND r.agent_id = (p.payload ->> 'researchAgentId')::uuid
                AND r.instrument_id = (p.payload ->> 'instrumentId')::uuid
                AND r.status = 'rated'
              ORDER BY r.created_at DESC, r.id DESC
              LIMIT 1) IS DISTINCT FROM (p.payload ->> 'action')`,
  );
}
