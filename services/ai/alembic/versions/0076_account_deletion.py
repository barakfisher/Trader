"""A user deletes their own account, with a grace period (D264, D316-D318).

- **`users.status` gains `closed`**: the account asked to be deleted. It is
  its own state, not D239's `disabled` - signing in reopens a `closed`
  account and never a `disabled` one (D264). Everything that runs for a user
  already asks for `active`, so a closed account has no session, no scheduled
  run and no Telegram from the moment it closes.
- **`users.deletion_due_at`**: when the erase may take it. Set exactly when the
  account is `closed` (a CHECK), cleared when signing in reopens it.
- **`users.rejected_at`**: when a sign-up request was turned down, so automatic
  signup can erase it after 90 days (D264). Requests rejected before this
  migration count from now: the shorter retention starts at deploy, never
  earlier than the user was told.
- **The seven foreign keys with no delete rule** (M10-MEASUREMENT §6) are
  settled: `agent_cash`, `agent_scans`, `assistant_conversations`,
  `cash_movements`, `fills` and `proposal_attempts` cascade with the user;
  `admin_audit.admin_user_id` becomes nullable and is cleared, so the audit
  keeps its rows. `account_resets` already cascades.
- **`erase_account(user)`**, owned by the migration role: the app's role cannot
  delete history (fills, movements, scans, attempts), so the erase is a
  function it may call, which refuses anything but a closed account past its
  date or a rejected request. It clears the user's id from `admin_audit`'s
  action and detail, removes the rows a `RESTRICT` key would stop, and deletes
  the user; every other row goes by cascade. Shared market data stays.
- **`account_erase`, a run kind**: the installation's run that calls it.

The downgrade turns a closed account `disabled` - no way in, and nothing the
older schema would erase - rather than reopening it, and refuses while an audit
row has lost its admin (the older column is NOT NULL).

Revision ID: 0076_account_deletion
Revises: 0075_user_identities
"""

from alembic import op

revision = "0076_account_deletion"
down_revision = "0075_user_identities"
branch_labels = None
depends_on = None

APP_ROLE = "traders_app"

#: The run kinds before this migration (last changed by 0074).
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
    "auth_sweep",
)
KINDS = (*PREVIOUS_KINDS, "account_erase")

#: 0058's statuses, and `closed` (`apps/orchestrator` `UserStatus`).
PREVIOUS_STATUSES = ("pending", "active", "rejected", "disabled")
USER_STATUSES = (*PREVIOUS_STATUSES, "closed")

#: The user-owned tables whose key to `users` had no delete rule; they cascade now.
CASCADING = (
    "agent_cash",
    "agent_scans",
    "assistant_conversations",
    "cash_movements",
    "fills",
    "proposal_attempts",
)


