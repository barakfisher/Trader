"""What an agent's scan needs before it can run: its budget, its schedule, its purpose.

Stage 4, PR 3 (docs/PROPOSAL-MULTI-AGENT.md D45, D46, §14.2).

**The contract half of 0041.** Every reader and writer of `llm_calls` has named
`purpose` since 0041 shipped (compose and kind both ran it before this), so the
old `agent` column, the trigger that kept the two equal and the CHECK between
them go. `purpose` gains `agent_scan`: a call made by an agent's scan, which
always names its `agent_id` - and only such a call does, so per-agent spend
(D45) is a sum over one purpose.

**`agents.llm_budget_micro_usd`**: what an agent's scans may spend per UTC day,
in integer micro-USD (D45; $0.50 by default, at most $100). Every agent row has
one, the primary's unused: it never scans (D1), and a NULL would make every
reader ask which kind of agent it holds.

**`agents.scan_schedule`**: when an agent scans (D46) - pre-open by default. Read
by the schedule (Stage 4's last PR) and shown on the agent's Settings; the times
belong to the exchange's calendar, not to this column.

The downgrade refuses while an `agent_scan` call is recorded: the restored
`agent` column cannot name one.

Revision ID: 0042_agent_scan_inputs
Revises: 0041_llm_models
"""

from alembic import op

revision = "0042_agent_scan_inputs"
down_revision = "0041_llm_models"
branch_labels = None
depends_on = None

#: The values the CHECKs below admit; code Literals are tested against them.
PURPOSES = ("narration", "ask", "agent_scan")
SCAN_SCHEDULES = ("pre_open", "pre_open_post_close", "intraday_twice", "intraday_once")
DEFAULT_LLM_BUDGET_MICRO_USD = 500_000
MAX_LLM_BUDGET_MICRO_USD = 100_000_000


def _sql_list(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def upgrade() -> None:
    op.execute("DROP TRIGGER llm_calls_purpose_follows_agent ON llm_calls")
    op.execute("DROP FUNCTION llm_calls_purpose_follows_agent()")
    op.execute("ALTER TABLE llm_calls DROP CONSTRAINT llm_calls_purpose_is_agent")
    # Its CHECK (`llm_calls_agent_check`) and index go with the column.
    op.execute("ALTER TABLE llm_calls DROP COLUMN agent")
    op.execute("ALTER TABLE llm_calls DROP CONSTRAINT llm_calls_purpose_check")
    op.execute(
        "ALTER TABLE llm_calls ADD CONSTRAINT llm_calls_purpose_check "
        f"CHECK (purpose IN ({_sql_list(PURPOSES)}))"
    )
    op.execute(
        "ALTER TABLE llm_calls ADD CONSTRAINT llm_calls_scan_names_its_agent "
        "CHECK ((purpose = 'agent_scan') = (agent_id IS NOT NULL))"
    )

    op.execute(
        "ALTER TABLE agents ADD COLUMN llm_budget_micro_usd bigint NOT NULL "
        f"DEFAULT {DEFAULT_LLM_BUDGET_MICRO_USD} "
        f"CHECK (llm_budget_micro_usd > 0 AND llm_budget_micro_usd <= {MAX_LLM_BUDGET_MICRO_USD})"
    )
    op.execute(
        "ALTER TABLE agents ADD COLUMN scan_schedule text NOT NULL DEFAULT 'pre_open' "
        f"CHECK (scan_schedule IN ({_sql_list(SCAN_SCHEDULES)}))"
    )


def downgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM llm_calls WHERE purpose = 'agent_scan') THEN
                RAISE EXCEPTION 'llm_calls holds agent_scan calls; the restored agent column '
                    'cannot name them. To discard them: DELETE FROM llm_calls '
                    'WHERE purpose = ''agent_scan''';
            END IF;
        END;
        $$
        """
    )
    op.execute("ALTER TABLE agents DROP COLUMN scan_schedule")
    op.execute("ALTER TABLE agents DROP COLUMN llm_budget_micro_usd")
    op.execute("ALTER TABLE llm_calls DROP CONSTRAINT llm_calls_scan_names_its_agent")
    op.execute("ALTER TABLE llm_calls DROP CONSTRAINT llm_calls_purpose_check")
    op.execute(
        "ALTER TABLE llm_calls ADD CONSTRAINT llm_calls_purpose_check "
        "CHECK (purpose IN ('narration', 'ask'))"
    )
    op.execute("ALTER TABLE llm_calls ADD COLUMN agent text")
    op.execute("UPDATE llm_calls SET agent = purpose")
    op.execute("ALTER TABLE llm_calls ALTER COLUMN agent SET NOT NULL")
    op.execute(
        "ALTER TABLE llm_calls ADD CONSTRAINT llm_calls_agent_check "
        "CHECK (agent = ANY (ARRAY['narration'::text, 'ask'::text]))"
    )
    op.execute("CREATE INDEX llm_calls_agent_idx ON llm_calls (agent, started_at DESC)")
    op.execute(
        "ALTER TABLE llm_calls ADD CONSTRAINT llm_calls_purpose_is_agent CHECK (purpose = agent)"
    )
    op.execute(
        """
        CREATE FUNCTION llm_calls_purpose_follows_agent() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            NEW.purpose := coalesce(NEW.purpose, NEW.agent);
            NEW.agent := coalesce(NEW.agent, NEW.purpose);
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER llm_calls_purpose_follows_agent
            BEFORE INSERT ON llm_calls
            FOR EACH ROW EXECUTE FUNCTION llm_calls_purpose_follows_agent()
        """
    )
