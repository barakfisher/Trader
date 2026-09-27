"""Allow 'news_collect' as a run kind, and settle how news reaches a topic.

The news pipeline (`app/news`) was built in M2 and never given a caller: no run
kind, no route, no timer, so `articles` has been empty in every installation.
This run is the caller. It goes through `POST /internal/runs` like all
scheduled work, and the constraint is extended the way 0010 extended it:
`KINDS` is the previous tuple plus this one's addition, never a retyped literal.

**The promise from 0004, decided rather than deferred again.** 0004 stored a
topic link as a free-text `topic_ref` and said a later migration would backfill
a `topic_id` key; 0017 passed that on to topicScan. The decision is to add no
`topic_id` at all. `articles` and `article_entities` are shared market data with
no `user_id`, and a topic is one user's choice: a foreign key from a shared row
to a user-owned row would make the news corpus per-user by the back door. A
topic's news is instead derived at read time - articles linked to its confirmed
instruments, through `topic_instruments`, which is user-scoped. `topic_ref`
stays, unused, for articles that a query-based provider finds by theme and that
name no instrument; that is the GDELT slice's to design.

Revision ID: 0018_news_collect
Revises: 0017_topics
"""

from alembic import op

revision = "0018_news_collect"
down_revision = "0017_topics"
branch_labels = None
depends_on = None

#: The run kinds 0010 left behind.
PREVIOUS_KINDS = (
    "snapshot",
    "portfolio_scan",
    "topic_scan",
    "daily_digest",
    "backfill",
    "proposal_sweep",
    "instrument_metadata",
)

#: Kinds after this migration: the previous set plus news collection.
KINDS = (*PREVIOUS_KINDS, "news_collect")


def _replace_run_kind_check(kinds: tuple[str, ...]) -> None:
    """Point `runs_kind_check` at exactly `kinds`."""
    op.execute("ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_kind_check")
    op.execute(
        f"ALTER TABLE runs ADD CONSTRAINT runs_kind_check "
        f"CHECK (kind IN ({', '.join(repr(kind) for kind in kinds)}))"
    )


def upgrade() -> None:
    _replace_run_kind_check(KINDS)


def downgrade() -> None:
    # Bookkeeping only: the articles a run collected are kept.
    op.execute("DELETE FROM runs WHERE kind = 'news_collect'")
    _replace_run_kind_check(PREVIOUS_KINDS)
