"""The admin chooses models like every user: `llm_model_choices` is dropped (D360).

0041 gave the Admin page one model per scope for the whole installation (D43),
and D244 then gave every other user their own choice in `user_settings` and
`agents.model`. The admin had two places to choose; now there is one. Nothing
reads or writes the table any more: an admin scope with nothing saved runs on
the tested model, as every user's does, and on production that changed no call
that ran (measured 2026-11-02: Ask and explanations were already on the tested
model, and the one agent that scans has a model of its own).

Downgrade recreates the table empty, with 0041's columns and privileges and
0052's scopes; the old code reads a missing row as "not chosen" and runs on
`LLM_MODEL`. An image rolled back without the downgrade still makes every call,
because its failed read of the choice is logged and answered by `LLM_MODEL`;
only its Admin model card and the admin's model pickers fail to load.

Revision ID: 0081_drop_admin_model_choices
Revises: 0080_cash_movement_kinds
"""

from alembic import op

revision = "0081_drop_admin_model_choices"
down_revision = "0080_cash_movement_kinds"
branch_labels = None
depends_on = None

APP_ROLE = "traders_app"


def upgrade() -> None:
    op.execute("DROP TABLE llm_model_choices")


def downgrade() -> None:
    op.execute(
        """
        CREATE TABLE llm_model_choices (
            scope text PRIMARY KEY
                CONSTRAINT llm_model_choices_scope_check
                CHECK (scope IN ('explain', 'agent', 'assistant')),
            model text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
            updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
            updated_at timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(f"REVOKE DELETE, TRUNCATE ON llm_model_choices FROM {APP_ROLE}")
