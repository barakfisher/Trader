"""`telegram_proposal_messages`: which Telegram messages show a proposal (D427).

Found on production 2026-11-23: a buy approved for the open from Telegram
filled at 16:30, and the message it was approved on still offered *Cancel
approval*. The open sends a new message saying what it did; it could not edit
the old one, because no Telegram message id was stored anywhere.

- One row per message that shows a proposal's buttons: the chat, the message id
  and whether it was opened from `/pending` (its redraw keeps the way back,
  D282). A proposal may have several, so the table holds rows, not columns on
  `proposals`.
- Written today only when *Approve at the open* is tapped. When the open settles
  that approval (filled, refused, expired, closed, superseded), every row of the
  proposal is redrawn from its row. Recording every sent proposal message, and
  redrawing on any decision, is the same table later.
- `chat_id` and `message_id` are `bigint`: Telegram's ids are 64-bit, as
  `telegram_bindings.chat_id` is.
- `user_id` like every user-owned table (guideline 5); it and the proposal
  cascade, so erasing an account (0076) and its proposals takes these with them.

Downgrade drops the table: the messages keep whatever buttons they last had.

Revision ID: 0091_telegram_proposal_messages
Revises: 0090_agent_topics
"""

from alembic import op

revision = "0091_telegram_proposal_messages"
down_revision = "0090_agent_topics"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE telegram_proposal_messages (
            user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
            proposal_id uuid NOT NULL REFERENCES proposals (id) ON DELETE CASCADE,
            chat_id bigint NOT NULL,
            message_id bigint NOT NULL,
            back_to_pending boolean NOT NULL DEFAULT false,
            created_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (chat_id, message_id)
        )
        """
    )
    # The redraw's question: every message of one proposal.
    op.execute(
        "CREATE INDEX telegram_proposal_messages_proposal_idx "
        "ON telegram_proposal_messages (user_id, proposal_id)"
    )


def downgrade() -> None:
    op.execute("DROP TABLE telegram_proposal_messages")
