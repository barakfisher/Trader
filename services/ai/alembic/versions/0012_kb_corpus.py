"""The concept corpus: what a chip points at (M3).

Since M2 every observation has carried `concept_refs` - `drawdown`,
`z-score`, `portfolio-weight` - and there has been nothing on the other end of
them. This is the other end.

**Two tables, and deliberately no embedding column.** DESIGN.md section on RAG
specifies `kb_chunks(..., embedding vector, ...)`, and that column arrives with
the milestone's second change rather than this one. A `vector(n)` column is a
commitment to a particular embedding model: `n` is fixed at creation, pgvector's
HNSW index is built per dimension, and correcting a guess costs a migration plus
a full re-embed of the corpus. No embedding provider has been chosen yet, so the
number would be invented. Nothing in this change needs one - a concept link is
an exact slug lookup, and the full-text index below already supports keyword
search - so the column is deferred to the change that can choose `n` on
evidence.

**Full-text search is here rather than later** because it is free: it is derived
from `text` by a generated column, so it cannot drift from the text it indexes,
and it gives hybrid retrieval one of its two halves before the other exists.

**Neither table carries `user_id`, and that is intentional.** This is shared
reference material - definitions of `drawdown` and `rebalancing` are not one
account's property any more than `instruments` or `quotes` are. It is recorded
here so a later audit against project guideline 5 reads this line instead of
re-opening the question.

Revision ID: 0012_kb_corpus
Revises: 0011_narration_provenance
"""

from alembic import op

revision = "0012_kb_corpus"
down_revision = "0011_narration_provenance"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE kb_documents (
            id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

            -- Definitions and ingested article text never mix (DESIGN.md: the
            -- corpus keeps them in separate namespaces). A concept answer built
            -- partly from last week's market commentary is not a definition any
            -- more, and the reader cannot tell which half they are reading.
            namespace     text NOT NULL CHECK (namespace IN ('concepts', 'news')),

            -- The handle an observation already uses. Null outside the
            -- `concepts` namespace, because an article explains nothing in
            -- particular.
            concept_slug  text,

            title         text NOT NULL,

            -- Where the text came from, and on what terms. `license` is NOT
            -- NULL with no default on purpose: the corpus is required to be
            -- licence-clean, and a default would let an unexamined document in
            -- by saying nothing.
            source        text NOT NULL,
            uri           text,
            license       text NOT NULL,

            -- Of the chunk text, so re-ingesting an unchanged document is a
            -- comparison rather than a delete and a re-insert. Re-chunking a
            -- document changes every chunk id, and an id that churns on every
            -- run cannot be cited.
            content_hash  text NOT NULL,

            created_at    timestamptz NOT NULL DEFAULT now(),
            updated_at    timestamptz NOT NULL DEFAULT now()
        )
        """
    )

    # One document per concept. Two documents answering to `drawdown` would make
    # "one click to an explanation" a choice between two explanations, which is
    # the thing FR-16 exists to avoid.
    op.execute(
        """
        CREATE UNIQUE INDEX kb_documents_concept_idx
            ON kb_documents (concept_slug)
         WHERE concept_slug IS NOT NULL
        """
    )
    op.execute("CREATE INDEX kb_documents_namespace_idx ON kb_documents (namespace)")

    op.execute(
        """
        CREATE TABLE kb_chunks (
            id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            document_id  uuid NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,

            -- Position within the document. A citation reads "section 2 of
            -- Drawdown", so the order has to be a stored fact rather than
            -- whatever order a SELECT happened to return.
            ord          integer NOT NULL,

            -- The heading the chunk was found under, kept because chunking is
            -- structure-aware and the heading is most of what tells a reader
            -- what they are looking at.
            heading      text,

            text         text NOT NULL,
            metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,

            -- Generated, not written: a column the ingester has to remember to
            -- update is a column that will one day index text the document no
            -- longer contains. 'english' is pinned here and in every query that
            -- reads it; a mismatch between the two silently returns nothing.
            text_search  tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,

            created_at   timestamptz NOT NULL DEFAULT now()
        )
        """
    )

    op.execute("CREATE UNIQUE INDEX kb_chunks_document_ord_idx ON kb_chunks (document_id, ord)")
    op.execute("CREATE INDEX kb_chunks_search_idx ON kb_chunks USING GIN (text_search)")


def downgrade() -> None:
    op.execute("DROP TABLE kb_chunks")
    op.execute("DROP TABLE kb_documents")
