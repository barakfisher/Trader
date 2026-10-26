"""Email is verified; single-use links; the signup modes (D243, D258-D260, D303-D307).

- **`users.email_verified_at`**: when the address was proven by a link. Every
  account the admin let in before this - `active` or `disabled` - is marked
  verified now (D259); a `pending` or `rejected` request is not.
- **`users.pending_email`**: an address change waiting for its link (D259).
  The old address stays the sign-in address, and reset mail goes to it, until
  the new one is confirmed.
- **`users.approved_automatically`**: let in by *automatic* mode rather than by
  the admin, so the daily limit counts only those (D305).
- **`auth_tokens`** (D260): a link's SHA-256, never the link; its purpose, the
  address it was sent to, its expiry and when it was used. `reset_password` is
  PR 11's and enumerated now so that table and CHECK are written once.
- **`installation_settings.signup_mode`** (D243): `automatic`, `approval` or
  `closed`. An installation whose waiting-request limit is 0 - closed, as
  `max_pending_signups = 0` meant until now - becomes `closed`; any other
  `approval`, as it ran. **`daily_new_accounts_limit`** bounds *automatic*
  (D305); beyond it a verified sign-up waits for the admin.
- **`auth_sweep`, a run kind**, takes over from 0071's `session_sweep`: one
  daily run removes expired sessions, expired tokens and unverified sign-ups
  past their window. `session_sweep` stays accepted - run kinds are only ever
  appended (`test_run_kinds_contract.py`), so its past runs stay true - and
  nothing sends it any more.

Revision ID: 0074_email_verification
Revises: 0073_run_notifications
"""

from alembic import op

revision = "0074_email_verification"
down_revision = "0073_run_notifications"
branch_labels = None
depends_on = None

#: The run kinds before this migration (last changed by 0071).
PREVIOUS_KINDS = (
    "snapshot",
    "portfolio_scan",
    "topic_scan",
    "daily_digest",
    "backfill",
    "proposal_sweep",
    "instrument_metadata",
    "news_collect",
    "topic_discovery",
    "universe_rescreen",
    "agent_scans",
    "agent_scan",
    "research",
    "session_sweep",
)
KINDS = (*PREVIOUS_KINDS, "auth_sweep")

#: `apps/orchestrator/src/db/queries/authTokens.ts` `AuthTokenPurpose`.
TOKEN_PURPOSES = ("verify_email", "verify_new_email", "reset_password")
#: `packages/shared` `SIGNUP_MODES`.
SIGNUP_MODES = ("automatic", "approval", "closed")
#: `packages/shared` `DAILY_NEW_ACCOUNTS_CEILING` and the default (D305).
DAILY_NEW_ACCOUNTS_CEILING = 500
DAILY_NEW_ACCOUNTS_DEFAULT = 20


def _sql_list(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def _kinds(values: tuple[str, ...]) -> None:
    op.execute("ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_kind_check")
    op.execute(
        f"ALTER TABLE runs ADD CONSTRAINT runs_kind_check CHECK (kind IN ({_sql_list(values)}))"
    )


def upgrade() -> None:
    _kinds(KINDS)

    op.execute(
        """
        ALTER TABLE users
            ADD COLUMN email_verified_at timestamptz,
            ADD COLUMN pending_email text CHECK (char_length(pending_email) <= 320),
            ADD COLUMN approved_automatically boolean NOT NULL DEFAULT false
        """
    )
    op.execute(
        "UPDATE users SET email_verified_at = now() "
        "WHERE status IN ('active', 'disabled') AND email IS NOT NULL"
    )

    op.execute(
        f"""
        CREATE TABLE auth_tokens (
            id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            purpose     text NOT NULL CHECK (purpose IN ({_sql_list(TOKEN_PURPOSES)})),
            -- SHA-256 of the link's secret; the link itself is never stored (D260).
            token_hash  bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
            -- The address the link was sent to: a link for an address the
            -- account no longer has (or no longer waits for) proves nothing.
            email       text NOT NULL CHECK (char_length(email) <= 320),
            created_at  timestamptz NOT NULL DEFAULT now(),
            expires_at  timestamptz NOT NULL,
            used_at     timestamptz,
            CONSTRAINT auth_tokens_expires_after_created CHECK (expires_at > created_at)
        )
        """
    )
    op.execute("CREATE INDEX auth_tokens_user_purpose ON auth_tokens (user_id, purpose)")
    op.execute("CREATE INDEX auth_tokens_expires ON auth_tokens (expires_at)")

    op.execute(
        f"""
        ALTER TABLE installation_settings
            ADD COLUMN signup_mode text NOT NULL DEFAULT 'approval'
                CHECK (signup_mode IN ({_sql_list(SIGNUP_MODES)})),
            ADD COLUMN daily_new_accounts_limit integer NOT NULL
                DEFAULT {DAILY_NEW_ACCOUNTS_DEFAULT}
                CHECK (daily_new_accounts_limit BETWEEN 0 AND {DAILY_NEW_ACCOUNTS_CEILING})
        """
    )
    op.execute(
        "UPDATE installation_settings SET signup_mode = 'closed' WHERE max_pending_signups = 0"
    )


def downgrade() -> None:
    # 0071 closes signup with a zero waiting-request limit: keep a closed
    # installation closed rather than reopening it by dropping the column.
    op.execute(
        "UPDATE installation_settings SET max_pending_signups = 0 WHERE signup_mode = 'closed'"
    )
    op.execute(
        "ALTER TABLE installation_settings "
        "DROP COLUMN daily_new_accounts_limit, DROP COLUMN signup_mode"
    )
    op.execute("DROP TABLE auth_tokens")
    op.execute(
        "ALTER TABLE users DROP COLUMN approved_automatically, DROP COLUMN pending_email, "
        "DROP COLUMN email_verified_at"
    )
    op.execute("DELETE FROM runs WHERE kind = 'auth_sweep'")
    _kinds(PREVIOUS_KINDS)
