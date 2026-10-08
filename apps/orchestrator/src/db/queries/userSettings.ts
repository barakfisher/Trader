import { queryOne } from '../pool.js';

export interface UserSettingsRow {
  proposal_severity: string;
  proposal_ttl_hours: number;
  notify_severity: string;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  muted_until: Date | null;
  language: string;
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
  /** The interface language; migration 0034's CHECK is the authority on which. */
  language: string;
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
               muted_until, language`;

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
                                quiet_hours_start, quiet_hours_end, muted_until, language, updated_at)
     VALUES ($1, $2, $3, $4, $5::time, $6::time, $7::timestamptz, $8, now())
     ON CONFLICT (user_id) DO UPDATE
        SET proposal_severity  = EXCLUDED.proposal_severity,
            proposal_ttl_hours = EXCLUDED.proposal_ttl_hours,
            notify_severity    = EXCLUDED.notify_severity,
            quiet_hours_start  = EXCLUDED.quiet_hours_start,
            quiet_hours_end    = EXCLUDED.quiet_hours_end,
            muted_until        = EXCLUDED.muted_until,
            language           = EXCLUDED.language,
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
      input.language,
    ],
  );
  if (row === null) throw new Error(`user_settings could not be written for ${userId}`);
  return row;
}

/**
 * The send time of the last digest the user opened or dismissed (migration
 * 0046), or null if none. Read without materialising a settings row: no row
 * means nothing was seen, which is what null says.
 */
export async function getDigestSeenAt(userId: string): Promise<Date | null> {
  const row = await queryOne<{ digest_seen_at: Date | null }>(
    'SELECT digest_seen_at FROM user_settings WHERE user_id = $1',
    [userId],
  );
  return row?.digest_seen_at ?? null;
}

/**
 * Record that the user has seen the digest sent at `sentAt`, and return what is
 * now recorded.
 *
 * Only forward (`GREATEST`): a stale tab dismissing yesterday's banner must not
 * bring today's back. And never past a digest that exists (`LEAST` with the
 * latest one sent): a claim to have seen a digest from the future would hide
 * every banner until then - the client names what it showed, the server keeps
 * the claim honest. With no digest sent there is nothing to have seen, so
 * nothing is recorded (`LEAST` alone would ignore the NULL and keep the claim).
 */
export async function markDigestSeen(userId: string, sentAt: Date): Promise<Date | null> {
  const row = await queryOne<{ digest_seen_at: Date | null }>(
    `-- agent-blind: one digest for every agent (§7.2).
     INSERT INTO user_settings (user_id, digest_seen_at)
     SELECT $1::uuid, CASE WHEN max(sent_at) IS NULL THEN NULL ELSE LEAST($2::timestamptz, max(sent_at)) END
       FROM notifications
      WHERE user_id = $1 AND channel = 'digest' AND status = 'sent'
     ON CONFLICT (user_id) DO UPDATE
        SET digest_seen_at = GREATEST(user_settings.digest_seen_at, EXCLUDED.digest_seen_at)
     RETURNING digest_seen_at`,
    [userId, sentAt.toISOString()],
  );
  return row?.digest_seen_at ?? null;
}
