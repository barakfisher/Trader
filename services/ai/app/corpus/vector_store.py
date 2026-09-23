"""Where vectors are written and how they are searched: the `VectorStore` seam.

DESIGN.md's table names this interface and the reason for it: pgvector lives
inside Postgres so there is one fewer container and writes are transactional with
the rest of the domain, and Qdrant remains a drop-in swap if hybrid search ever
outgrows it. That swap is only actually available if nothing above this file
knows what backs it, which is what the Protocol is for.

**What is embedded is the chunk text, and nothing else.** Not the heading, for
the reason `documents.py` gives for keeping it out of `text_search`: all nine
concept documents carry the same four headings, so folding them in would add the
same four phrases to every vector - noise in the ranking with no power to tell
documents apart. Not the document title either, even though a title is genuinely
discriminative, because the title is deliberately outside the content hash
(decision 25: correcting a typo in a title must not churn chunk ids) and an
embedding built from it would silently go stale on exactly the edit that was
designed not to touch chunks. Embedding precisely what `text_search` indexes also
keeps the two halves of the hybrid answering the same question about the same
text.

**Staleness is not tracked here; it is made impossible upstream.** `ingest.py`
nulls a chunk's embedding in the same statement that rewrites its text, so
"needs embedding" is `embedding IS NULL` plus "was produced by a different
model", and there is no third case where a vector survives the text it describes.
A store that had to compare hashes to find that out would be a second place that
has to agree about what a chunk is.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.corpus.documents import NAMESPACE_CONCEPTS
from app.corpus.embeddings import EMBEDDING_DIMENSION, Embedding


@dataclass(frozen=True, slots=True)
class PendingChunk:
    """A stored chunk with no usable embedding, and the text to embed for it."""

    id: str
    text: str


@dataclass(frozen=True, slots=True)
class VectorMatch:
    """One chunk the vector half returned, with everything a citation needs.

    `similarity` is cosine similarity in [-1, 1], not the distance pgvector
    actually computes. The conversion happens in the SQL so that every caller
    reads a number that rises with relevance: a raw distance falls with it, and a
    ranking that sorts the wrong way is the single easiest mistake to make here
    and among the hardest to notice, because a reversed ordering still returns
    plausible rows.
    """

    chunk_id: str
    document_id: str
    concept_slug: str | None
    title: str
    heading: str | None
    ord: int
    text: str
    similarity: float


@dataclass(frozen=True, slots=True)
class EmbeddingCoverage:
    """How much of a namespace is embedded, and by what.

    Exists so `--dry-run` can answer "is the database in step with the files?"
    for vectors as well as for text. Slice 1 learned that a derived copy nobody
    can interrogate drifts silently; an embedding is a second derived copy of
    the same text and has the same failure.
    """

    total: int
    embedded: int
    models: tuple[str, ...]

    @property
    def pending(self) -> int:
        return self.total - self.embedded


@runtime_checkable
class VectorStore(Protocol):
    """Writes embeddings for stored chunks and searches them by similarity."""

    def pending_chunks(
        self, connection: Connection, *, model: str, namespace: str = NAMESPACE_CONCEPTS
    ) -> list[PendingChunk]:
        """Chunks with no embedding, or one produced by a different model."""
        ...

    def store_embeddings(
        self, connection: Connection, *, model: str, embeddings: list[tuple[str, Embedding]]
    ) -> int:
        """Write `(chunk_id, vector)` pairs, returning how many rows changed."""
        ...

    def search(
        self,
        connection: Connection,
        *,
        embedding: Embedding,
        limit: int,
        namespace: str = NAMESPACE_CONCEPTS,
        model: str | None = None,
    ) -> list[VectorMatch]:
        """The `limit` most similar chunks, most similar first."""
        ...

    def coverage(
        self, connection: Connection, *, namespace: str = NAMESPACE_CONCEPTS
    ) -> EmbeddingCoverage:
        """How many chunks in `namespace` are embedded, and by which models."""
        ...


def to_pgvector(embedding: Embedding) -> str:
    """Render a vector in the literal form pgvector parses.

    A string rather than a bound array: the driver has no type for `vector`, so
    the value crosses as text and is cast in the statement. `repr` on a float is
    round-trip exact in Python, which matters because a truncated coordinate is a
    silently different vector rather than an error.
    """
    if len(embedding) != EMBEDDING_DIMENSION:
        # Caught here rather than by Postgres, because the database's message
        # names the column and not the embedder, and the embedder is what is
        # wrong. This is the check that makes a mis-sized future provider fail on
        # its first call instead of partway through a corpus.
        raise ValueError(
            f"embedding has {len(embedding)} dimensions, expected {EMBEDDING_DIMENSION}"
        )
    return "[" + ",".join(repr(float(component)) for component in embedding) + "]"


class PgVectorStore:
    """`VectorStore` backed by the `vector` column on `kb_chunks`.

    Every method takes the connection rather than holding one, so a write shares
    the caller's transaction exactly as `ingest.py` does: embedding a corpus is
    part of ingesting it, and a half-embedded corpus left behind by a crash
    between two transactions is a state nothing else in this system can produce.
    """

    name = "pgvector"

    def pending_chunks(
        self, connection: Connection, *, model: str, namespace: str = NAMESPACE_CONCEPTS
    ) -> list[PendingChunk]:
        rows = connection.execute(
            text(
                """
                SELECT c.id, c.text
                  FROM kb_chunks c
                  JOIN kb_documents d ON d.id = c.document_id
                 WHERE d.namespace = :namespace
                   AND (c.embedding IS NULL OR c.embedding_model IS DISTINCT FROM :model)
                 ORDER BY d.concept_slug, c.ord
                """
            ),
            {"namespace": namespace, "model": model},
        ).all()
        return [PendingChunk(id=str(row.id), text=row.text) for row in rows]

    def store_embeddings(
        self, connection: Connection, *, model: str, embeddings: list[tuple[str, Embedding]]
    ) -> int:
        written = 0
        for chunk_id, embedding in embeddings:
            result = connection.execute(
                text(
                    """
                    UPDATE kb_chunks
                       SET embedding = CAST(:embedding AS vector),
                           embedding_model = :model
                     WHERE id = :id
                    """
                ),
                {"id": chunk_id, "embedding": to_pgvector(embedding), "model": model},
            )
            written += result.rowcount if result.rowcount and result.rowcount > 0 else 0
        return written

    def search(
        self,
        connection: Connection,
        *,
        embedding: Embedding,
        limit: int,
        namespace: str = NAMESPACE_CONCEPTS,
        model: str | None = None,
    ) -> list[VectorMatch]:
        """Nearest neighbours by cosine distance, joined to their documents.

        `model` filters to rows embedded by one embedder and defaults to no
        filter. The caller that searches always passes it, because comparing a
        query vector against rows produced by a *different* model is the one way
        this table can return confident nonsense: the widths match, the operator
        works, the distances are meaningless. Leaving the parameter optional
        keeps the interface usable for an operator asking "what is in here?"
        without having to name an embedder first.
        """
        rows = connection.execute(
            text(
                """
                SELECT c.id            AS chunk_id,
                       d.id            AS document_id,
                       d.concept_slug  AS concept_slug,
                       d.title         AS title,
                       c.heading       AS heading,
                       c.ord           AS ord,
                       c.text          AS text,
                       -- `<=>` is cosine DISTANCE: 0 identical, 2 opposite. The
                       -- ORDER BY below must stay on the raw operator for the
                       -- HNSW index to be used at all; the subtraction is only
                       -- for the value the caller reads.
                       1 - (c.embedding <=> CAST(:embedding AS vector)) AS similarity
                  FROM kb_chunks c
                  JOIN kb_documents d ON d.id = c.document_id
                 WHERE d.namespace = :namespace
                   AND c.embedding IS NOT NULL
                   -- Cast, because an optional parameter compared only to
                   -- NULL gives Postgres nothing to infer a type from and the
                   -- statement is rejected outright (`could not determine data
                   -- type of parameter`). It is invisible to every test in the
                   -- hermetic suite and fails on the first real query.
                   AND (CAST(:model AS text) IS NULL OR c.embedding_model = :model)
                 ORDER BY c.embedding <=> CAST(:embedding AS vector)
                 LIMIT :limit
                """
            ),
            {
                "embedding": to_pgvector(embedding),
                "namespace": namespace,
                "model": model,
                "limit": limit,
            },
        ).all()

        return [
            VectorMatch(
                chunk_id=str(row.chunk_id),
                document_id=str(row.document_id),
                concept_slug=row.concept_slug,
                title=row.title,
                heading=row.heading,
                ord=row.ord,
                text=row.text,
                similarity=float(row.similarity),
            )
            for row in rows
        ]

    def coverage(
        self, connection: Connection, *, namespace: str = NAMESPACE_CONCEPTS
    ) -> EmbeddingCoverage:
        row = connection.execute(
            text(
                """
                SELECT count(*)                       AS total,
                       count(c.embedding)             AS embedded,
                       array_remove(
                           array_agg(DISTINCT c.embedding_model), NULL
                       )                              AS models
                  FROM kb_chunks c
                  JOIN kb_documents d ON d.id = c.document_id
                 WHERE d.namespace = :namespace
                """
            ),
            {"namespace": namespace},
        ).one()
        return EmbeddingCoverage(
            total=int(row.total),
            embedded=int(row.embedded),
            models=tuple(sorted(row.models or ())),
        )
