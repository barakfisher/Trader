"""Sessions get a table: signing out ends that session; Settings lists devices (D261, D294-D297).

- **`user_sessions`**: one row per signed-in device. The cookie carries a
  random secret signed with `SESSION_SECRET`; the row keeps only its SHA-256
  (`token_hash`), so a leaked database or backup holds no usable session (as
  D260 does for tokens). `expires_at` is fixed at sign-in (D295): the row is
  never extended. `last_seen_at` is written at most once every few minutes
  (`SESSION_TOUCH_INTERVAL_SECONDS` in the orchestrator).
- The address and user agent are personal data kept for the device list
  (D261) and go with the row: signing out, ending sessions, deleting the user
  (cascade) and the sweep all remove them.
- **`session_sweep`, a run kind**: the installation's run that deletes expired
  rows (D261's "pruned with the installation's runs").

Downgrading drops every session: everyone signs in again, which is all a
session is worth. Nothing else is lost, so the downgrade does not refuse.

Revision ID: 0071_user_sessions
Revises: 0070_holding_research
"""

from alembic import op

revision = "0071_user_sessions"
down_revision = "0070_holding_research"
branch_labels = None
depends_on = None

#: 0070's run kinds.
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
)
KINDS = (*PREVIOUS_KINDS, "session_sweep")

#: The orchestrator cuts a user agent to this before storing it (`USER_AGENT_MAX_LENGTH`).
USER_AGENT_MAX_LENGTH = 512


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
        f"""
        CREATE TABLE user_sessions (
            id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            -- SHA-256 of the cookie's secret; the secret itself is never stored.
            token_hash      bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
            created_at      timestamptz NOT NULL DEFAULT now(),
            last_seen_at    timestamptz NOT NULL DEFAULT now(),
            expires_at      timestamptz NOT NULL,
            user_agent      text CHECK (char_length(user_agent) <= {USER_AGENT_MAX_LENGTH}),
            ip_address      text CHECK (char_length(ip_address) <= 64),
            CONSTRAINT user_sessions_expires_after_created CHECK (expires_at > created_at)
        )
        """
    )
    op.execute("CREATE INDEX user_sessions_user ON user_sessions (user_id, created_at DESC)")
    op.execute("CREATE INDEX user_sessions_expires ON user_sessions (expires_at)")


def downgrade() -> None:
    op.execute("DELETE FROM runs WHERE kind = 'session_sweep'")
    op.execute("DROP TABLE user_sessions")
    _kinds(PREVIOUS_KINDS)
