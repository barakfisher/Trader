import type { LocalizedTexts, TradeProposalKind, TradeProposalPayload } from '@traders/shared';
import type { PoolClient } from 'pg';

import { query, queryOne, transaction } from '../pool.js';

/** A `trade` scan's answer, as the orchestrator writes it (migration 0044, D26). */
export interface TradeProposalToCreate {
  userId: string;
  agentId: string;
  scanId: string;
  kind: TradeProposalKind;
  payload: TradeProposalPayload;
  expiresAt: Date;
  /** The exchange's next open when the market is closed (0087, D398); null when it is open. */
  opensAt: Date | null;
  headline: string;
  /** The thesis, in the user's language (D51). */
  thesis: string;
  localized: LocalizedTexts;
  evidence: unknown;
}

/**
 * The observation carrying the thesis and the proposal hanging from it, in one
 * transaction: `proposals.observation_id` is required, so neither is useful
 * alone.
 *
 * Idempotent per scan: the observation's dedupe key and the proposal's unique
 * `scan_id` make a second call for the same scan - a retry after a lost reply -
 * answer the proposal the first one wrote.
 */
export interface CreatedTradeProposal {
  proposalId: string;
  /** The observation it hangs from: what a notification about it refers to. */
  observationId: string;
}

export function createTradeProposal(proposal: TradeProposalToCreate): Promise<CreatedTradeProposal> {
  return transaction((client) => createTradeProposalIn(client, proposal));
}

/** The same, inside the caller's transaction. */
export async function createTradeProposalIn(
  client: PoolClient,
  proposal: TradeProposalToCreate,
): Promise<CreatedTradeProposal> {
  // One proposal per trade (D197): a scan may decide several, one per symbol.
  const dedupeKey = `agent_scan:${proposal.scanId}:${proposal.payload.symbol}`;
  await client.query(
    `INSERT INTO observations
       (user_id, agent_id, kind, severity, subject_kind, subject_ref, headline, explanation,
        evidence, dedupe_key, narration_source, localized)
     VALUES ($1, $2, 'agent_trade', 'notable', 'instrument', $3, $4, $5, $6::jsonb, $7, 'llm',
             $8::jsonb)
     ON CONFLICT (agent_id, dedupe_key) DO NOTHING`,
    [
      proposal.userId,
      proposal.agentId,
      `instrument:${proposal.payload.symbol}`,
      proposal.headline,
      proposal.thesis,
      JSON.stringify(proposal.evidence ?? {}),
      dedupeKey,
      JSON.stringify(proposal.localized),
    ],
  );
  const inserted = await client.query<{ id: string; observation_id: string }>(
    `INSERT INTO proposals (user_id, agent_id, observation_id, kind, payload, expires_at, scan_id, opens_at)
     SELECT $1, $2, o.id, $3, $4::jsonb, $5, $6, $8
       FROM observations o
      WHERE o.agent_id = $2 AND o.dedupe_key = $7
     ON CONFLICT DO NOTHING
     RETURNING id, observation_id`,
    [
      proposal.userId,
      proposal.agentId,
      proposal.kind,
      JSON.stringify(proposal.payload),
      proposal.expiresAt,
      proposal.scanId,
      dedupeKey,
      proposal.opensAt,
    ],
  );
  const row =
    inserted.rows[0] ??
    (
      await client.query<{ id: string; observation_id: string }>(
        `SELECT id, observation_id FROM proposals
          WHERE user_id = $1 AND agent_id = $2 AND scan_id = $3 AND payload ->> 'symbol' = $4`,
        [proposal.userId, proposal.agentId, proposal.scanId, proposal.payload.symbol],
      )
    ).rows[0];
  if (!row) throw new Error(`scan ${proposal.scanId} wrote no proposal`);
  return { proposalId: row.id, observationId: row.observation_id };
}

/** A scan's trade proposal whose announcement was held back and has not been pushed since (D420). */
export interface HeldTradeProposalRow {
  proposal_id: string;
  user_id: string;
  agent_id: string;
  observation_id: string;
  kind: 'buy' | 'sell';
  scan_id: string;
  /** The open it waits for (0087); null when it was raised into an open market. */
  opens_at: Date | null;
  created_at: Date;
  headline: string;
  /** The thesis, as the model wrote it. */
  explanation: string;
  localized: LocalizedTexts;
  /** Why the announcement went to the digest instead of the channel. */
  held_reason: 'quiet_hours' | 'muted';
}

