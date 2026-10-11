"""Query statistics: `pg_stat_statements`, so indexes come from evidence (database sprint DB3).

Nothing recorded which queries the services run or what they cost, so "which
index is missing" could only be guessed - and decision 141 says indexes wait for
a measurement. `pg_stat_statements` keeps, per normalised statement, how often
it ran, its total and mean time and the rows it returned; `scripts/db-report.sh`
reads it.

- **The extension needs the server to preload its library**
  (`shared_preload_libraries`), which is a server flag, not schema: it is set in
  `infra/compose/docker-compose.yml` and `infra/k8s/base/postgres.yaml`. Creating
  the extension works without the flag - CI's integration Postgres has none - and
  only reading the view then fails, which only the report does.
- **In a migration, not in the report script,** because an extension is part of
  the schema the AI service owns (as `vector` is, 0001), and a script that ran DDL
  the first time someone read a report would change the database by looking at it.
- **The application role cannot read the views.** The extension grants SELECT to
  `PUBLIC` - every role, `traders_app` included - and 0033's default privileges
  grant the app role SELECT on new tables besides; both are revoked. The
  statistics are an operator's, read as the owner; the app has no use for them,
  and other sessions' query text is not the app's to see. Checked with
  `has_table_privilege`, which counts `PUBLIC`: revoking from the role alone left
  it `true`.

Revision ID: 0050_query_statistics
Revises: 0049_finding_episodes
"""

from alembic import op

revision = "0050_query_statistics"
down_revision = "0049_finding_episodes"
branch_labels = None
depends_on = None

APP_ROLE = "traders_app"
VIEWS = ("pg_stat_statements", "pg_stat_statements_info")


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_stat_statements")
    for view in VIEWS:
        op.execute(f"REVOKE ALL ON {view} FROM PUBLIC")
        op.execute(
            f"""
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{APP_ROLE}') THEN
                    REVOKE ALL ON {view} FROM {APP_ROLE};
                END IF;
            END
            $$
            """
        )


def downgrade() -> None:
    op.execute("DROP EXTENSION IF EXISTS pg_stat_statements")
