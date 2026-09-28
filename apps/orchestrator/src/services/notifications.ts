/**
 * Notification fan-out: taking what a scan found and deciding who hears about
 * it, on which channel, and when.
 *
 * The policy is in `notificationPolicy.ts`, the channels are behind `Notifier`,
 * and the SQL is in `db/queries.ts`. This module is the seam, and it owns one
 * thing the other three cannot: the **order of operations** around a message
 * that cannot be recalled.
 *
 * That order is claim, send, settle:
 *
 *   1. `claimNotification` inserts the row. Unique `dedupe_key`, so the insert
 *      either wins or tells us somebody already has it.
 *   2. The channel sends.
 *   3. `settleNotification` records what happened.
 *
 * Sending first and recording afterwards is the obvious alternative and it is
 * wrong: a crash between the two loses the record of a message the user has
 * already read, and the retry sends it a second time. Claiming first fails in
 * the other direction - a crash leaves a `pending` row for a message that never
 * went out, which the digest will pick up. A missing alert is recoverable and a
 * duplicated one is not, so the window belongs on that side.
 *
 * Nothing here decides *whether* a finding is worth telling anybody. That is
 * `routeFinding`, and it runs before the claim so that a suppressed
 * notification is recorded with its reason rather than leaving no trace - see
 * migration 0007 for why "we chose not to tell you" and "we failed to tell you"
 * must not look the same afterwards.
 */

import {
  claimNotification,
  getOrCreateUserSettings,
  listPendingDigest,
  settleNotification,
  type NotificationToRecord,
  type UserRow,
} from '../db/queries.js';
import { logger } from '../logger.js';
import { gatherTopicDigest, renderTopicSection } from './topicDigest.js';
import type { Notifier, OutboundNotification } from '../notify/notifier.js';
import {
  notificationDedupeKey,
  routeFinding,
  type NotificationSettings,
  type NotificationRoute,
} from './notificationPolicy.js';

/** A finding worth considering for delivery. */
export interface NotifiableFinding {
  /** 'observation' or 'proposal' - what `ref_id` points at. */
  refKind: 'observation' | 'proposal';
  refId: string;
  severity: string;
  headline: string;
  explanation: string | null;
  /** Set when the user can act on this, so a channel can offer buttons. */
  proposalId?: string;
}

export interface FanOutResult {
  /** Sent now, on a real channel. */
  pushed: number;
  /** Deferred into the digest: quiet hours, a mute, or below the floor. */
  deferred: number;
  /** Already claimed by an earlier run. Expected to be non-zero on a re-scan. */
  duplicate: number;
  /** Claimed and attempted, but the channel could not deliver. */
  failed: number;
  /** Why each deferral happened, for the run stats. */
  reasons: Record<string, number>;
}

/** The channel a route is delivered on. `feed_only` reaches no channel at all. */
function channelFor(route: NotificationRoute, notifier: Notifier): string | null {
  if (route === 'push') return notifier.channel;
  if (route === 'digest') return 'digest';
  return null;
}

function toOutbound(finding: NotifiableFinding, userId: string): OutboundNotification {
  return {
    userId,
    title: finding.headline,
    // The explanation is already evidence-validated prose from the scan; a
    // channel never composes its own, because a figure that did not come
    // through the validator is a figure nobody checked.
    body: finding.explanation ?? '',
    proposalId: finding.proposalId,
    severity: finding.severity,
  };
}

/**
 * Route, claim and deliver a batch of findings.
 *
 * Failures are per-finding: one channel error must not abandon the rest of the
 * batch, because the alternative is that a single unreachable message silences
 * every finding behind it in the list.
 */
export async function fanOut(
  userId: string,
  findings: NotifiableFinding[],
  settings: NotificationSettings,
  notifier: Notifier,
  now: Date = new Date(),
): Promise<FanOutResult> {
  const result: FanOutResult = {
    pushed: 0,
    deferred: 0,
    duplicate: 0,
    failed: 0,
    reasons: {},
  };

  for (const finding of findings) {
    const decision = routeFinding(finding.severity, settings, now);
    const channel = channelFor(decision.route, notifier);
    if (channel === null) continue;

    const record: NotificationToRecord = {
      userId,
      channel,
      refKind: finding.refKind,
      refId: finding.refId,
      route: decision.route,
      reason: decision.reason,
      // A digest entry is claimed now and delivered later, so it stays
      // 'pending' until the digest run collects it. A push is settled below.
      status: 'pending',
      dedupeKey: notificationDedupeKey(channel, finding.refKind, finding.refId),
    };

    const claim = await claimNotification(record);
    if (claim === null) {
      // Somebody already holds this key. Not an error and not worth a log line
      // per finding: on a re-scan this is the common case.
      result.duplicate += 1;
      continue;
    }

    result.reasons[decision.reason] = (result.reasons[decision.reason] ?? 0) + 1;

    if (decision.route === 'digest') {
      result.deferred += 1;
      continue;
    }

    try {
      const delivery = await notifier.send(toOutbound(finding, userId));
      if (delivery.delivered) {
        await settleNotification(claim.id, 'sent');
        result.pushed += 1;
      } else {
        // The error is stored on the row, not only logged: the question "why
        // did this not arrive?" is usually asked long after a log retention
        // window has closed.
        await settleNotification(claim.id, 'failed', delivery.error);
        result.failed += 1;
      }
    } catch (error) {
      // A channel that throws is a channel that failed; it must not take the
      // rest of the batch with it.
      await settleNotification(claim.id, 'failed', (error as Error).message);
      result.failed += 1;
      logger().warn(
        { userId, refId: finding.refId, channel, err: error },
        'notification.channel_threw',
      );
    }
  }

  logger().info({ userId, ...result }, 'notification.fan_out');
  return result;
}

