"""Mastra is retired: drop the `mastra` schema 0008 created for it (decision D11).

`docs/PROPOSAL-MULTI-AGENT.md` §10 D11, the user's decision of 2026-10-04,
reversing decision 11. The proposal workflow is the state machine alone: the
`proposals` row holds the question and its deadline, `applyDecision` answers it,
and the `proposal_sweep` run expires it. That is what already ran whenever the
engine was absent, and the orchestrator no longer imports the library.

The schema held one table, `mastra_workflow_snapshot`: each run's snapshot. Nothing
in it is a record the product needs - every proposal, transition and intent lives
in `public` - and measured before writing this, no run was waiting: the live
database held 17 runs, all `success`, and kind's held none.

CASCADE because the schema is the unit 0008 added, as 0008's own downgrade
argues; it also takes the default privileges 0033 set in it.

The downgrade recreates the schema and its table empty, with 0033's grants,
so the revisions below find what they expect. It does not restore snapshots.

Revision ID: 0039_retire_mastra
Revises: 0038_primary_is_passive
"""

import importlib.util
from pathlib import Path

from alembic import op

revision = "0039_retire_mastra"
down_revision = "0038_primary_is_passive"
branch_labels = None
depends_on = None

APP_ROLE = "traders_app"


def upgrade() -> None:
    op.execute("DROP SCHEMA IF EXISTS mastra CASCADE")


def downgrade() -> None:
    # 0008's DDL, run from 0008 itself rather than copied, so there is one text.
    path = Path(__file__).with_name("0008_mastra_workflow_state.py")
    spec = importlib.util.spec_from_file_location("migration_0008", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.upgrade()

    # 0033's grants on the schema, for an installation that has the role.
    op.execute(
        f"""
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{APP_ROLE}') THEN
                GRANT USAGE ON SCHEMA mastra TO {APP_ROLE};
                GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mastra TO {APP_ROLE};
                ALTER DEFAULT PRIVILEGES IN SCHEMA mastra
                    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {APP_ROLE};
                ALTER DEFAULT PRIVILEGES IN SCHEMA mastra
                    GRANT USAGE, SELECT ON SEQUENCES TO {APP_ROLE};
            END IF;
        END
        $$
        """
    )
