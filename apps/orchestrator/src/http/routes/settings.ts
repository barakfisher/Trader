/**
 * Per-user settings: what reaches this user, and when.
 *
 * These are the user's knobs, not the operator's. The analysis thresholds stay
 * in the AI service's configuration because they describe how the engine reads
 * a market; what crosses from a finding into a question, and what is allowed to
 * interrupt someone's evening, is a statement about one person's attention and
 * has to be theirs to make. Migration 0006 argues the split at length.
 *
 * `PUT` replaces the whole object, like `PUT /targets`. A patch would let one
 * request set `quietHoursStart` and leave `quietHoursEnd` behind, and a half-set
 * window is exactly what the database refuses - so a patch API would spend its
 * life explaining a constraint violation that a whole-object write cannot cause.
 *
 * The database CHECKs are restated here rather than left to fire. A constraint
 * violation reaches the client as a 500 with a Postgres string in it, which
 * tells the user nothing they can act on; restating the rule turns each one into
 * a named error with the offending value attached. The duplication is deliberate
 * and bounded: the database remains the authority, because it is the only place
 * that can refuse a bad write from every writer at once.
 */

import type { Hono } from 'hono';
import { z } from 'zod';

import type { ObservationSeverity, UserSettings } from '@traders/shared';

import {
  getOrCreateUserSettings,
  replaceUserSettings,
  type UserSettingsRow,
} from '../../db/queries.js';
import { currentUserId, type AppEnv } from '../app.js';
import { badRequest, unprocessable } from '../errors.js';

/**
 * The severity ladder, ascending, mirroring the CHECK on both severity columns
 * in migration 0006. A runtime list rather than the `ObservationSeverity` type
 * alone, because zod has to reject an unknown level before the database does.
 */
const SEVERITY_LEVELS = ['info', 'notable', 'high'] as const;

/**
 * The proposal TTL bounds, restating `proposal_ttl_hours BETWEEN 1 AND 168`.
 * One hour is the shortest window in which a person can plausibly answer; a week
 * is the point past which the prices a proposal was raised against no longer
 * describe the same decision, which is the reason proposals expire at all.
 */
const MIN_PROPOSAL_TTL_HOURS = 1;
const MAX_PROPOSAL_TTL_HOURS = 168;

/**
 * A 24-hour wall clock, which is what a `time` column accepts. Seconds are not
 * offered: quiet hours are a human boundary, and a window that ends at 07:00:30
 * claims a precision nobody chose.
 */
const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const timeOfDay = z
  .string()
  .regex(TIME_OF_DAY_PATTERN, 'a quiet-hours boundary must be a 24-hour HH:MM time')
  .nullable();

const putSchema = z.object({
  proposalSeverity: z.enum(SEVERITY_LEVELS),
  // An integer, not a duration string: hours are what the column stores, and a
  // fractional hour would be rounded by the database rather than by the user.
  proposalTtlHours: z.number().int(),
  notifySeverity: z.enum(SEVERITY_LEVELS),
  quietHoursStart: timeOfDay,
  quietHoursEnd: timeOfDay,
  // ISO 8601 UTC with an offset, like every other timestamp on this wire. Null
  // clears the mute, which is the only way to end one early.
  mutedUntil: z.string().datetime({ offset: true }).nullable(),
});

/**
 * The stored row as the client sees it.
 *
 * The severities are cast rather than re-validated: the column's CHECK is the
 * guarantee, and a defensive re-parse here would only be able to report that the
 * database contains something the database says it cannot contain.
 */
function toWire(row: UserSettingsRow): UserSettings {
  return {
    proposalSeverity: row.proposal_severity as ObservationSeverity,
    proposalTtlHours: row.proposal_ttl_hours,
    notifySeverity: row.notify_severity as ObservationSeverity,
    quietHoursStart: row.quiet_hours_start,
    quietHoursEnd: row.quiet_hours_end,
    mutedUntil: row.muted_until?.toISOString() ?? null,
  };
}

export function registerSettingsRoutes(app: Hono<AppEnv>): void {
  app.get('/settings', async (context) => {
    // Materialising on read means a user who has never opened this page is not a
    // special case anywhere else: every reader sees a row, and the defaults it
    // holds are the schema's, stated once for both services.
    const row = await getOrCreateUserSettings(currentUserId(context));
    return context.json({ settings: toWire(row) });
  });

  app.put('/settings', async (context) => {
    const parsed = putSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      throw badRequest('invalid_body', 'settings payload failed validation', parsed.error.issues);
    }
    const settings = parsed.data;

    if (
      settings.proposalTtlHours < MIN_PROPOSAL_TTL_HOURS ||
      settings.proposalTtlHours > MAX_PROPOSAL_TTL_HOURS
    ) {
      throw unprocessable(
        'proposal_ttl_out_of_range',
        `a proposal must stay answerable for between ${MIN_PROPOSAL_TTL_HOURS} and ${MAX_PROPOSAL_TTL_HOURS} hours`,
        { min: MIN_PROPOSAL_TTL_HOURS, max: MAX_PROPOSAL_TTL_HOURS, given: settings.proposalTtlHours },
      );
    }

    /**
     * The pair rule, restating `user_settings_quiet_hours_are_a_pair`. A window
     * with one end set is not a narrower window, it is an unanswerable question:
     * nothing can decide when it stops. Saying so here means the user is told
     * which end they left empty instead of being handed a constraint name.
     */
    if ((settings.quietHoursStart === null) !== (settings.quietHoursEnd === null)) {
      throw unprocessable(
        'quiet_hours_must_be_a_pair',
        'quiet hours need both a start and an end, or neither',
        { quietHoursStart: settings.quietHoursStart, quietHoursEnd: settings.quietHoursEnd },
      );
    }

    /**
     * A window whose two ends are the same minute has no reading either: it is
     * zero long or a whole day, and nothing in the schema or in the sweep that
     * will read it decides which. Migration 0006 could have refused it and did
     * not; a settled migration is not worth reopening for a case no writer
     * produces on purpose, so it is refused at the only writer there is - and
     * written down here, because the next reader of the column would otherwise
     * have to pick an answer.
     */
    if (settings.quietHoursStart !== null && settings.quietHoursStart === settings.quietHoursEnd) {
      throw unprocessable(
        'quiet_hours_window_is_empty',
        'quiet hours must start and end at different times',
        { quietHoursStart: settings.quietHoursStart },
      );
    }

    /**
     * A mute that has already ended is not a mute, and storing one would leave
     * the page showing a silence that is not in force. The database has no CHECK
     * for this - it cannot, since `now()` moves - so it is refused here, in the
     * same spirit as the snooze-in-the-past refusal in the state machine. An
     * equal timestamp is in the past by the time it is stored, hence `<=`.
     */
    if (settings.mutedUntil !== null && new Date(settings.mutedUntil) <= new Date()) {
      throw unprocessable('muted_until_in_the_past', 'a mute must end in the future', {
        mutedUntil: settings.mutedUntil,
      });
    }

    const stored = await replaceUserSettings(currentUserId(context), settings);
    // The stored row, not the request echoed back: the client re-renders from
    // what was written, so a value the database normalised is never displayed in
    // the form the user happened to type it in.
    return context.json({ settings: toWire(stored) });
  });
}

export { MAX_PROPOSAL_TTL_HOURS, MIN_PROPOSAL_TTL_HOURS, SEVERITY_LEVELS };
