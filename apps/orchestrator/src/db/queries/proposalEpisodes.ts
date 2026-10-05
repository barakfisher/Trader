import { query, queryOne } from '../pool.js';

export interface OpenEpisodeRow {
  id: string;
  subject_ref: string;
  /** Signed decimal string, as stored: the figure the question was asked at. */
  asked_magnitude: string;
}

export function listOpenEpisodes(userId: string, observationKind: string): Promise<OpenEpisodeRow[]> {
  return query<OpenEpisodeRow>(
    `SELECT id, subject_ref, asked_magnitude::text AS asked_magnitude
       FROM proposal_episodes
      WHERE user_id = $1 AND observation_kind = $2 AND closed_at IS NULL`,
    [userId, observationKind],
  );
}

/**
 * Open an episode, unless one is already open for this subject.
 *
 * Claimed before the proposal is raised: the partial unique index is what
 * makes two concurrent scans ask once, and returning null is how the loser
 * learns it lost.
 */
export async function claimEpisode(episode: {
  userId: string;
  observationKind: string;
  subjectRef: string;
  observationId: string;
  askedMagnitude: string;
}): Promise<string | null> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO proposal_episodes
            (user_id, agent_id, observation_kind, subject_ref, observation_id, asked_magnitude)
     VALUES ($1, (SELECT agent_id FROM observations WHERE id = $4::uuid), $2, $3, $4::uuid, $5::numeric)
     ON CONFLICT (user_id, observation_kind, subject_ref) WHERE closed_at IS NULL DO NOTHING
     RETURNING id`,
    [
      episode.userId,
      episode.observationKind,
      episode.subjectRef,
      episode.observationId,
      episode.askedMagnitude,
    ],
  );
  return row?.id ?? null;
}

export async function closeEpisodes(
  userId: string,
  ids: string[],
  reason: 'resolved' | 'worsened' | 'reversed',
): Promise<number> {
  if (ids.length === 0) return 0;
  const closed = await query<{ id: string }>(
    `UPDATE proposal_episodes
        SET closed_at = now(), close_reason = $3
      WHERE user_id = $1 AND id = ANY($2::uuid[]) AND closed_at IS NULL
      RETURNING id`,
    [userId, ids, reason],
  );
  return closed.length;
}
