"""Auto-proposals that nobody answers expire, and say when (FR-11, M5).

At most three proposals may be open at once (`MAX_OPEN_PROPOSALS`), so before
this migration three ignored proposals stopped discovery for good: every later
run found no free slot and resolved nothing. An unanswered proposal now becomes
`status = 'expired'` once it is `TOPIC_PROPOSAL_TTL_DAYS` old, which frees its
slot.

**Expired is its own status, not a quiet delete and not a rejection.**

- Not deleted, for decision 18's ledger reason: a proposal that vanishes cannot
  be told apart afterwards from one that was never made. The row keeps its
  evidence and fingerprint, and `expired_at` says when it lapsed.
- Not `rejected`, because silence is not a "no". A rejection suppresses the
  theme for the whole rejection cooldown; an expired theme is held back only for
  one discovery window (`listKnownThemes`), so it can come back - but only on
  headlines that all postdate the user's silence, never the next morning.

The live-label unique index is rebuilt to leave expired rows out, exactly as it
leaves rejected ones out: a lapsed "uranium" must not stop the user from typing
a topic called "uranium", or discovery from proposing it again later.

Revision ID: 0021_topic_proposal_expiry
Revises: 0020_news_feed_cursors
"""

from alembic import op

revision = "0021_topic_proposal_expiry"
down_revision = "0020_news_feed_cursors"
branch_labels = None
depends_on = None

#: Topic statuses 0017 created.
PREVIOUS_STATUSES = ("active", "proposed", "rejected")

#: Statuses after this migration: the previous set plus a lapsed proposal.
STATUSES = (*PREVIOUS_STATUSES, "expired")


def _replace_status_check(statuses: tuple[str, ...]) -> None:
    """Point `topics_status_check` at exactly `statuses`."""
    op.execute("ALTER TABLE topics DROP CONSTRAINT IF EXISTS topics_status_check")
    op.execute(
        f"ALTER TABLE topics ADD CONSTRAINT topics_status_check "
        f"CHECK (status IN ({', '.join(repr(status) for status in statuses)}))"
    )


def _replace_live_label_index(dead: tuple[str, ...]) -> None:
    """Unique label per user among topics whose status is not in `dead`."""
    op.execute("DROP INDEX IF EXISTS topics_live_label_per_user")
    op.execute(
        f"""
        CREATE UNIQUE INDEX topics_live_label_per_user
            ON topics (user_id, lower(label))
         WHERE status NOT IN ({", ".join(repr(status) for status in dead)})
        """
    )


def upgrade() -> None:
    _replace_status_check(STATUSES)
    op.execute(
        """
        ALTER TABLE topics
            ADD COLUMN expired_at timestamptz,
            -- The same pairing as `rejected` and `rejected_at`: a lapsed
            -- proposal held back for a window measured from a missing time
            -- would be held back forever.
            ADD CONSTRAINT topics_expired_has_time
                CHECK ((status = 'expired') = (expired_at IS NOT NULL)),
            -- Only a proposal lapses. A topic the user chose is theirs until
            -- they remove it.
            ADD CONSTRAINT topics_expired_is_auto
                CHECK (status <> 'expired' OR created_by = 'auto')
        """
    )
    _replace_live_label_index(("rejected", "expired"))


def downgrade() -> None:
    # An expired proposal has no 0020 status. It becomes a rejection dated at
    # its expiry, which errs towards suppressing (decision 56): after a
    # downgrade the theme is held back for the rejection cooldown rather than
    # proposed again at once.
    #
    # The constraints go first: `topics_expired_has_time` refuses a row whose
    # status stops being 'expired' while `expired_at` is still set, which is
    # exactly the row the UPDATE writes. Found by downgrading over a real
    # expired row; an empty database downgrades cleanly either way.
    op.execute(
        """
        ALTER TABLE topics
            DROP CONSTRAINT topics_expired_is_auto,
            DROP CONSTRAINT topics_expired_has_time
        """
    )
    op.execute(
        """
        UPDATE topics
           SET status = 'rejected', rejected_at = expired_at, updated_at = now()
         WHERE status = 'expired'
        """
    )
    _replace_live_label_index(("rejected",))
    op.execute("ALTER TABLE topics DROP COLUMN expired_at")
    _replace_status_check(PREVIOUS_STATUSES)
