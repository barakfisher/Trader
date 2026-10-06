"""The models chosen on the Admin page, and `llm_calls` ready for per-agent spend.

Stage 4, PR 2 (docs/PROPOSAL-MULTI-AGENT.md D43-D45, §14).

**`llm_model_choices`** holds one model per scope: `explain` (narration and
`/ask`) and `agent` (an agent's scan). It is the installation's, not a user's:
the provider, its key and the global spend ceiling are installation-wide, and
so is the choice of what to call with them - guideline 5's `user_id` is
`updated_by` here, the admin who chose. No row means "not chosen yet", and the
AI service then uses `LLM_MODEL`; a choice is replaced, never deleted, so the
app role loses DELETE.

**`llm_calls.agent` becomes `purpose`, expand then contract** (decision 101).
`agent` meant the calling component (`narration`, `ask`) and Stage 4 adds
`agent_id`, a real agent; keeping both names in one table would confuse every
query that reads them. Renaming outright would break the pods still running
the old code between this migration and their replacement (kind rolls them
seconds apart), so this revision adds `purpose` beside `agent`, backfills it,
and a trigger keeps the two equal whichever one a writer names. A later
revision drops `agent` and the trigger, once no running code writes it -
PR 3's, which also widens `purpose` to the agent's scan.

**`llm_calls.agent_id`** names the agent a call was made for (an agent's scan,
from PR 3), null for narration and `/ask`. The composite foreign key follows
0036's pattern; because a composite key with a null member is not checked, an
`agent_id` without a `user_id` is refused by a CHECK of its own.

Revision ID: 0041_llm_models
Revises: 0040_ledger
"""

from alembic import op

revision = "0041_llm_models"
down_revision = "0040_ledger"
branch_labels = None
depends_on = None

APP_ROLE = "traders_app"
#: The values the CHECKs below admit; `app/llm/base.py:Purpose` and
#: `app/llm/catalogue.py:Scope` are tested against them.
PURPOSES = ("narration", "ask")
SCOPES = ("explain", "agent")


def _sql_list(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def upgrade() -> None:
    op.execute(
        f"""
        CREATE TABLE llm_model_choices (
            scope text PRIMARY KEY CHECK (scope IN ({_sql_list(SCOPES)})),
            model text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
            updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
            updated_at timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    # 0033's default privileges granted the app role everything on a new table.
    op.execute(f"REVOKE DELETE, TRUNCATE ON llm_model_choices FROM {APP_ROLE}")

    op.execute("ALTER TABLE llm_calls ADD COLUMN purpose text")
    op.execute("UPDATE llm_calls SET purpose = agent")
    op.execute(
        """
        CREATE FUNCTION llm_calls_purpose_follows_agent() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            -- Old code names `agent`, new code `purpose`; either fills the other.
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
    op.execute("ALTER TABLE llm_calls ALTER COLUMN purpose SET NOT NULL")
    op.execute(
        "ALTER TABLE llm_calls ADD CONSTRAINT llm_calls_purpose_check "
        f"CHECK (purpose IN ({_sql_list(PURPOSES)}))"
    )
    op.execute(
        "ALTER TABLE llm_calls ADD CONSTRAINT llm_calls_purpose_is_agent CHECK (purpose = agent)"
    )
    op.execute("CREATE INDEX llm_calls_purpose_idx ON llm_calls (purpose, started_at DESC)")

    op.execute("ALTER TABLE llm_calls ADD COLUMN agent_id uuid")
    op.execute(
        """
        ALTER TABLE llm_calls ADD CONSTRAINT llm_calls_agent_fkey
            FOREIGN KEY (user_id, agent_id) REFERENCES agents (user_id, id) ON DELETE CASCADE
        """
    )
    op.execute(
        "ALTER TABLE llm_calls ADD CONSTRAINT llm_calls_agent_has_user "
        "CHECK (agent_id IS NULL OR user_id IS NOT NULL)"
    )
    op.execute(
        "CREATE INDEX llm_calls_agent_spend_idx ON llm_calls (agent_id, started_at DESC) "
        "WHERE agent_id IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX llm_calls_agent_spend_idx")
    op.execute("ALTER TABLE llm_calls DROP CONSTRAINT llm_calls_agent_has_user")
    op.execute("ALTER TABLE llm_calls DROP CONSTRAINT llm_calls_agent_fkey")
    op.execute("ALTER TABLE llm_calls DROP COLUMN agent_id")
    op.execute("DROP INDEX llm_calls_purpose_idx")
    op.execute("DROP TRIGGER llm_calls_purpose_follows_agent ON llm_calls")
    op.execute("DROP FUNCTION llm_calls_purpose_follows_agent()")
    op.execute("ALTER TABLE llm_calls DROP COLUMN purpose")
    op.execute("DROP TABLE llm_model_choices")
