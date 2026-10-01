import { queryOne } from '../pool.js';

export interface UserSettingsRow {
  proposal_severity: string;
  proposal_ttl_hours: number;
  notify_severity: string;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  muted_until: Date | null;
}

export interface UserSettingsInput {
  proposalSeverity: string;
  proposalTtlHours: number;
  notifySeverity: string;
  /** `HH:MM`, or null together with its pair. */
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  /** ISO 8601 UTC, or null to clear the mute. */
  mutedUntil: string | null;
}

/**
 * The projection both settings statements return, named once so a read and a
 * write cannot drift into disagreeing about the shape they hand back.
 *
 * The two `time` columns are rendered as `HH:MM` here rather than in the route.
 * A `time` reaches the driver as a string in whatever form Postgres chose, and
 * formatting it at the only place that knows it is a `time` keeps the wire
 * format out of reach of a later caller who would guess at it.
 */
const USER_SETTINGS_COLUMNS = `proposal_severity, proposal_ttl_hours, notify_severity,
               to_char(quiet_hours_start, 'HH24:MI') AS quiet_hours_start,
               to_char(quiet_hours_end, 'HH24:MI') AS quiet_hours_end,
               muted_until`;

/**
 * A user's settings, materialising the defaults if they have never saved any.
 *
 * The INSERT is what keeps "no row" from being a case every caller has to
 * handle: the defaults live in the schema (migration 0006), which is the only
 * place they can be stated once for both services. `DO UPDATE` rather than
 * `DO NOTHING` so the statement always returns the row - `DO NOTHING` returns
 * nothing on conflict, which would need a second SELECT for the common path.
 */
export async function getOrCreateUserSettings(userId: string): Promise<UserSettingsRow> {
  const row = await queryOne<UserSettingsRow>(
    `INSERT INTO user_settings (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
     RETURNING ${USER_SETTINGS_COLUMNS}`,
    [userId],
  );
  // The INSERT ... RETURNING always yields a row; the null branch exists only to
  // satisfy the type, and would mean the user was deleted mid-request.
  if (row === null) throw new Error(`user_settings could not be materialised for ${userId}`);
  return row;
}

/**
 * Write the whole settings object, creating the row on a first save.
 *
 * Every column is assigned on both paths, including any the user left where it
 * was. That is what makes this a replace rather than a patch: a column left out
 * of the UPDATE would silently keep a value the user has just chosen to drop,
 * and the expensive instance of that is a cleared mute that stays muted - the
 * user hears nothing and has been told they will.
 *
 * The row is returned rather than the input echoed back, so what the caller
 * renders is what the database holds: a `time` the client sent as `07:00` comes
 * back as the database's own reading of it, and the quiet-hours pair CHECK has
 * already had its say by then.
 */
export async function replaceUserSettings(
  userId: string,
  input: UserSettingsInput,
): Promise<UserSettingsRow> {
  const row = await queryOne<UserSettingsRow>(
    `INSERT INTO user_settings (user_id, proposal_severity, proposal_ttl_hours, notify_severity,
                                quiet_hours_start, quiet_hours_end, muted_until, updated_at)
     VALUES ($1, $2, $3, $4, $5::time, $6::time, $7::timestamptz, now())
     ON CONFLICT (user_id) DO UPDATE
        SET proposal_severity  = EXCLUDED.proposal_severity,
            proposal_ttl_hours = EXCLUDED.proposal_ttl_hours,
            notify_severity    = EXCLUDED.notify_severity,
            quiet_hours_start  = EXCLUDED.quiet_hours_start,
            quiet_hours_end    = EXCLUDED.quiet_hours_end,
            muted_until        = EXCLUDED.muted_until,
            updated_at         = now()
     RETURNING ${USER_SETTINGS_COLUMNS}`,
    [
      userId,
      input.proposalSeverity,
      input.proposalTtlHours,
      input.notifySeverity,
      input.quietHoursStart,
      input.quietHoursEnd,
      input.mutedUntil,
    ],
  );
  if (row === null) throw new Error(`user_settings could not be written for ${userId}`);
  return row;
}
