"""The application's own database role, so a grant protects something (task 9).

Until now every service connected as `traders`, the role the Postgres image
creates from `POSTGRES_USER`: a superuser that owns every table. Grants mean
nothing to it, so `admin_audit` was append-only only by its triggers (decision
84), which a superuser can `DISABLE`, and any SQL-injection bug would have run
with every right in the cluster.

- **`traders_app`**: `NOSUPERUSER`, created `NOLOGIN` here. Its password is a
  secret, so it is never in a migration: `scripts/migrate.py` sets
  `LOGIN PASSWORD` from `APP_DB_PASSWORD` after every upgrade, which is also how
  a password is rotated.
- **Rows only.** `SELECT, INSERT, UPDATE, DELETE` on every table in `public` and
  `mastra`, and the sequences behind them. Measured before choosing: no service,
  loader or script issues DDL, `TRUNCATE`, `COPY` or an advisory lock at
  runtime - schema changes are Alembic's alone, run as the owner.
- **`admin_audit`: `INSERT, SELECT` only.** Now Postgres refuses an UPDATE or
  DELETE by privilege, before the triggers are reached; the triggers stay for
  the owner. `alembic_version` is read-only to the app (`wait_for_schema.py`
  reads it).
- **Default privileges** for tables the migrating role creates later, so a new
  table is usable by the app without each migration remembering to grant it.
  A new append-only table must still `REVOKE` explicitly.
- The role is cluster-wide while a migration is per database, and the test
  databases share a cluster with the real one. So the role is created if absent
  and **never dropped**: the downgrade removes its rights in this database only.

Revision ID: 0033_app_role
Revises: 0032_proposal_episodes
"""

from alembic import op

revision = "0033_app_role"
down_revision = "0032_proposal_episodes"
branch_labels = None
depends_on = None

#: The role every service connects as. Named in compose, k8s and CI.
APP_ROLE = "traders_app"

SCHEMAS = ("public", "mastra")


def upgrade() -> None:
    op.execute(
        f"""
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{APP_ROLE}') THEN
                CREATE ROLE {APP_ROLE} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
            END IF;
        END
        $$
        """
    )
    op.execute(
        f"""
        DO $$
        BEGIN
            EXECUTE format('GRANT CONNECT ON DATABASE %I TO {APP_ROLE}', current_database());
        END
        $$
        """
    )
    for schema in SCHEMAS:
        op.execute(f"GRANT USAGE ON SCHEMA {schema} TO {APP_ROLE}")
        op.execute(
            f"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA {schema} TO {APP_ROLE}"
        )
        op.execute(f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA {schema} TO {APP_ROLE}")
        op.execute(
            f"ALTER DEFAULT PRIVILEGES IN SCHEMA {schema} "
            f"GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {APP_ROLE}"
        )
        op.execute(
            f"ALTER DEFAULT PRIVILEGES IN SCHEMA {schema} "
            f"GRANT USAGE, SELECT ON SEQUENCES TO {APP_ROLE}"
        )
    op.execute(f"REVOKE UPDATE, DELETE ON admin_audit FROM {APP_ROLE}")
    op.execute(f"REVOKE INSERT, UPDATE, DELETE ON alembic_version FROM {APP_ROLE}")


def downgrade() -> None:
    for schema in SCHEMAS:
        op.execute(
            f"ALTER DEFAULT PRIVILEGES IN SCHEMA {schema} "
            f"REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM {APP_ROLE}"
        )
        op.execute(
            f"ALTER DEFAULT PRIVILEGES IN SCHEMA {schema} "
            f"REVOKE USAGE, SELECT ON SEQUENCES FROM {APP_ROLE}"
        )
        op.execute(f"REVOKE ALL ON ALL TABLES IN SCHEMA {schema} FROM {APP_ROLE}")
        op.execute(f"REVOKE ALL ON ALL SEQUENCES IN SCHEMA {schema} FROM {APP_ROLE}")
        op.execute(f"REVOKE USAGE ON SCHEMA {schema} FROM {APP_ROLE}")
    op.execute(
        f"""
        DO $$
        BEGIN
            EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM {APP_ROLE}', current_database());
        END
        $$
        """
    )
