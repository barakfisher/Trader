/**
 * Tell the user, once, that a model they chose is no longer offered and a
 * fallback is in use (D283, D285).
 *
 * The AI service records the first call that fell back in `model_fallbacks`,
 * once per user, scope, agent and saved model. This announces each new row
 * through `fanOut`, so quiet hours, a mute and the notification ledger's dedupe
 * key apply exactly as they do to a finding; a notice held for quiet hours
 * reaches the digest as its own line, never as a finding.
 *
 * Called after the work that can fall back - an agent's scan, an Ask turn, a
 * scan that narrated - rather than on a timer: a timer would be a new run kind,
 * a CronJob in the cluster and a CHECK to widen, for a message that can only
 * follow one of those calls anyway. Never throws: it reports on work that has
 * already been done.
 */

import {
  getOrCreateUserSettings,
  getUser,
  listUnannouncedModelFallbacks,
  markModelFallbackAnnounced,
  type ModelFallbackRow,
} from '../db/queries.js';
import { logger } from '../logger.js';
import type { Notifier } from '../notify/notifier.js';
import { messagesFor } from '../notify/messages.js';
import { UI_LANGUAGES, type LocalizedTexts } from '@traders/shared';
import { fanOut, settingsForNotification } from './notifications.js';

/** Pushes past the default `high` floor: the user's model changed under them (D283). */
export const MODEL_FALLBACK_SEVERITY = 'high';

/** The notice for one fallback, in `language`. */
export function fallbackNotice(row: ModelFallbackRow, language: string): { headline: string; explanation: string } {
  const messages = messagesFor(language);
  const where =
    row.scope === 'agent' ? messages.modelFallback.where.agent(row.agent_name) : messages.modelFallback.where[row.scope];
  return messages.modelFallback.notice(where, row.saved_model, row.effective_model);
}

function localizedNotice(row: ModelFallbackRow): LocalizedTexts {
  const localized: LocalizedTexts = {};
  for (const language of UI_LANGUAGES) {
    if (language !== 'en') localized[language] = fallbackNotice(row, language);
  }
  return localized;
}

/** Announce the user's unannounced fallbacks; how many were handed to the ledger. */
export async function announceModelFallbacks(userId: string, notifier: Notifier, now: Date = new Date()): Promise<number> {
  try {
    const rows = await listUnannouncedModelFallbacks(userId);
    if (rows.length === 0) return 0;
    const [settings, user] = await Promise.all([getOrCreateUserSettings(userId), getUser(userId)]);
    if (user === null) return 0;
    const policy = settingsForNotification(settings, user.timezone);
    for (const row of rows) {
      await fanOut(
        userId,
        row.agent_id,
        [
          {
            refKind: 'model_fallback',
            refId: row.id,
            severity: MODEL_FALLBACK_SEVERITY,
            ...fallbackNotice(row, 'en'),
            localized: localizedNotice(row),
          },
        ],
        policy,
        notifier,
        now,
      );
      // Claimed in the ledger by now, sent or deferred: never announced again.
      await markModelFallbackAnnounced(userId, row.id);
    }
    logger().info({ userId, fallbacks: rows.length }, 'model_fallback.announced');
    return rows.length;
  } catch (error) {
    logger().warn({ userId, err: error }, 'model_fallback.announce_failed');
    return 0;
  }
}
