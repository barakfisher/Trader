"""The assistant: conversations, their messages, and what it may spend (MEMORY.md,
"Planned: the assistant"; the user's choices of 2026-10-11).

- **`assistant_conversations` and `assistant_messages`**, two plain tables, not
  a framework's checkpoint (decided 2026-10-07): small text that must be listed,
  read back as a history and deleted on request. `user_id` on both (guideline 5),
  so every query can be scoped without a join. Deleting a conversation deletes
  its messages (`ON DELETE CASCADE`): the "delete this conversation" control and
  the 90-day retention are each one `DELETE`.
- **A message keeps what was used to answer it**: `tool_calls` is the tools run
  with their results, the record "every conversation is logged for review"
  promises; `sources` and `suggestions` are what the screen shows. `outcome`
  says what the reply was - an answer, a decline, a request to clarify - or why
  there was none (`failed`, `budget_reached`, `no_model`).
- **`assistant` is a scope of its own** on the Admin page (the user, 2026-10-11:
  not the agents' model, not narration's) and a purpose of its own in
  `llm_calls`, so its spend is one indexed sum, as an agent's is (D45).
- **`installation_settings.assistant_daily_budget_micro_usd`**: what one user's
  questions may spend a day, $0.50 until a measured figure replaces it (the
  user, 2026-10-11). The installation's, like `max_agents_per_user` (0047),
  because it is set on the Admin page; it is applied per user.

Revision ID: 0052_assistant
Revises: 0051_insights_seen
"""

from alembic import op

revision = "0052_assistant"
down_revision = "0051_insights_seen"
branch_labels = None
depends_on = None

#: What a reply was, or why there was none.
OUTCOMES = ("answer", "decline", "clarify", "failed", "budget_reached", "no_model")
#: Why a reply declined (data/eval/assistant.json, "about").
DECLINE_REASONS = ("off_domain", "advice", "action", "prompt")
#: What `llm_calls.purpose` and `llm_model_choices.scope` accept from here on;
#: `test_llm_call_log.py` holds them equal to `Purpose` and `Scope` in code.
PURPOSES = ("narration", "ask", "agent_scan", "assistant")
SCOPES = ("explain", "agent", "assistant")
#: $0.50 a day, in micro-USD (`app/llm/base.py`).
DEFAULT_DAILY_BUDGET_MICRO_USD = 500_000


def _sql_list(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE assistant_conversations (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id uuid NOT NULL REFERENCES users (id),
            title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE (user_id, id)
        )
        """
    )
    op.execute(
        "CREATE INDEX assistant_conversations_by_user "
        "ON assistant_conversations (user_id, updated_at DESC)"
    )
    op.execute(
        f"""
        CREATE TABLE assistant_messages (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            conversation_id uuid NOT NULL,
            user_id uuid NOT NULL,
            role text NOT NULL CHECK (role IN ('user', 'assistant')),
            content text NOT NULL,
            outcome text CHECK (outcome IN ({_sql_list(OUTCOMES)})),
            reason text CHECK (reason IN ({_sql_list(DECLINE_REASONS)})),
            sources jsonb NOT NULL DEFAULT '[]'::jsonb,
            suggestions jsonb NOT NULL DEFAULT '[]'::jsonb,
            tool_calls jsonb NOT NULL DEFAULT '[]'::jsonb,
            model text,
            cost_micro_usd bigint NOT NULL DEFAULT 0 CHECK (cost_micro_usd >= 0),
            created_at timestamptz NOT NULL DEFAULT now(),
            FOREIGN KEY (user_id, conversation_id)
                REFERENCES assistant_conversations (user_id, id) ON DELETE CASCADE,
            CONSTRAINT assistant_messages_outcome_is_the_assistants
                CHECK ((role = 'assistant') = (outcome IS NOT NULL)),
            CONSTRAINT assistant_messages_reason_is_a_declines
                CHECK ((reason IS NOT NULL) = (outcome = 'decline')),
            CONSTRAINT assistant_messages_lists_are_lists CHECK (
                jsonb_typeof(sources) = 'array'
                AND jsonb_typeof(suggestions) = 'array'
                AND jsonb_typeof(tool_calls) = 'array'
            )
        )
        """
    )
    op.execute(
        "CREATE INDEX assistant_messages_by_conversation "
        "ON assistant_messages (conversation_id, created_at)"
    )

    op.execute("ALTER TABLE llm_model_choices DROP CONSTRAINT llm_model_choices_scope_check")
    op.execute(
        "ALTER TABLE llm_model_choices ADD CONSTRAINT llm_model_choices_scope_check "
        f"CHECK (scope IN ({_sql_list(SCOPES)}))"
    )
    op.execute("ALTER TABLE llm_calls DROP CONSTRAINT llm_calls_purpose_check")
    op.execute(
        "ALTER TABLE llm_calls ADD CONSTRAINT llm_calls_purpose_check "
        f"CHECK (purpose IN ({_sql_list(PURPOSES)}))"
    )
    # The assistant's daily spend is one user's sum over a day: this index serves it.
    op.execute(
        "CREATE INDEX llm_calls_assistant_spend ON llm_calls (user_id, started_at) "
        "WHERE purpose = 'assistant'"
    )

    op.execute(
        f"""
        ALTER TABLE installation_settings
          ADD COLUMN assistant_daily_budget_micro_usd bigint NOT NULL
              DEFAULT {DEFAULT_DAILY_BUDGET_MICRO_USD}
              CHECK (assistant_daily_budget_micro_usd BETWEEN 0 AND 100000000)
        """
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE installation_settings DROP COLUMN IF EXISTS assistant_daily_budget_micro_usd"
    )
    op.execute("DROP INDEX IF EXISTS llm_calls_assistant_spend")
    op.execute("DELETE FROM llm_calls WHERE purpose = 'assistant'")
    op.execute("ALTER TABLE llm_calls DROP CONSTRAINT llm_calls_purpose_check")
    op.execute(
        "ALTER TABLE llm_calls ADD CONSTRAINT llm_calls_purpose_check "
        "CHECK (purpose IN ('narration', 'ask', 'agent_scan'))"
    )
    op.execute("DELETE FROM llm_model_choices WHERE scope = 'assistant'")
    op.execute("ALTER TABLE llm_model_choices DROP CONSTRAINT llm_model_choices_scope_check")
    op.execute(
        "ALTER TABLE llm_model_choices ADD CONSTRAINT llm_model_choices_scope_check "
        "CHECK (scope IN ('explain', 'agent'))"
    )
    op.execute("DROP TABLE IF EXISTS assistant_messages")
    op.execute("DROP TABLE IF EXISTS assistant_conversations")
