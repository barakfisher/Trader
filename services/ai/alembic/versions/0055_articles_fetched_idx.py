"""Index `articles.fetched_at` for the news collector's window read (decision 154, DB4).

`load_known_hashes` asks for every article fetched in the last 48 hours on each
collect, every 30 minutes. With no index on `fetched_at` each ask read the whole
table: on compose, the week's top statement from the app (133 calls, 149 ms
mean) and 27 M rows read sequentially. Nothing prunes linked articles, so that
cost grew with the table (44k -> 86k rows in nine days).

Plain, not covering. Measured on a copy of compose restored from a dump
(85,251 articles, a 10,708-row window): the full scan took 101 ms cold and
20 ms warm; `(fetched_at) INCLUDE (url_hash, content_hash)` took 8.7 / 1.6 ms
at 15 MB; this index took 4.8 / 2.4 ms at 616 kB. Rows arrive in `fetched_at`
order, so the heap pages a window needs are few and adjacent, and copying the
two hashes into the index buys nothing.

A plain `CREATE INDEX` (not `CONCURRENTLY`, which cannot run inside the
migration's transaction): it holds writes to `articles` for well under a second
at this size, and a collect that meets the lock waits rather than fails.

Revision ID: 0055_articles_fetched_idx
Revises: 0054_drop_unread_indexes
"""

from alembic import op

revision = "0055_articles_fetched_idx"
down_revision = "0054_drop_unread_indexes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE INDEX IF NOT EXISTS articles_fetched_idx ON articles (fetched_at)")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS articles_fetched_idx")
