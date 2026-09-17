"""Notifications: what was sent, where, and what was deliberately not sent (M4).

One table, and it is a ledger rather than a queue. The distinction matters: a
queue answers "what is left to do", and this answers "what did the user
actually hear" - which is the question asked after an incident, when somebody
needs to know whether silence was a decision or a fault.

That is why a suppressed notification gets a row. A finding that was deferred
into a digest because of quiet hours, or held back because it sat below the
severity floor, is recorded with the reason. Writing rows only for messages that
went out would make "we chose not to tell you" and "we failed to tell you"
indistinguishable in exactly the situation where the difference is the whole
question.

`dedupe_key` is UNIQUE and carries the guarantee. Deduplicating a notification
cannot be done retroactively the way a duplicated observation can be tidied up
later, because a sent message cannot be recalled - so the uniqueness has to be
enforced at the moment of the write, by the database, for every writer at once.

Revision ID: 0007_notifications
Revises: 0006_proposals_and_settings
"""

from alembic import op

revision = "0007_notifications"
down_revision = "0006_proposals_and_settings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE notifications (
            id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

            -- Where it went. 'digest' is a channel like any other: it is a real
            -- destination with its own delivery and its own dedupe key, and
            -- modelling it as "telegram, but later" would mean a deferred alert
            -- and a sent one shared a key and collapsed into each other.
            channel     text NOT NULL CHECK (channel IN ('telegram','digest')),

            -- What was announced. Polymorphic by (kind, id) rather than by two
            -- nullable foreign keys, because a third referent is coming in M5
            -- (topics) and a fourth after it; the alternative grows a column
            -- per kind forever. The cost is no referential integrity here,
            -- which is acceptable for a log that must outlive what it refers to.
            ref_kind    text NOT NULL CHECK (ref_kind IN ('observation','proposal')),
            ref_id      uuid NOT NULL,

            -- Where the router decided this belonged, and why. Kept even when
            -- the two agree, because 'digest because it was quiet' and 'digest
            -- because it was minor' are different answers to the only question
            -- a user asks about a notification they did not get.
            route       text NOT NULL CHECK (route IN ('push','digest','feed_only')),
            reason      text NOT NULL
                        CHECK (reason IN ('above_floor','below_floor','quiet_hours','muted')),

            -- 'suppressed' is a successful outcome, not a failure: it means the
            -- policy said not to send, and the row exists to record that. Only
            -- 'failed' is a fault, and it keeps the error beside it so the
            -- answer to "why did this not arrive" does not require a log search
            -- against a retention window that may already have passed.
            status      text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','sent','failed','suppressed')),
            error       text,

            -- hash(channel, ref_kind, ref_id). Deliberately free of any time
            -- component: a key that varies with the clock deduplicates nothing,
            -- which is the failure it exists to prevent.
            dedupe_key  text NOT NULL UNIQUE,

            -- When it actually went out, which is not when the row was created:
            -- a digest entry is written the moment it is deferred and sent
            -- hours later, and the gap between the two is the latency the
            -- user experiences.
            sent_at     timestamptz,
            created_at  timestamptz NOT NULL DEFAULT now(),

            -- A message cannot have been sent at no particular time, and an
            -- unsent one cannot have a send time. Both halves are wrong in the
            -- same way: they make the timeline unreadable.
            CONSTRAINT notifications_sent_has_a_time
                CHECK ((status = 'sent') = (sent_at IS NOT NULL))
        )
        """
    )
    op.execute("CREATE INDEX notifications_recent_idx ON notifications (user_id, created_at DESC)")
    # The digest's own query: everything deferred and not yet rolled up. Partial,
    # because deferred-and-unsent is a small and short-lived slice of a table
    # that only grows.
    op.execute(
        """
        CREATE INDEX notifications_pending_digest_idx ON notifications (user_id, created_at)
            WHERE channel = 'digest' AND status = 'pending'
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS notifications")
