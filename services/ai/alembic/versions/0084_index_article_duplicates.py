"""Index `articles.duplicate_of_id`, the key the market feed's prune deletes through (D377).

0004 made it `REFERENCES articles(id) ON DELETE SET NULL` with no index, so each
deleted article made Postgres scan the whole table for copies pointing at it.
Measured 2026-11-03: the first prune after D373 had 89,479 rows to delete on
compose's 114,925-row table and ran 22 minutes inside an assistant's `get_news`;
on a copy, 2,000 deletes took 4.9 s without the index and 40 ms with it.

A plain `CREATE INDEX`, not `CONCURRENTLY`: the table is at most ~115k rows and
builds in well under a second, and a concurrent build cannot run inside the
migration's transaction.

Revision ID: 0084_index_article_duplicates
Revises: 0083_drop_github_identities
"""

from alembic import op

revision = "0084_index_article_duplicates"
down_revision = "0083_drop_github_identities"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE INDEX articles_duplicate_of_idx ON articles (duplicate_of_id)")


def downgrade() -> None:
    op.execute("DROP INDEX articles_duplicate_of_idx")
