"""Drop the HNSW index on `instrument_profiles.embedding` (decision 151, DB4).

A week of statistics (2026-10-11 to 10-18) showed the index never scanned on
either environment although its one reader, topic matching's
`search_profiles`, ran nine times on compose. The planner was right to refuse
it: at 5,223 vectors an exact scan answered the LIMIT 200 search in 264 ms
with all 200 rows, and the index, forced, took 2.8 s and returned 199 - an HNSW
scan is approximate and filters after it searches. It was 41 MB on each
environment, about 40% of the table, and every embedding write paid for it.

Revisit if the screened universe grows past roughly 50k profiles; the
downgrade is the same statement 0015 used, and builds in seconds at this size.
`search_profiles` keeps raising `hnsw.ef_search`, which costs nothing without
the index and keeps a rebuilt one honest.

Revision ID: 0053_drop_profiles_hnsw
Revises: 0052_assistant
"""

from alembic import op

revision = "0053_drop_profiles_hnsw"
down_revision = "0052_assistant"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DROP INDEX IF EXISTS instrument_profiles_embedding_idx")


def downgrade() -> None:
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS instrument_profiles_embedding_idx
            ON instrument_profiles USING hnsw (embedding vector_cosine_ops)
        """
    )
