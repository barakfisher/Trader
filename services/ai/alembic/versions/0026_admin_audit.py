"""`admin_audit`: an append-only record of every admin action (M8).

One row per admin request that changes something, written by the orchestrator's
admin gate *before* the action runs - so an action whose audit row could not be
written does not run at all (decision 84).

**Append-only is enforced by Postgres, by triggers, not by grants.** The
application connects as `traders`, which owns every table and is a superuser;
`REVOKE UPDATE, DELETE` from that role is silently meaningless. A trigger fires
for a superuser too, so UPDATE and DELETE (per row) and TRUNCATE (per statement)
all raise. What a superuser *can* still do is `ALTER TABLE ... DISABLE TRIGGER`
or set `session_replication_role = replica` - a deliberate DDL act, never an
accident of application code. Separate owner and application roles would close
that too; they are in the debt table, because they change every connection
string in compose, kind and CI.

`admin_user_id` references `users` with no ON DELETE action: CASCADE would be a
DELETE here and SET NULL an UPDATE, both refused. Deleting an admin who has
acted is refused by the foreign key, which is the same answer.

The downgrade drops the table, so it refuses while any row exists (like 0014's):
discarding the audit must be a decision, and the way through is spelled out in
the error.

Revision ID: 0026_admin_audit
Revises: 0025_user_role
"""

from alembic import op

revision = "0026_admin_audit"
down_revision = "0025_user_role"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE admin_audit (
            id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            admin_user_id uuid NOT NULL REFERENCES users (id),
            action        text NOT NULL,
            detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
            ip_address    inet,
            request_id    text,
            occurred_at   timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute("CREATE INDEX admin_audit_recent_idx ON admin_audit (occurred_at DESC)")
    op.execute(
        """
        CREATE FUNCTION admin_audit_refuse_change() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'admin_audit is append-only: % refused', TG_OP
                USING ERRCODE = 'insufficient_privilege';
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER admin_audit_append_only
            BEFORE UPDATE OR DELETE ON admin_audit
            FOR EACH ROW EXECUTE FUNCTION admin_audit_refuse_change()
        """
    )
    op.execute(
        """
        CREATE TRIGGER admin_audit_no_truncate
            BEFORE TRUNCATE ON admin_audit
            FOR EACH STATEMENT EXECUTE FUNCTION admin_audit_refuse_change()
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM admin_audit) THEN
                RAISE EXCEPTION 'admin_audit holds rows; downgrading would discard the audit. '
                    'To discard it deliberately: ALTER TABLE admin_audit DISABLE TRIGGER USER, '
                    'then DELETE FROM admin_audit';
            END IF;
        END;
        $$
        """
    )
    op.execute("DROP TABLE admin_audit")
    op.execute("DROP FUNCTION admin_audit_refuse_change()")
