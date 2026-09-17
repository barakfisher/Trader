"""Telegram: which chat belongs to which user, and the tokens that bind them (M4).

Two tables, and between them they answer the only question the webhook asks:
*is this chat allowed to act for this user?*

`telegram_bindings` is that answer. One row per user and one per chat, enforced
both ways: a second chat for one user would mean an approval could arrive from a
device the user no longer holds, and a second user for one chat would mean two
people's portfolios answering on the same thread. Neither has a sensible reading,
so neither is representable.

`telegram_bind_tokens` is what makes a binding link single-use. The token itself
is stateless - a signed payload naming the user, a nonce and an expiry - so
nothing is written when a link is *minted*. A row appears only when one is
*redeemed*, and because the nonce is the primary key, the second redemption of
the same link loses the insert. That is the whole mechanism: single-use is a
primary key, not a flag somebody has to remember to check.

Minting without writing matters more than it looks. A user who opens the settings
page three times and never taps the link leaves no rows, so there is no table of
unredeemed tokens to expire, and no sweep to write for it. The signature carries
the expiry, so an unredeemed token simply stops verifying.

Revision ID: 0009_telegram_bindings
Revises: 0008_mastra_workflow_state
"""

from alembic import op

revision = "0009_telegram_bindings"
down_revision = "0008_mastra_workflow_state"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE telegram_bindings (
            -- One chat per user: the primary key says so, and the unique on
            -- chat_id says the converse.
            user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

            -- Telegram chat ids are 64-bit and can be negative (groups), so
            -- bigint rather than integer, and never text: a numeric id stored
            -- as a string compares unequal to itself the moment one writer
            -- pads it or another trims it.
            chat_id    bigint NOT NULL UNIQUE,

            -- Who we think we are talking to, for the UI to show. Display data
            -- only: nothing authorises off this, because a username can be
            -- changed by its owner at any time and reused by somebody else.
            username   text,

            bound_at   timestamptz NOT NULL DEFAULT now()
        )
        """
    )

    op.execute(
        """
        CREATE TABLE telegram_bind_tokens (
            -- The nonce from the signed link, and the entire single-use
            -- mechanism: redemption is this INSERT, so a replayed link loses
            -- it. A `used_at` flag on a pre-written row would have been the
            -- alternative, and it fails in the classic way - check, then write,
            -- with a window in between that two taps can both pass through.
            nonce      text PRIMARY KEY,

            user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            chat_id    bigint NOT NULL,
            redeemed_at timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    # Redeemed tokens are only ever read to answer "how did this chat get bound".
    op.execute(
        """
        CREATE INDEX telegram_bind_tokens_user_idx
            ON telegram_bind_tokens (user_id, redeemed_at DESC)
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS telegram_bind_tokens")
    op.execute("DROP TABLE IF EXISTS telegram_bindings")
