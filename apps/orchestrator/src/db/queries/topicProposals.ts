import type { PoolClient } from 'pg';
import type { ProposalBand, TopicEvidence } from '@traders/shared';
import { query } from '../pool.js';
import { LIVE_TOPIC, TopicStatus } from './topics.js';

/** A topic discovery compares a new theme against, with its fingerprint. */
export interface KnownThemeRow {
  id: string;
  label: string;
  status: TopicStatus;
  /** An auto-proposal's band; null for a topic the user created. */
  proposal_band: ProposalBand | null;
  /** Stored on auto topics when proposed; null for a topic the user created. */
  match_words: string[] | null;
  /** Confirmed instruments of an active topic; the offered set of a proposal. */
  instrument_ids: string[];
}

/**
 * Every theme a new proposal must not repeat: the user's active topics, their
 * open proposals, what they rejected within the last `cooldownDays`, and the
 * proposals that expired unanswered within the last `expiredDays`.
 *
 * An active topic is compared by the instruments the user *confirmed*, since
 * that is what they follow now; a proposal or a rejection by the set it was
 * offered with, frozen when it was proposed, so a later change to the universe
 * cannot quietly un-reject it.
 */
export function listKnownThemes(
  userId: string,
  cooldownDays: number,
  expiredDays: number,
): Promise<KnownThemeRow[]> {
  return query<KnownThemeRow>(
    `SELECT t.id, t.label, t.status, t.proposal_band, t.match_words,
            CASE WHEN t.status = 'active'
                 THEN coalesce((SELECT array_agg(ti.instrument_id::text ORDER BY ti.instrument_id)
                                  FROM topic_instruments ti
                                 WHERE ti.topic_id = t.id), '{}')
                 ELSE coalesce(t.proposed_instruments::text[], '{}')
            END AS instrument_ids
       FROM topics t
      WHERE t.user_id = $1
        AND (t.${LIVE_TOPIC}
             OR (t.status = 'rejected' AND t.rejected_at >= now() - make_interval(days => $2::int))
             OR (t.status = 'expired' AND t.expired_at >= now() - make_interval(days => $3::int)))
      ORDER BY t.created_at, t.id`,
    [userId, cooldownDays, expiredDays],
  );
}

/**
 * Expire this user's proposals that have waited `ttlDays` or more for an
 * answer, and return their labels. Run under `lockTopicsForWrite`, so a confirm
 * or a reject racing it either lands first (and the row is no longer
 * `proposed`) or waits and finds it expired.
 *
 * Measured from `created_at`, since a proposal is never edited while it waits.
 */
export async function expireProposals(
  client: PoolClient,
  userId: string,
  ttlDays: number,
): Promise<string[]> {
  const { rows } = await client.query<{ label: string }>(
    `UPDATE topics
        SET status = 'expired', expired_at = now(), updated_at = now()
      WHERE user_id = $1 AND status = 'proposed'
        AND created_at <= now() - make_interval(days => $2::int)
     RETURNING label`,
    [userId, ttlDays],
  );
  return rows.map((row) => row.label).sort();
}

/**
 * Open proposals by band, counted under the lock `lockTopicsForWrite` takes.
 * Each band has its own cap, so they are never summed.
 */
export async function countOpenProposals(
  client: PoolClient,
  userId: string,
): Promise<Record<ProposalBand, number>> {
  const { rows } = await client.query<{ band: ProposalBand; open: number }>(
    `SELECT proposal_band AS band, count(*)::int AS open
       FROM topics
      WHERE user_id = $1 AND status = 'proposed'
      GROUP BY proposal_band`,
    [userId],
  );
  const open: Record<ProposalBand, number> = { confident: 0, weak: 0 };
  for (const row of rows) open[row.band] = row.open;
  return open;
}

export interface ProposalInput {
  userId: string;
  label: string;
  matchWords: string[];
  instrumentIds: string[];
  evidence: TopicEvidence;
  band: ProposalBand;
}

/**
 * Write one auto-proposal. Returns `duplicate` when the label is already a live
 * topic of this user; the matching rule should have caught that first, so this
 * is the index's last word rather than the normal path.
 */
export async function insertProposal(
  client: PoolClient,
  input: ProposalInput,
): Promise<{ id: string } | { duplicate: true }> {
  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO topics
              (user_id, label, status, created_by, match_words, proposed_instruments, evidence,
               proposal_band)
       VALUES ($1, $2, 'proposed', 'auto', $3::text[], $4::uuid[], $5::jsonb, $6)
       RETURNING id`,
      [
        input.userId,
        input.label,
        input.matchWords,
        input.instrumentIds,
        JSON.stringify(input.evidence),
        input.band,
      ],
    );
    return { id: rows[0]!.id };
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return { duplicate: true };
    throw error;
  }
}

/**
 * Decline a proposal: it becomes rejection memory, and leaves every list.
 *
 * `not_a_proposal` when the topic exists but is one the user follows - a
 * followed topic is deleted, not rejected, and the constraint in migration 0019
 * would refuse the write anyway.
 */
export async function rejectProposal(
  userId: string,
  topicId: string,
): Promise<'rejected' | 'not_found' | 'not_a_proposal'> {
  const rows = await query<{ status: TopicStatus; rejected: boolean }>(
    `WITH target AS (
       SELECT id, status FROM topics
        WHERE user_id = $1 AND id = $2 AND ${LIVE_TOPIC}
     ),
     updated AS (
       UPDATE topics t
          SET status = 'rejected', rejected_at = now(), updated_at = now()
         FROM target
        -- Re-checked on the row itself: a confirm that won the race has
        -- already made it active, and an active topic is not rejected.
        WHERE t.id = target.id AND t.status = 'proposed'
       RETURNING t.id
     )
     SELECT target.status, EXISTS (SELECT 1 FROM updated) AS rejected FROM target`,
    [userId, topicId],
  );
  const row = rows[0];
  if (!row) return 'not_found';
  return row.rejected ? 'rejected' : 'not_a_proposal';
}
