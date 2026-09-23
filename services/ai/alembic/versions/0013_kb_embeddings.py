"""The embedding column 0012 deliberately did not create (M3 slice 2).

0012 shipped the corpus with no `vector(n)` column at all, and said why: `n` is
fixed at column creation, pgvector builds its index per dimension, and correcting
a guess costs a migration plus a full re-embed. Nothing in slice 1 needed one, so
the number was deferred to the change that could choose it on evidence. This is
that change.

**`n` is 1536 because that is the width of `openai/text-embedding-3-small`**,
reached through OpenRouter, which is the model this corpus is intended to be
embedded by in production. It is recorded here rather than only in a settings
default so that the next person to read this column knows which model the number
came from, which is the question a width answers to and nothing else does.

It is emphatically **not** the width of the fixture embedder that CI runs. A
fixture can emit any dimension, so it exerts no pressure on the choice at all -
which is exactly what makes it easy to pick a convenient number here and discover
later that no real model has that width. The fixture is built to this number; the
number is not built to the fixture.

1536 also keeps the cheapest upgrade open: `text-embedding-3-large` is natively
3072 wide but supports Matryoshka truncation to 1536 through the `dimensions`
request parameter, so moving up a model later is a re-embed and not a migration.
A 1024-wide model would have closed that door for a marginal saving on a corpus
of 36 rows.

**`embedding_model` is stored beside the vector**, and it is what makes the owed
migration to the paid provider safe. A vector is meaningless without the model
that produced it: fixture vectors and OpenAI vectors are the same width and
cannot be compared, so a re-embed that left half the corpus behind would rank two
incomparable coordinate systems against each other and report the result as
relevance. With the model recorded per row, "embed everything this embedder did
not produce" is a `WHERE` clause rather than a thing an operator has to remember.

**Both columns are nullable, and a null embedding is a normal state.** Ingestion
writes chunks first and embeds after; an environment that has ingested but not
embedded serves concept chips perfectly well, because a chip is a slug lookup.
Making the column NOT NULL would make the embedder a hard dependency of loading a
document, which it is not.

**Cosine, not L2.** The embedder normalises to unit length, where the two orders
agree - but the index operator class is a commitment either way, and cosine is
what the retrieval SQL asks for and what every model in question documents as its
similarity measure. `vector_cosine_ops` is named in both places for the same
reason `'english'` is pinned in both halves of the full-text path: an index and a
query that disagree about the operator silently stop using the index rather than
failing.

Revision ID: 0013_kb_embeddings
Revises: 0012_kb_corpus
"""

from alembic import op

revision = "0013_kb_embeddings"
down_revision = "0012_kb_corpus"
branch_labels = None
depends_on = None

#: Width of `openai/text-embedding-3-small`. Mirrored by
#: `app.corpus.embeddings.EMBEDDING_DIMENSION`, and a contract test asserts the
#: two agree - a column and an embedder that disagree about the width fail at
#: INSERT time, in the ingester, on a machine that has a database.
EMBEDDING_DIMENSION = 1536


def upgrade() -> None:
    # The extension is created by 0001, which planned for this column two
    # milestones before it existed. Repeating it costs nothing and makes this
    # migration readable on its own.
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    op.execute(f"ALTER TABLE kb_chunks ADD COLUMN embedding vector({EMBEDDING_DIMENSION})")
    op.execute("ALTER TABLE kb_chunks ADD COLUMN embedding_model text")

    # A vector without the model that produced it is uninterpretable, and a
    # model name without a vector describes nothing. Neither half is useful
    # alone, so the pair is constrained rather than trusted to the one writer
    # that exists today.
    op.execute(
        """
        ALTER TABLE kb_chunks ADD CONSTRAINT kb_chunks_embedding_model_pair
            CHECK ((embedding IS NULL) = (embedding_model IS NULL))
        """
    )

    # HNSW rather than IVFFlat: IVFFlat's lists parameter has to be tuned to the
    # row count and the index rebuilt when the corpus grows, and a corpus that
    # is re-ingested on every stack start would carry a parameter chosen for the
    # size it had on the day someone last thought about it. HNSW needs no such
    # number and does not degrade as rows are added.
    op.execute(
        """
        CREATE INDEX kb_chunks_embedding_idx
            ON kb_chunks USING hnsw (embedding vector_cosine_ops)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX kb_chunks_embedding_idx")
    op.execute("ALTER TABLE kb_chunks DROP CONSTRAINT kb_chunks_embedding_model_pair")
    op.execute("ALTER TABLE kb_chunks DROP COLUMN embedding_model")
    op.execute("ALTER TABLE kb_chunks DROP COLUMN embedding")
