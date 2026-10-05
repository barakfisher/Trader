"""Uniqueness becomes per agent (multi-agent Stage 1, PR 3: the contract).

0036 added the per-agent unique indexes *beside* the per-user constraints, so
its deploy could not break an `ON CONFLICT` that still named the old ones. The
orchestrator now names the new ones (same PR as this revision), so the old ones
go, and with them the last thing stopping two agents from holding the same
instrument, noticing the same move, or claiming the same run key.

| Table | Dropped | What remains |
|---|---|---|
| holdings | `UNIQUE (user_id, instrument_id)` | `(agent_id, instrument_id)` |
| observations | `UNIQUE (dedupe_key)` | `(agent_id, dedupe_key)` |
| runs | `UNIQUE (run_key)` | `(agent_id, run_key) NULLS NOT DISTINCT` |
| portfolio_snapshots | `UNIQUE (user_id, as_of)` | `(agent_id, as_of)` |
| target_weights | `PK (user_id, instrument_id)` | `PK (agent_id, instrument_id)` |
| proposal_episodes | `one_open (user_id, kind, subject)` | `(agent_id, kind, subject)`, open only |

**The dedupe hash and the run-key format are unchanged** (decision D13). A
stored key is a digest whose inputs are gone, so rewriting the formula could not
be backfilled, and the first scan after the deploy would re-emit the day's
findings under new keys and notify the user again. The composite key separates
agents exactly as well and leaves every stored key valid.

The downgrade restores the per-user constraints, and refuses where two agents'
rows would collide under them - it cannot choose which agent's row to keep.

Revision ID: 0037_per_agent_uniques
Revises: 0036_agents
"""

from alembic import op

revision = "0037_per_agent_uniques"
down_revision = "0036_agents"
branch_labels = None
depends_on = None

#: (table, the per-user constraint dropped, its definition for the downgrade).
PER_USER = (
    ("holdings", "holdings_user_id_instrument_id_key", "UNIQUE (user_id, instrument_id)"),
    ("observations", "observations_dedupe_key_key", "UNIQUE (dedupe_key)"),
    ("runs", "runs_run_key_key", "UNIQUE (run_key)"),
    ("portfolio_snapshots", "portfolio_snapshots_user_id_as_of_key", "UNIQUE (user_id, as_of)"),
)


def upgrade() -> None:
    for table, name, _ in PER_USER:
        op.execute(f"ALTER TABLE {table} DROP CONSTRAINT {name}")

    # The primary key moves onto the index 0036 built, rather than a new one.
    op.execute("ALTER TABLE target_weights DROP CONSTRAINT target_weights_pkey")
    op.execute(
        "ALTER TABLE target_weights ADD CONSTRAINT target_weights_pkey "
        "PRIMARY KEY USING INDEX target_weights_agent_instrument_key"
    )

    op.execute("DROP INDEX proposal_episodes_one_open")


def downgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM holdings GROUP BY user_id, instrument_id HAVING count(*) > 1)
            OR EXISTS (SELECT 1 FROM observations GROUP BY dedupe_key HAVING count(*) > 1)
            OR EXISTS (SELECT 1 FROM runs GROUP BY run_key HAVING count(*) > 1)
            OR EXISTS (SELECT 1 FROM portfolio_snapshots GROUP BY user_id, as_of
                       HAVING count(*) > 1)
            OR EXISTS (SELECT 1 FROM target_weights GROUP BY user_id, instrument_id
                       HAVING count(*) > 1)
            OR EXISTS (SELECT 1 FROM proposal_episodes WHERE closed_at IS NULL
                       GROUP BY user_id, observation_kind, subject_ref HAVING count(*) > 1)
            THEN
                RAISE EXCEPTION 'two agents hold rows that a per-user constraint would merge; '
                    'downgrading cannot choose which to keep. Remove the simulated agents'' '
                    'rows first';
            END IF;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX proposal_episodes_one_open
            ON proposal_episodes (user_id, observation_kind, subject_ref)
            WHERE closed_at IS NULL
        """
    )

    # Back to the per-user key; 0036's per-agent index is rebuilt beside it.
    op.execute("ALTER TABLE target_weights DROP CONSTRAINT target_weights_pkey")
    op.execute(
        "ALTER TABLE target_weights ADD CONSTRAINT target_weights_pkey "
        "PRIMARY KEY (user_id, instrument_id)"
    )
    op.execute(
        "CREATE UNIQUE INDEX target_weights_agent_instrument_key "
        "ON target_weights (agent_id, instrument_id)"
    )

    for table, name, definition in reversed(PER_USER):
        op.execute(f"ALTER TABLE {table} ADD CONSTRAINT {name} {definition}")
