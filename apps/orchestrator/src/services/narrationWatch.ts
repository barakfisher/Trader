/**
 * Tell the user when explanations stop being written by the model, or start
 * again - once per change, never once per scan.
 *
 * `narrationHealth.ts` answers "what is the state now" for a badge that is
 * recomputed on every read. A notification needs something a badge does not: the
 * previous state. So each scan that narrated anything records the state in
 * `narration_transitions` when it differs from the last row, and only a new row
 * can produce a message. A scan whose findings were all repeats narrated nothing,
 * learned nothing and does nothing - which is most scans.
 *
 * Three choices, each against a failure seen or measured:
 *
 * - **Judged over the last few explanations, not one scan.** A scan usually
 *   narrates one or two new findings, so one refused sentence would read as an
 *   outage. Replayed over this installation's history (2026-09-17..28), a
 *   per-scan rule announced a break fifteen minutes after a recovery, over two
 *   refused sentences. Any model-written sentence among the last
 *   `NARRATION_WINDOW` still means the model works (`narrationStateFrom`'s rule).
 * - **Only the model/template boundary is announced.** A move from `unavailable`
 *   to `rejected` is recorded, but the reader was already told explanations are
 *   templates, and a second message saying so again is noise.
 * - **Breaking interrupts; recovering waits for the digest** (`narrationNotice.ts`).
 *   Both go through `fanOut`, so quiet hours, a mute and the notification ledger
 *   apply exactly as they do to a finding.
 *
 * The very first state recorded is a baseline, announced only when it is a
 * break: an upgrade that finds the model writing is not news, and one that finds
 * it broken is. Until 2026-10-14 no baseline was announced, and an outage that
 * was already under way when the first row was written (OpenRouter refusing
 * narration's reasoning setting, 2026-10-07..14) became the baseline and was
 * never reported - it was found a week later by reading `llm_calls`.
 */

import type { AiClient } from '@traders/shared/ai';

import {
  listRecentNarrationProvenance,
  recordNarrationState,
  type NarrationTransitionRow,
} from '../db/queries.js';
import { logger } from '../logger.js';
import type { Notifier } from '../notify/notifier.js';
import { narrationStateFrom } from './narrationHealth.js';
import { announcementFor, byModel, localizedAnnouncement } from './narrationNotice.js';
import { fanOut } from './notifications.js';
import type { NotificationSettings } from './notificationPolicy.js';

/** How many of the most recent explanations the state is judged over. */
export const NARRATION_WINDOW = 3;

export type NarrationWatchOutcome =
  /** Nothing to judge, or the AI service could not say how narration is configured. */
  | 'not_measured'
  | 'unchanged'
  /** The first state ever recorded for this user, and not a break. */
  | 'baseline'
  /** A change on one side of the boundary, e.g. rate-limited to refused. */
  | 'recorded'
  | 'announced';

/**
 * Whether a recorded transition is worth a message. A baseline is when it is a
 * break: templates for want of a working model, not by configuration (`off`).
 */
export function shouldAnnounce(
  transition: Pick<NarrationTransitionRow, 'from_state' | 'to_state'>,
): boolean {
  if (transition.from_state === null) {
    return !byModel(transition.to_state) && transition.to_state !== 'off';
  }
  return byModel(transition.from_state) !== byModel(transition.to_state);
}

/**
 * Judge, record and, if the model/template boundary was crossed, announce.
 *
 * Call after a scan has stored at least one narrated observation. Never throws:
 * this reports on the scan, and a failure to report must not fail a scan that
 * has already done its work.
 */
export async function watchNarration(
  userId: string,
  agentId: string,
  ai: AiClient,
  notifier: Notifier,
  settings: NotificationSettings,
  runId: string | null,
  requestId?: string,
  now: Date = new Date(),
): Promise<NarrationWatchOutcome> {
  try {
    const rows = await listRecentNarrationProvenance(userId, NARRATION_WINDOW);
    // The tier is what tells `off` from a failure; without it, no reading is
    // better than a wrong one.
    const config = await ai.narrationConfig(requestId).catch(() => null);
    if (config === null) return 'not_measured';

    const { state, lastFallbackReason } = narrationStateFrom(rows, config.tier);
    if (state === 'unknown') return 'not_measured';

    const transition = await recordNarrationState(userId, state, lastFallbackReason, runId);
    if (transition === null) return 'unchanged';
    if (!shouldAnnounce(transition)) {
      return transition.from_state === null ? 'baseline' : 'recorded';
    }

    const notice = announcementFor(transition.to_state);
    await fanOut(
      userId,
      agentId,
      [
        {
          refKind: 'narration',
          refId: transition.id,
          ...notice,
          localized: localizedAnnouncement(transition.to_state),
        },
      ],
      settings,
      notifier,
      now,
    );
    logger().info(
      { userId, from: transition.from_state, to: transition.to_state },
      'narration.transition_announced',
    );
    return 'announced';
  } catch (error) {
    logger().warn({ userId, err: error }, 'narration.watch_failed');
    return 'not_measured';
  }
}
