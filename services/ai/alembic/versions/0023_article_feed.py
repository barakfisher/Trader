"""Record which feed let an article in: the followed names, or the market filter.

Until now every article was collected because its headline named something the
user follows, and "linked to nothing" meant noise - the 77 body-text matches the
old search API stored (decision 55), which discovery skips. The market feed
(decision 60) stores articles about markets in general, most of them linked to
nothing followed and all of them meant for discovery. The two kinds of unlinked
article must not be told apart by guesswork, so the article says which door it
came in by.

`feed` is where the article came from, not what it is about: a market article
naming a held company is linked by the matcher like any other, and every
user-facing read (topic news, sentiment, evidence) still goes through
`article_entities`, so an unlinked market article cannot reach one.

Existing rows are `followed`, which is how each of them was collected. Unlinked
market articles are pruned by the collection run after discovery's window plus
a proposal's lifetime; the downgrade removes all of them, because without the
column they would read as the old noise and be indistinguishable from it.

Revision ID: 0023_article_feed
Revises: 0022_narration_transitions
"""

from alembic import op

revision = "0023_article_feed"
down_revision = "0022_narration_transitions"
branch_labels = None
depends_on = None

#: `RawArticle.market` stored: `market` when the market filter kept it.
FEEDS = ("followed", "market")


def upgrade() -> None:
    feeds = ", ".join(repr(feed) for feed in FEEDS)
    op.execute(
        f"""
        ALTER TABLE articles
            ADD COLUMN feed text NOT NULL DEFAULT 'followed'
                CONSTRAINT articles_feed_check CHECK (feed IN ({feeds}))
        """
    )


def downgrade() -> None:
    # A market article linked to something followed would have been collected by
    # the followed feed too, so it stays; the rest are the feed's own and go.
    op.execute(
        """
        DELETE FROM articles a
         WHERE a.feed = 'market'
           AND NOT EXISTS (SELECT 1 FROM article_entities e WHERE e.article_id = a.id)
        """
    )
    op.execute("ALTER TABLE articles DROP COLUMN feed")
