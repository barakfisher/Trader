import type { LocalizedTexts } from '@traders/shared';
import { query, queryOne } from '../pool.js';

export interface NotificationToRecord {
  userId: string;
  /** The agent that owns the row (migration 0036); the primary's in Stage 1. */
  agentId: string;
  channel: string;
  refKind: string;
  refId: string;
  route: string;
  reason: string;
  status: string;
  dedupeKey: string;
}

export interface NotificationRow {
  id: string;
  channel: string;
  ref_kind: string;
  ref_id: string;
  route: string;
  reason: string;
  status: string;
  dedupe_key: string;
  sent_at: Date | null;
  created_at: Date;
}

/**
 * Claim a notification before sending it.
 *
 * The INSERT *is* the claim: `dedupe_key` is unique, so a row coming back means
 * this process is the one that gets to send, and no row means somebody already
 * did. The order is what matters here - claim, then send, then mark. Sending
 * first and recording afterwards leaves a window in which a crash loses the
 * record of a message that already reached the user, and the retry then sends
 * it again. A message cannot be recalled, so the window has to be on the side
 * that costs a missing row rather than a duplicate alert.
 */
export async function claimNotification(
  notification: NotificationToRecord,
): Promise<{ id: string } | null> {
  return queryOne<{ id: string }>(
    `INSERT INTO notifications
       (user_id, agent_id, channel, ref_kind, ref_id, route, reason, status, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      notification.userId,
      notification.agentId,
      notification.channel,
      notification.refKind,
      notification.refId,
      notification.route,
      notification.reason,
      notification.status,
      notification.dedupeKey,
    ],
  );
}

/**
 * Record what became of a claimed notification.
 *
 * `sent_at` is set here rather than at claim time because the two are genuinely
 * different moments - a digest entry is claimed when it is deferred and sent
 * hours later - and the database refuses a 'sent' row without one.
 */
export async function settleNotification(
  id: string,
  status: 'sent' | 'failed' | 'suppressed',
  error?: string,
): Promise<void> {
  await query(
    `-- agent-blind: addressed by the row's own id.
     UPDATE notifications
        SET status = $2,
            sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE NULL END,
            error = $3
      WHERE id = $1`,
    [id, status, error ?? null],
  );
}

/** Everything deferred into the digest and not yet rolled up. */
export function listPendingDigest(userId: string, limit = 100): Promise<NotificationRow[]> {
  return query<NotificationRow>(
    `-- agent-blind: what is sent is the user's - one chat and one digest for every agent (§7.2).
     SELECT id, channel, ref_kind, ref_id, route, reason, status, dedupe_key,
            sent_at, created_at
       FROM notifications
      WHERE user_id = $1
        AND channel = 'digest'
        AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT $2`,
    [userId, limit],
  );
}

/** The notification log, newest first: what the user was told, and what they were not. */
export function listNotifications(userId: string, limit = 50): Promise<NotificationRow[]> {
  return query<NotificationRow>(
    `-- agent-blind: what is sent is the user's - one chat and one digest for every agent (§7.2).
     SELECT id, channel, ref_kind, ref_id, route, reason, status, dedupe_key,
            sent_at, created_at
       FROM notifications
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
}

export interface DigestEntryRow {
  notification_id: string;
  reason: string;
  status: string;
  sent_at: Date | null;
  created_at: Date;
  /** Null for a narration notice, which is not a finding. */
  observation_id: string | null;
  headline: string | null;
  /** Null for a notice, which has no observation behind it. */
  localized: LocalizedTexts | null;
  severity: string | null;
  subject_ref: string | null;
}

const DIGEST_ENTRY_COLUMNS = `
  n.id AS notification_id, n.reason, n.status, n.sent_at, n.created_at,
  o.id AS observation_id, o.headline, o.localized, o.severity, o.subject_ref`;

/** What the next daily digest will carry: every digest-channel row still pending, oldest first. */
export function listPendingDigestEntries(userId: string): Promise<DigestEntryRow[]> {
  return query<DigestEntryRow>(
    `-- agent-blind: what is sent is the user's - one chat and one digest for every agent (§7.2).
     SELECT ${DIGEST_ENTRY_COLUMNS}
       FROM notifications n
       LEFT JOIN observations o ON n.ref_kind = 'observation' AND o.id = n.ref_id
      WHERE n.user_id = $1 AND n.channel = 'digest' AND n.status = 'pending'
      ORDER BY n.created_at`,
    [userId],
  );
}

/**
 * The last digest that was delivered. A digest is not stored as a message: it
 * is the batch of digest-channel rows one run settled as `sent`, which lands
 * within milliseconds (measured 2026-09-30: every batch spread under 0.06 s) -
 * so the batch is the rows sent within a minute of the latest `sent_at`.
 */
export function listLastDigestEntries(userId: string): Promise<DigestEntryRow[]> {
  return query<DigestEntryRow>(
    `-- agent-blind: what is sent is the user's - one chat and one digest for every agent (§7.2).
     WITH last AS (
       SELECT max(sent_at) AS at FROM notifications
        WHERE user_id = $1 AND channel = 'digest' AND status = 'sent')
     SELECT ${DIGEST_ENTRY_COLUMNS}
       FROM notifications n
       LEFT JOIN observations o ON n.ref_kind = 'observation' AND o.id = n.ref_id
       CROSS JOIN last
      WHERE n.user_id = $1 AND n.channel = 'digest' AND n.status = 'sent'
        AND n.sent_at > last.at - interval '1 minute'
      ORDER BY n.created_at`,
    [userId],
  );
}