/**
 * Trade proposals a scan raised while its user was not to be interrupted, that
 * are still open and were never sent on `channel`. The digest row is the record
 * that it was held (`notifications.reason`); a row on the channel, sent or
 * failed, is the record that it was announced, so a proposal leaves this list
 * the moment it is. One the user has already answered for the open (0087) - on
 * the dashboard, while it was held - is not asked again.
 */
export function listHeldTradeProposals(channel: string, now: Date): Promise<HeldTradeProposalRow[]> {
  return query<HeldTradeProposalRow>(
    `-- agent-blind: every user's agents in one sweep; each row carries its user_id and agent_id.
     SELECT p.id AS proposal_id, p.user_id, p.agent_id, p.observation_id, p.kind, p.scan_id,
            p.opens_at, p.created_at, o.headline, o.explanation, o.localized,
            held.reason AS held_reason
       FROM proposals p
       JOIN observations o ON o.id = p.observation_id AND o.user_id = p.user_id
       JOIN users u ON u.id = p.user_id AND u.status = 'active'
       JOIN notifications held
         ON held.user_id = p.user_id AND held.ref_kind = 'observation'
        AND held.ref_id = p.observation_id AND held.channel = 'digest'
        AND held.reason IN ('quiet_hours', 'muted')
      WHERE p.kind IN ('buy', 'sell')
        AND p.scan_id IS NOT NULL
        AND p.state = 'pending'
        AND p.open_approval IS NULL
        AND p.expires_at > $2
        AND NOT EXISTS (
              SELECT 1 FROM notifications sent
               WHERE sent.user_id = p.user_id AND sent.ref_kind = 'observation'
                 AND sent.ref_id = p.observation_id AND sent.channel = $1)
      ORDER BY p.created_at`,
    [channel, now],
  );
}

export interface ProposalAttemptToRecord {
  userId: string;
  proposalId: string;
  surface: 'web' | 'telegram';
  reason: string;
  agentPriceMinor: bigint;
  livePriceMinor: bigint | null;
  quoteAsOf: string | null;
}

/** A refused approval (D49). Written outside any transaction: the refusal rolled nothing back to record. */
export async function recordProposalAttempt(attempt: ProposalAttemptToRecord): Promise<void> {
  await query(
    `-- agent-blind: addressed by the proposal's own id.
     INSERT INTO proposal_attempts
       (user_id, proposal_id, surface, reason, agent_price_minor, live_price_minor, quote_as_of)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      attempt.userId,
      attempt.proposalId,
      attempt.surface,
      attempt.reason,
      attempt.agentPriceMinor.toString(),
      attempt.livePriceMinor?.toString() ?? null,
      attempt.quoteAsOf,
    ],
  );
}

export interface ProposalAttemptRow {
  surface: 'web' | 'telegram';
  reason: string;
  agent_price_minor: string;
  live_price_minor: string | null;
  quote_as_of: Date | null;
  created_at: Date;
}

/** A proposal's refused approvals, newest first. */
export function listProposalAttempts(userId: string, proposalId: string): Promise<ProposalAttemptRow[]> {
  return query<ProposalAttemptRow>(
    `-- agent-blind: addressed by the proposal's own id.
     SELECT surface, reason, agent_price_minor::text AS agent_price_minor,
            live_price_minor::text AS live_price_minor, quote_as_of, created_at
       FROM proposal_attempts
      WHERE user_id = $1 AND proposal_id = $2
      ORDER BY created_at DESC`,
    [userId, proposalId],
  );
}

/** The trade proposal a scan wrote, if any. */
export async function findProposalIdForScan(userId: string, scanId: string): Promise<string | null> {
  const row = await queryOne<{ id: string }>(
    `-- agent-blind: addressed by the scan's own id.
     SELECT id FROM proposals WHERE user_id = $1 AND scan_id = $2`,
    [userId, scanId],
  );
  return row?.id ?? null;
}
