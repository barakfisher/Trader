"""Drop two indexes that no statement reads (decision 152, DB4).

- **`articles_content_hash_idx`**: 0004 expected content-hash lookups to be the
  dedupe hot path, but dedupe never looks a hash up. `load_known_hashes` reads
  the window's hashes once and the ingestion matches them in memory. A week of
  statistics showed the index never scanned on either environment, while every
  article insert (~5k a day on compose) paid for it: 6.9 MB.
- **`instrument_profiles_search_idx`**: a GIN index on `text_search` that
  nothing queries. The only `@@` in the code is on `kb_chunks`; topics reach
  instruments by embedding. 2.6 MB. The generated column stays: dropping it
  would rewrite the table for no reader either.

`intents_ledger_idx` has no reader either and is kept on purpose (decision 152).
The downgrade restores both indexes as 0004 and 0015 created them.

Revision ID: 0054_drop_unread_indexes
Revises: 0053_drop_profiles_hnsw
"""

from alembic import op

revision = "0054_drop_unread_indexes"
down_revision = "0053_drop_profiles_hnsw"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DROP INDEX IF EXISTS articles_content_hash_idx")
    op.execute("DROP INDEX IF EXISTS instrument_profiles_search_idx")


def downgrade() -> None:
    op.execute(
        "CREATE INDEX IF NOT EXISTS instrument_profiles_search_idx "
        "ON instrument_profiles USING GIN (text_search)"
    )
    op.execute("CREATE INDEX IF NOT EXISTS articles_content_hash_idx ON articles (content_hash)")
