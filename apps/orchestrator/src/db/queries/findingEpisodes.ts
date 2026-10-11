import { query } from '../pool.js';

export interface OpenFindingEpisodeRow {
  id: string;
  kind: string;
  subject_ref: string;
  /** The highest band the episode has written. */
  severity: string;
}

export function listOpenFindingEpisodes(
  userId: string,
  agentId: string,
): Promise<OpenFindingEpisodeRow[]> {
  return query<OpenFindingEpisodeRow>(
    `SELECT id, kind, subject_ref, severity
       FROM finding_episodes
      WHERE user_id = $1 AND agent_id = $2 AND closed_at IS NULL`,
    [userId, agentId],
  );
}

const RANK = (column: string) =>
  `CASE ${column} WHEN 'high' THEN 2 WHEN 'notable' THEN 1 ELSE 0 END`;

/**
 * Open an episode for a newly written state, or raise its band.
 *
 * The scan writes a state only when it is above its episode's band, so the
 * update normally always applies; the guard keeps a late, lower write from a
 * concurrent scan from lowering what has already been said.
 */
export async function recordFindingEpisode(episode: {
  userId: string;
  agentId: string;
  kind: string;
  subjectRef: string;
  severity: string;
  observationId: string;
}): Promise<void> {
  await query(
    `INSERT INTO finding_episodes (user_id, agent_id, kind, subject_ref, severity, observation_id)
     VALUES ($1, $2, $3, $4, $5, $6::uuid)
     ON CONFLICT (agent_id, kind, subject_ref) WHERE closed_at IS NULL
     DO UPDATE SET severity = EXCLUDED.severity,
                   observation_id = EXCLUDED.observation_id,
                   updated_at = now()
           WHERE ${RANK('EXCLUDED.severity')} > ${RANK('finding_episodes.severity')}`,
    [
      episode.userId,
      episode.agentId,
      episode.kind,
      episode.subjectRef,
      episode.severity,
      episode.observationId,
    ],
  );
}

export async function closeFindingEpisodes(userId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const closed = await query<{ id: string }>(
    `-- agent-blind: addressed by the episodes' own ids, read per agent by listOpenFindingEpisodes.
     UPDATE finding_episodes
        SET closed_at = now()
      WHERE user_id = $1 AND id = ANY($2::uuid[]) AND closed_at IS NULL
      RETURNING id`,
    [userId, ids],
  );
  return closed.length;
}
