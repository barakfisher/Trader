"""A re-check of an expired trade proposal is a scan of its own, at most once (D212, D213).

A re-check runs through the scan machinery, so it is an `agent_scans` row with
trigger `refresh` and the proposal it re-checks in `refreshes_proposal_id`; a
new proposal it raises hangs from that scan like any other (`proposals.scan_id`).

**Once per proposal is the database's**: a unique index on
`refreshes_proposal_id` over every re-check that is running or reached an
answer. A re-check that ended without one - failed, or stopped by a budget, the
cap or the user's own key - is left out of the index, so it does not use the
proposal's one refresh up (D213).

The downgrade refuses while a re-check exists: 0065's triggers cannot name it,
and relabelling it `manual` would lose which proposal it was for.

Revision ID: 0066_proposal_refresh
Revises: 0065_own_llm_keys
"""

from alembic import op

revision = "0066_proposal_refresh"
down_revision = "0065_own_llm_keys"
branch_labels = None
depends_on = None

#: 0043's triggers; code Literals are tested against `TRIGGERS`.
PREVIOUS_TRIGGERS = ("manual", "schedule")
TRIGGERS = (*PREVIOUS_TRIGGERS, "refresh")

#: Outcomes of a re-check that reached no answer: they do not use the refresh up (D213).
UNANSWERED_OUTCOMES = ("failed", "budget_reached", "cap_reached", "own_key_failed")


def _sql_list(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def upgrade() -> None:
    _triggers(TRIGGERS)
    op.execute(
        "ALTER TABLE agent_scans ADD COLUMN refreshes_proposal_id uuid "
        "REFERENCES proposals (id) ON DELETE CASCADE"
    )
    op.execute(
        "ALTER TABLE agent_scans ADD CONSTRAINT agent_scans_refresh_names_proposal "
        "CHECK ((trigger = 'refresh') = (refreshes_proposal_id IS NOT NULL))"
    )
    op.execute(
        "CREATE UNIQUE INDEX agent_scans_one_refresh ON agent_scans (refreshes_proposal_id) "
        f"WHERE outcome IS NULL OR outcome NOT IN ({_sql_list(UNANSWERED_OUTCOMES)})"
    )


def downgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM agent_scans WHERE trigger = 'refresh') THEN
                RAISE EXCEPTION 'agent_scans holds re-checks; 0065 cannot name them';
            END IF;
        END
        $$
        """
    )
    op.execute("DROP INDEX agent_scans_one_refresh")
    op.execute("ALTER TABLE agent_scans DROP CONSTRAINT agent_scans_refresh_names_proposal")
    op.execute("ALTER TABLE agent_scans DROP COLUMN refreshes_proposal_id")
    _triggers(PREVIOUS_TRIGGERS)


def _triggers(triggers: tuple[str, ...]) -> None:
    op.execute("ALTER TABLE agent_scans DROP CONSTRAINT agent_scans_trigger_check")
    op.execute(
        "ALTER TABLE agent_scans ADD CONSTRAINT agent_scans_trigger_check "
        f"CHECK (trigger IN ({_sql_list(triggers)}))"
    )
