"""Model choice: a model per agent, for Ask and for explanations, and fallbacks (D244, D283-D286).

`agents.model`, `user_settings.llm_explain_model` and
`user_settings.llm_assistant_model` hold an OpenRouter model id a user who is
not the admin chose (D244); NULL is "not chosen", which runs on the tested
model (D283, D285). The admin keeps `llm_model_choices` (0041), and these
columns are never read for them. A saved id is kept even once OpenRouter stops
listing it: the call falls back (D284), and the model returns by itself if it
is listed again.

`model_fallbacks` records the first call that ran on a fallback, per user,
scope, agent and saved model (D286). The orchestrator announces each row once
through the notification ledger, and `notifications.ref_kind` gains
`'model_fallback'` pointing at it. `agent_id` is the agent for the `agent`
scope and the user's main portfolio (the primary agent) for the other two,
because a notification names an agent (0047).

The downgrade drops the columns, which loses only preferences, and the
fallback rows with their notifications.

Revision ID: 0069_model_choice
Revises: 0068_own_key_only
"""

from alembic import op

revision = "0069_model_choice"
down_revision = "0068_own_key_only"
branch_labels = None
depends_on = None

#: The shape of an OpenRouter model id: "vendor/model", optionally ":variant".
#: `app/llm/openrouter_models.py` offers nothing else; the CHECK keeps a hand
#: write from storing what no call could send.
MODEL_ID_PATTERN = r"^[a-z0-9][a-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._:-]*$"
#: Longer than any id OpenRouter lists (56 characters, 2026-10-23).
MODEL_ID_MAX_LENGTH = 200

#: The scopes a fallback is recorded for: `catalogue.Scope`.
SCOPES = ("explain", "agent", "assistant")

#: 0022's notification referents, which the reset in 0045 also names.
PREVIOUS_REF_KINDS = ("observation", "proposal", "narration")
REF_KINDS = (*PREVIOUS_REF_KINDS, "model_fallback")


def _model_check(column: str) -> str:
    return f"CHECK ({column} ~ '{MODEL_ID_PATTERN}' AND length({column}) <= {MODEL_ID_MAX_LENGTH})"


def _sql_list(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def _ref_kinds(kinds: tuple[str, ...]) -> None:
    op.execute("ALTER TABLE notifications DROP CONSTRAINT notifications_ref_kind_check")
    op.execute(
        "ALTER TABLE notifications ADD CONSTRAINT notifications_ref_kind_check "
        f"CHECK (ref_kind IN ({_sql_list(kinds)}))"
    )


def upgrade() -> None:
    op.execute(
        "ALTER TABLE agents ADD COLUMN model text "
        f"CONSTRAINT agents_model_check {_model_check('model')}"
    )
    for column in ("llm_explain_model", "llm_assistant_model"):
        op.execute(
            f"ALTER TABLE user_settings ADD COLUMN {column} text "
            f"CONSTRAINT user_settings_{column}_check {_model_check(column)}"
        )
    op.execute(
        f"""
        CREATE TABLE model_fallbacks (
            id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            agent_id        uuid NOT NULL,
            scope           text NOT NULL CHECK (scope IN ({_sql_list(SCOPES)})),
            saved_model     text NOT NULL,
            effective_model text NOT NULL,
            created_at      timestamptz NOT NULL DEFAULT now(),
            announced_at    timestamptz,
            FOREIGN KEY (user_id, agent_id) REFERENCES agents(user_id, id) ON DELETE CASCADE,
            CONSTRAINT model_fallbacks_once UNIQUE (user_id, scope, agent_id, saved_model)
        )
        """
    )
    op.execute(
        "CREATE INDEX model_fallbacks_unannounced ON model_fallbacks (created_at) "
        "WHERE announced_at IS NULL"
    )
    _ref_kinds(REF_KINDS)


def downgrade() -> None:
    op.execute("DELETE FROM notifications WHERE ref_kind = 'model_fallback'")
    _ref_kinds(PREVIOUS_REF_KINDS)
    op.execute("DROP TABLE model_fallbacks")
    op.execute("ALTER TABLE user_settings DROP COLUMN llm_assistant_model")
    op.execute("ALTER TABLE user_settings DROP COLUMN llm_explain_model")
    op.execute("ALTER TABLE agents DROP COLUMN model")