def _sql_list(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def _kinds(values: tuple[str, ...]) -> None:
    op.execute("ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_kind_check")
    op.execute(
        f"ALTER TABLE runs ADD CONSTRAINT runs_kind_check CHECK (kind IN ({_sql_list(values)}))"
    )


def _statuses(values: tuple[str, ...]) -> None:
    op.execute("ALTER TABLE users DROP CONSTRAINT users_status_check")
    op.execute(
        f"ALTER TABLE users ADD CONSTRAINT users_status_check "
        f"CHECK (status IN ({_sql_list(values)}))"
    )


def _user_keys(rule: str) -> None:
    for table in CASCADING:
        op.execute(
            f"ALTER TABLE {table} DROP CONSTRAINT {table}_user_id_fkey, "
            f"ADD CONSTRAINT {table}_user_id_fkey FOREIGN KEY (user_id) "
            f"REFERENCES users (id){rule}"
        )


def _audit_key(rule: str) -> None:
    op.execute(
        "ALTER TABLE admin_audit DROP CONSTRAINT admin_audit_admin_user_id_fkey, "
        "ADD CONSTRAINT admin_audit_admin_user_id_fkey FOREIGN KEY (admin_user_id) "
        f"REFERENCES users (id){rule}"
    )


#: 0026's guard, with the one exception the erase needs.
AUDIT_GUARD = """
        CREATE OR REPLACE FUNCTION admin_audit_refuse_change() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            -- Only `erase_account` sets this, inside its own transaction: it
            -- clears an erased user's id from the rows and keeps them.
            IF TG_OP = 'UPDATE' AND current_setting('traders.account_erase', true) = 'on' THEN
                RETURN NEW;
            END IF;
            RAISE EXCEPTION 'admin_audit is append-only: % refused', TG_OP
                USING ERRCODE = 'insufficient_privilege';
        END;
        $$
"""

#: 0026's guard as it was.
AUDIT_GUARD_BEFORE = """
        CREATE OR REPLACE FUNCTION admin_audit_refuse_change() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'admin_audit is append-only: % refused', TG_OP
                USING ERRCODE = 'insufficient_privilege';
        END;
        $$
"""


def upgrade() -> None:
    _kinds(KINDS)
    _statuses(USER_STATUSES)
    op.execute(
        """
        ALTER TABLE users
            ADD COLUMN deletion_due_at timestamptz,
            ADD COLUMN rejected_at timestamptz,
            ADD CONSTRAINT users_closed_has_deletion_date
                CHECK ((status = 'closed') = (deletion_due_at IS NOT NULL))
        """
    )
    op.execute("UPDATE users SET rejected_at = now() WHERE status = 'rejected'")
    op.execute("CREATE INDEX users_deletion_due ON users (deletion_due_at) WHERE status = 'closed'")
    op.execute("CREATE INDEX users_rejected_at ON users (rejected_at) WHERE status = 'rejected'")

    _user_keys(" ON DELETE CASCADE")
    op.execute("ALTER TABLE admin_audit ALTER COLUMN admin_user_id DROP NOT NULL")
    _audit_key(" ON DELETE SET NULL")
    op.execute(AUDIT_GUARD)

    op.execute(
        """
        CREATE FUNCTION erase_account(p_user_id uuid) RETURNS boolean
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
        DECLARE
            v_status text;
            v_due timestamptz;
            v_id text := p_user_id::text;
        BEGIN
            SELECT status, deletion_due_at INTO v_status, v_due
              FROM users WHERE id = p_user_id AND role <> 'admin' FOR UPDATE;
            -- A closed account past its date, or a rejected request: nothing
            -- else, whoever asks. The caller chooses which requests are old.
            -- `coalesce`: no row (the admin, or nobody) leaves both NULL, and
            -- `IF NOT NULL` would go on to erase.
            IF NOT coalesce((v_status = 'closed' AND v_due <= now())
                            OR v_status = 'rejected', false) THEN
                RETURN false;
            END IF;

            PERFORM set_config('traders.account_reset', 'on', true);
            PERFORM set_config('traders.account_erase', 'on', true);

            -- The audit keeps what the admin did, without whom it was done to.
            UPDATE admin_audit
               SET action = replace(action, v_id, 'erased'),
                   detail = replace(detail::text, v_id, 'erased')::jsonb
             WHERE strpos(action, v_id) > 0 OR strpos(detail::text, v_id) > 0;

            -- Keys that RESTRICT stop a cascade midway, whatever its order:
            -- a fill's movement, a proposal's fills and intents go first.
            DELETE FROM cash_movements WHERE user_id = p_user_id;
            DELETE FROM fills WHERE user_id = p_user_id;
            DELETE FROM intents WHERE user_id = p_user_id;
            DELETE FROM users WHERE id = p_user_id;

            PERFORM set_config('traders.account_erase', 'off', true);
            PERFORM set_config('traders.account_reset', 'off', true);
            RETURN true;
        END;
        $$
        """
    )
    op.execute("REVOKE ALL ON FUNCTION erase_account(uuid) FROM PUBLIC")
    op.execute(f"GRANT EXECUTE ON FUNCTION erase_account(uuid) TO {APP_ROLE}")


def downgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM admin_audit WHERE admin_user_id IS NULL) THEN
                RAISE EXCEPTION 'admin_audit holds rows whose admin was erased; '
                    'the older schema requires an admin on every row';
            END IF;
        END
        $$
        """
    )
    op.execute("DROP FUNCTION erase_account(uuid)")
    op.execute(AUDIT_GUARD_BEFORE)
    _audit_key("")
    op.execute("ALTER TABLE admin_audit ALTER COLUMN admin_user_id SET NOT NULL")
    _user_keys("")

    # No way in, and nothing the older code would erase.
    op.execute("ALTER TABLE users DROP CONSTRAINT users_closed_has_deletion_date")
    op.execute("UPDATE users SET status = 'disabled' WHERE status = 'closed'")
    op.execute("DROP INDEX users_rejected_at")
    op.execute("DROP INDEX users_deletion_due")
    op.execute("ALTER TABLE users DROP COLUMN rejected_at, DROP COLUMN deletion_due_at")
    _statuses(PREVIOUS_STATUSES)

    op.execute("DELETE FROM runs WHERE kind = 'account_erase'")
    _kinds(PREVIOUS_KINDS)
