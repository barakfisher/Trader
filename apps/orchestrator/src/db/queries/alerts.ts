import { query, queryOne } from '../pool.js';
import type { ObservationRow } from './observations.js';

/**
 * Where an alert came from (decision 134, the user's pills, 2026-10-11): the
 * main portfolio's holdings and allocation, a followed topic, or an agent's
 * trade proposal.
 */
export type AlertSource = 'portfolio' | 'topics' | 'agents';

export interface AlertRow extends ObservationRow {
  agent_id: string;
  agent_name: string;
  agent_is_primary: boolean;
  route: 'push' | 'digest';
  reason: string;
  status: string;
  sent_at: string | null;
}

/**
 * The findings the user was told about: a notification routed `push`, or one
 * quiet hours deferred to the digest. Below-floor and muted digest entries are
 * not alerts - they were never meant to interrupt.
 *
 * One row per finding: a finding is routed once, and if both rows ever existed
 * the push is the one that describes what the user was told.
 */
const ALERT_JOIN = `
  JOIN agents a ON a.id = o.agent_id AND a.user_id = o.user_id
  JOIN LATERAL (
        SELECT n.route, n.reason, n.status, n.sent_at
          FROM notifications n
         WHERE n.user_id = o.user_id
           AND n.ref_kind = 'observation'
           AND n.ref_id = o.id
           AND (n.route = 'push' OR n.reason = 'quiet_hours')
         ORDER BY (n.route = 'push') DESC, n.created_at DESC
         LIMIT 1) n ON true`;

/** `$${first}` is the source, or null for every source. */
function sourceWhere(first: number): string {
  return `AND ($${first}::text IS NULL
            OR ($${first} = 'portfolio' AND a.is_primary AND o.subject_kind <> 'topic')
            OR ($${first} = 'topics' AND a.is_primary AND o.subject_kind = 'topic')
            OR ($${first} = 'agents' AND NOT a.is_primary))`;
}

/**
 * Every agent's alerts, newest first. `before` continues after the alert with
 * that observation id, by the same ordering key, as `listObservations` does.
 */
export function listAlerts(
  userId: string,
  limit: number,
  source: AlertSource | null,
  before: string | null,
): Promise<AlertRow[]> {
  return query<AlertRow>(
    `-- agent-blind: every agent's alerts, by design (decision 134); each row names its agent_id.
     SELECT o.id, o.kind, o.severity, o.subject_kind, o.subject_ref, o.headline, o.explanation,
            o.evidence, o.concept_refs, o.narration_source, o.fallback_reason, o.localized,
            o.created_at, o.agent_id, a.name AS agent_name, a.is_primary AS agent_is_primary,
            n.route, n.reason, n.status, n.sent_at
       FROM observations o
       ${ALERT_JOIN}
      WHERE o.user_id = $1
        ${sourceWhere(3)}
        AND ($4::uuid IS NULL OR (o.created_at, o.id) < (
              SELECT b.created_at, b.id FROM observations b WHERE b.id = $4 AND b.user_id = $1))
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT $2`,
    [userId, limit, source, before],
  );
}

export async function countAlerts(userId: string, source: AlertSource | null): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `-- agent-blind: every agent's alerts, by design (decision 134).
     SELECT count(*)::text AS count
       FROM observations o
       ${ALERT_JOIN}
      WHERE o.user_id = $1
        ${sourceWhere(2)}`,
    [userId, source],
  );
  return Number(row?.count ?? 0);
}