/**
 * Turn the settings row into what the policy needs.
 *
 * The timezone comes from `users`, not from `user_settings`: it is the identity
 * of a user's day and is read by everything that resolves "today", so quiet
 * hours borrow it rather than storing a second copy that could drift.
 */
export function settingsForNotification(
  settings: {
    notify_severity: string;
    quiet_hours_start: string | null;
    quiet_hours_end: string | null;
    muted_until: Date | null;
  },
  timezone: string,
): NotificationSettings {
  return {
    notifySeverity: settings.notify_severity,
    quietHoursStart: settings.quiet_hours_start,
    quietHoursEnd: settings.quiet_hours_end,
    mutedUntil: settings.muted_until,
    timezone,
  };
}


export interface DigestResult {
  /** Findings rolled into this digest. Zero is a quiet day, not a failure. */
  entries: number;
  /** Topics in the digest's topic section; zero when no topic had anything to report. */
  topics: number;
  delivered: boolean;
  error?: string;
}

/**
 * Deliver everything that was deferred, as one message.
 *
 * Batching is the point. Ten separate alerts held back overnight and then
 * released at 07:00 are ten interruptions the quiet hours did nothing to
 * prevent - they were only postponed into a pile. One message with ten lines is
 * what the user was actually promised.
 *
 * The digest is settled **all-or-nothing**: either every entry it covered is
 * marked sent, or none is. Marking them individually as they are rendered would
 * mean a channel failure halfway through left some findings marked delivered
 * inside a message that never arrived - and, unlike a missing row, that is not
 * recoverable, because the next digest would skip exactly the entries nobody
 * ever saw.
 */
/**
 * `now` decides which day "today" is for the topic section. Injectable so a test
 * pins it: the first version read the clock here, and its test passed until the
 * calendar moved past the date its rows were written for.
 */
export async function sendDigest(
  user: UserRow,
  notifier: Notifier,
  now: Date = new Date(),
): Promise<DigestResult> {
  const pending = await listPendingDigest(user.id);
  // The topic section is gathered even when nothing was deferred: a topic that
  // moved today is worth a digest on its own (FR-13), and a quiet day with no
  // topic news still sends nothing - see topicDigest.ts.
  const topicEntries = await gatherTopicDigest(user, now);
  const topicSection = renderTopicSection(topicEntries);
  const topics = topicSection === null ? 0 : topicEntries.length;
  if (pending.length === 0 && topicSection === null) {
    return { entries: 0, topics: 0, delivered: false };
  }

  // Read but not enforced here: quiet hours gate *interruptions*, and the
  // digest is the thing a deferred finding was deferred *into*. Applying the
  // window twice would defer the digest for being a notification, which is the
  // one message that must not be.
  const settings = await getOrCreateUserSettings(user.id);
  const muted =
    settings.muted_until !== null && settings.muted_until.getTime() > Date.now();

  const delivery = muted
    ? { delivered: false, error: 'the user is muted, so the digest was held' }
    : await notifier
        .send({
          userId: user.id,
          title: digestTitle(pending.length, topics),
          // The digest names how many findings and of what kind. It does not
          // restate their figures: those were evidence-validated when the
          // observation was written, and re-rendering them here would be a
          // second place for a number to drift from the evidence behind it.
          // The topic section quotes stored headlines for the same reason.
          body: [pending.length > 0 ? summariseDigest(pending) : null, topicSection]
            .filter((part): part is string => part !== null)
            .join('\n\n'),
          severity: 'info',
        })
        .catch((error: Error) => ({ delivered: false, error: error.message }));

  for (const entry of pending) {
    await settleNotification(
      entry.id,
      delivery.delivered ? 'sent' : 'failed',
      delivery.delivered ? undefined : delivery.error,
    );
  }

  logger().info(
    { userId: user.id, entries: pending.length, topics, delivered: delivery.delivered },
    'notification.digest',
  );
  return {
    entries: pending.length,
    topics,
    delivered: delivery.delivered,
    ...(delivery.error === undefined ? {} : { error: delivery.error }),
  };
}

function digestTitle(entries: number, topics: number): string {
  const parts: string[] = [];
  if (entries > 0) parts.push(`${entries} finding${entries === 1 ? '' : 's'}`);
  if (topics > 0) parts.push(`${topics} topic${topics === 1 ? '' : 's'}`);
  return `Daily digest: ${parts.join(', ')}`;
}

/** One line per reason, so the digest says why each group was held back. */
function summariseDigest(entries: { reason: string }[]): string {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  }
  const labels: Record<string, string> = {
    below_floor: 'below your alert threshold',
    quiet_hours: 'held during quiet hours',
    muted: 'held while muted',
    above_floor: 'not delivered when first found',
  };
  return [...counts.entries()]
    .map(([reason, count]) => `${count} ${labels[reason] ?? reason}`)
    .join('\n');
}
