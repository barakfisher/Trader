"""Where a file-based news feed has read up to (GDELT raw files, decision 52).

GDELT publishes a Global Knowledge Graph file every 15 minutes. A collection run
reads the files published since the last run, so it needs to know which one that
was. One row per provider: `last_file_at` is the slot of the newest file that
was read, or passed over as missing, by a run that committed.

**Written in the same transaction as the articles.** A run that fails before it
stores anything rolls the cursor back with it, so no file is marked read
without its articles being kept - and a file is never read twice, because a
committed run moved the cursor past it.

**No `user_id`** (guideline 5 is about user-owned rows): the feed is shared
market data, like `articles`, and one installation reads it once for everybody.

The alternative was no table - each run re-reading the last hour of files and
letting the url hash drop what it had seen. Rejected with the user on
2026-09-27: it doubles the downloads (about 300 MB a day becomes 600 MB), and
an outage longer than the overlap loses news without anything saying so.

Revision ID: 0020_news_feed_cursors
Revises: 0019_topic_discovery
"""

from alembic import op

revision = "0020_news_feed_cursors"
down_revision = "0019_topic_discovery"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE news_feed_cursors (
            provider     text PRIMARY KEY,
            last_file_at timestamptz NOT NULL,
            updated_at   timestamptz NOT NULL DEFAULT now()
        )
        """
    )


def downgrade() -> None:
    # The next run starts from its initial window again; nothing else is lost.
    op.execute("DROP TABLE news_feed_cursors")
