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
import { z } from 'zod';
import type { DigestEntry, DigestReason, DigestResponse, ObservationSeverity } from '@traders/shared';

import {
  getDigestSeenAt,
  listLastDigestEntries,
  listNotifications,
  listPendingDigestEntries,
  markDigestSeen,
  type DigestEntryRow,
} from '../../db/queries.js';
import { currentUserId, type AppEnv } from '../app.js';
import { badRequest } from '../errors.js';

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

const seenSchema = z.object({ sentAt: z.string().datetime({ offset: true }) });

export function registerDigestRoute(app: Hono<AppEnv>): void {
  /**
   * The digest, for the Insights page: the entries waiting for the next one, and
   * the last one delivered. A digest is a batch of notification rows, never a
   * stored message, so this reads the rows (see `listLastDigestEntries`).
   */
  app.get('/notifications/digest', async (context) => {
    const userId = currentUserId(context);
    const [pending, last, seenAt] = await Promise.all([
      listPendingDigestEntries(userId),
      listLastDigestEntries(userId),
      getDigestSeenAt(userId),
    ]);
    const sentAt = last.reduce<Date | null>(
      (latest, row) => (row.sent_at && (!latest || row.sent_at > latest) ? row.sent_at : latest),
      null,
    );
    const body: DigestResponse = {
      next: { entries: pending.map(digestEntry) },
      last:
        sentAt === null
          ? null
          : {
              sentAt: sentAt.toISOString(),
              entries: last.map(digestEntry),
              // Compared as Dates, both at the driver's millisecond precision:
              // `sent_at` carries microseconds, and the time a client echoes
              // back from `sentAt` does not.
              seen: seenAt !== null && seenAt.getTime() >= sentAt.getTime(),
            },
    };
    return context.json(body);
  });

  /**
   * The user has seen the digest sent at `sentAt` - opened it, or dismissed the
   * dashboard's banner (UX4). Stored per user on the server, so the banner does
   * not return on another device. The client names the digest it showed; the
   * query never moves "seen" backwards, nor past the latest digest sent.
   */
  app.post('/notifications/digest/seen', async (context) => {
    const parsed = seenSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      throw badRequest('invalid_body', 'expected { sentAt } as an ISO 8601 time', parsed.error.issues);
    }
    const seenAt = await markDigestSeen(currentUserId(context), new Date(parsed.data.sentAt));
    return context.json({ seenAt: seenAt?.toISOString() ?? null });
  });
}

export { MAX_NOTIFICATIONS };
