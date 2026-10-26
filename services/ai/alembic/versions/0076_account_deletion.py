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
  settled by the function, not by cascades: `agent_cash`, `agent_scans`,
  `assistant_conversations`, `cash_movements`, `fills` and `proposal_attempts`
  keep NO ACTION, and `admin_audit.admin_user_id` becomes nullable with no
  rule. A cascade runs with the table owner's rights, so it would let the
  app's role - which may still `DELETE FROM users`, for unverified sign-ups -
  erase the history it was denied (0033, 0040, 0043, 0044) for any user, past
  any date, without asking the function. `account_resets` already cascades.
- **`erase_account(user)`**, owned by the migration role: the app's role cannot
  delete history (fills, movements, scans, attempts), so the erase is a
  function it may call, which refuses anything but a closed account past its
  date or a rejected request. It clears the user's id from `admin_audit`
  (their own admin attribution, and the id in action and detail), deletes the
  rows the seven keys guard in an order their keys accept, then the user;
  every other row goes by cascade. Shared market data stays.
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


#: 0026's guard, with the one exception the erase needs.
AUDIT_GUARD = """
        CREATE OR REPLACE FUNCTION admin_audit_refuse_change() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            -- Only `erase_account` sets this, inside its own transaction: it
            -- clears an erased user's id from the rows and keeps them. Any role
            -- can set the flag; only the owner holds UPDATE here (0033).
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

    op.execute("ALTER TABLE admin_audit ALTER COLUMN admin_user_id DROP NOT NULL")
    op.execute(AUDIT_GUARD)

    op.execute(
        """
        CREATE FUNCTION erase_account(p_user_id uuid) RETURNS boolean
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
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

            -- The audit keeps what was done, without whom it was done to or by
            -- (an admin is never erased; a demoted one may be). Any case of the id.
            UPDATE admin_audit
               SET action = regexp_replace(action, v_id, 'erased', 'gi'),
                   detail = regexp_replace(detail::text, v_id, 'erased', 'gi')::jsonb
             WHERE action ~* v_id OR detail::text ~* v_id;
            UPDATE admin_audit SET admin_user_id = NULL WHERE admin_user_id = p_user_id;

            -- The rows the seven keys guard, children before what they name:
            -- a fill's movement, a proposal's fills, intents and attempts, then
            -- the proposals (which name the scans), the scans, the cash and the
            -- conversations. Then the user; the rest cascades.
            DELETE FROM cash_movements WHERE user_id = p_user_id;
            DELETE FROM fills WHERE user_id = p_user_id;
            DELETE FROM intents WHERE user_id = p_user_id;
            DELETE FROM proposal_attempts WHERE user_id = p_user_id;
            DELETE FROM proposals WHERE user_id = p_user_id;
            DELETE FROM agent_scans WHERE user_id = p_user_id;
            DELETE FROM agent_cash WHERE user_id = p_user_id;
            DELETE FROM assistant_conversations WHERE user_id = p_user_id;
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
    op.execute("ALTER TABLE admin_audit ALTER COLUMN admin_user_id SET NOT NULL")

    # No way in, and nothing the older code would erase.
    op.execute("ALTER TABLE users DROP CONSTRAINT users_closed_has_deletion_date")
    op.execute("UPDATE users SET status = 'disabled' WHERE status = 'closed'")
    op.execute("DROP INDEX users_rejected_at")
    op.execute("DROP INDEX users_deletion_due")
    op.execute("ALTER TABLE users DROP COLUMN rejected_at, DROP COLUMN deletion_due_at")
    _statuses(PREVIOUS_STATUSES)

    op.execute("DELETE FROM runs WHERE kind = 'account_erase'")
    _kinds(PREVIOUS_KINDS)
