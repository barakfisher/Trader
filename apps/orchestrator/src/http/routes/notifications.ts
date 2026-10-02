/**
 * The notification log.
 *
 * This is `GET /runs` for messages, and it exists for the same reason: the
 * useful question is not "is the channel up?" but **"did the user actually hear
 * about it, and if not, why not?"**. A liveness probe cannot answer that, and
 * neither can a log that only records successes - a scan that found nothing and
 * a scan whose every finding was suppressed produce identical silence, and only
 * one of them is working as intended.
 *
 * Read-only. A notification is a record of something that already happened, and
 * there is nothing a client could legitimately change about it.
 */

import type { Hono } from 'hono';
import type { DigestEntry, DigestReason, DigestResponse, ObservationSeverity } from '@traders/shared';

import {
  listLastDigestEntries,
  listNotifications,
  listPendingDigestEntries,
  type DigestEntryRow,
} from '../../db/queries.js';
import { currentUserId, type AppEnv } from '../app.js';

/** A ceiling on one page, matching the observations feed and the run history. */
const MAX_NOTIFICATIONS = 200;

export function registerNotificationsRoutes(app: Hono<AppEnv>): void {
  app.get('/notifications', async (context) => {
    const requested = Number(context.req.query('limit') ?? '50');
    const limit =
      Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_NOTIFICATIONS) : 50;

    const rows = await listNotifications(currentUserId(context), limit);
    return context.json({
      notifications: rows.map((row) => ({
        id: row.id,
        channel: row.channel,
        refKind: row.ref_kind,
        refId: row.ref_id,
        route: row.route,
        // The pair a reader actually needs: `status` says what became of it,
        // `reason` says why it was routed that way. "suppressed because it was
        // below your threshold" and "failed because the channel was down" are
        // the two answers, and they must not be confusable.
        reason: row.reason,
        status: row.status,
        sentAt: row.sent_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
      })),
    });
  });
}

function digestEntry(row: DigestEntryRow): DigestEntry {
  return {
    observationId: row.observation_id,
    headline: row.headline,
    localized: row.localized ?? {},
    severity: row.severity as ObservationSeverity | null,
    subjectRef: row.subject_ref,
    reason: row.reason as DigestReason,
    createdAt: row.created_at.toISOString(),
  };
}

export function registerDigestRoute(app: Hono<AppEnv>): void {
  /**
   * The digest, for the dashboard: the entries waiting for the next one, and
   * the last one delivered. A digest is a batch of notification rows, never a
   * stored message, so this reads the rows (see `listLastDigestEntries`).
   */
  app.get('/notifications/digest', async (context) => {
    const userId = currentUserId(context);
    const [pending, last] = await Promise.all([
      listPendingDigestEntries(userId),
      listLastDigestEntries(userId),
    ]);
    const sentAt = last.reduce<Date | null>(
      (latest, row) => (row.sent_at && (!latest || row.sent_at > latest) ? row.sent_at : latest),
      null,
    );
    const body: DigestResponse = {
      next: { entries: pending.map(digestEntry) },
      last: sentAt === null ? null : { sentAt: sentAt.toISOString(), entries: last.map(digestEntry) },
    };
    return context.json(body);
  });
}

export { MAX_NOTIFICATIONS };
