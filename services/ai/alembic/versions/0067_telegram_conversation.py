"""A Telegram chat's rolling conversation with the assistant (D222).

A question sent to the bot joins the chat's conversation - an ordinary
`assistant_conversations` row, so the Ask page lists, reads and deletes it like
any other - until it has been quiet for twelve hours or the user sends `/new`.
The binding holds which conversation that is. Deleting the conversation (on the
Ask page, or by its 90-day retention) sets the column to null, and the next
question starts a new one.

The column is the binding's because the binding is the chat: `/stop` deletes it,
and with it the pointer, while the conversation stays in the history.

Revision ID: 0067_telegram_conversation
Revises: 0066_proposal_refresh
"""

from alembic import op

revision = "0067_telegram_conversation"
down_revision = "0066_proposal_refresh"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE telegram_bindings ADD COLUMN assistant_conversation_id uuid "
        "REFERENCES assistant_conversations (id) ON DELETE SET NULL"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE telegram_bindings DROP COLUMN assistant_conversation_id")
