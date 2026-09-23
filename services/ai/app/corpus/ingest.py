"""Write parsed documents into `kb_documents` / `kb_chunks`, changing as little as possible.

Ingestion runs whenever the corpus is edited, and on every fresh environment. The
obvious implementation - delete the document's chunks and insert them again - is
cheap to write and wrong in a way that only shows up later: **a chunk id is what
a citation points at**, and an id that is replaced on every run cannot be cited
by anything that outlives the run.

So this module compares before it writes, at two levels.

**Document level, by content hash.** The hash covers every chunk's text, heading
and position. When it matches what is stored, the document's chunks are not
touched at all - not re-read, not re-inserted. Re-ingesting an unchanged corpus
therefore performs no writes, which is what makes it safe to run on every boot.

**Chunk level, by position.** When the hash does differ, only the sections that
actually changed are rewritten: chunks are upserted on `(document_id, ord)`, the
update is guarded so an identical row is left alone, and chunks beyond the new
end are deleted. Editing one paragraph of one section leaves the other three
sections' ids intact.

The limit of that is worth stating: inserting a new section in the middle shifts
every following `ord`, so their content no longer matches their position and they
are rewritten. Stable ids under reordering would need a content-addressed key
instead of a positional one, which trades a different problem - two sections with
identical text would collide - and is not worth it for documents whose shape is
fixed by a test.

Metadata is handled separately from content on purpose. Correcting a typo in a
title updates the document row and leaves every chunk id alone, because the title
is not part of what a chunk says.

**Embedding is a third pass and a separate function** (`embed_pending`), not a
step inside the two above. The content hash means an unchanged document is never
re-read, so an embedding step folded into it could never catch up a corpus that
was ingested before any embedder existed - which is the state of every
installation that ran slice 1. Its docstring has the rest of the argument.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.corpus.documents import NAMESPACE_CONCEPTS, CorpusDocument
from app.corpus.embeddings import BaseEmbedder, EmbeddingError
from app.corpus.vector_store import VectorStore

#: What happened to one document. `unchanged` means no statement was executed
#: against it, which is the expected outcome for most of a re-run.
Outcome = Literal["created", "updated", "metadata", "unchanged"]

_METADATA_FIELDS = ("title", "source", "uri", "license")


@dataclass(frozen=True, slots=True)
class DocumentResult:
    """The outcome for one document, and how much of it was rewritten."""

    slug: str
    outcome: Outcome
    chunks_written: int = 0
    chunks_removed: int = 0


def _metadata_differs(document: CorpusDocument, row: object) -> bool:
    return any(getattr(row, field) != getattr(document, field) for field in _METADATA_FIELDS)


def _write_chunks(
    connection: Connection, document_id: str, document: CorpusDocument
) -> tuple[int, int]:
    """Upsert the document's chunks by position; drop any left beyond the end."""
    written = 0
    for chunk in document.chunks:
        result = connection.execute(
            text(
                """
                INSERT INTO kb_chunks (document_id, ord, heading, text)
                VALUES (:document_id, :ord, :heading, :text)
                ON CONFLICT (document_id, ord) DO UPDATE
                   SET heading = EXCLUDED.heading,
                       text    = EXCLUDED.text,
                       -- An embedding describes the text it was made from, so
                       -- rewriting the text without clearing the vector leaves a
                       -- row that retrieval will happily rank on a paragraph the
                       -- document no longer contains. Cleared here, in the same
                       -- statement, rather than by a later pass that has to
                       -- remember: this is what makes `embedding IS NULL` the
                       -- complete definition of "needs embedding".
                       --
                       -- Conditional, because the heading is not embedded (see
                       -- vector_store.py), so a heading-only edit must not
                       -- discard a vector that is still accurate.
                       embedding = CASE
                           WHEN kb_chunks.text IS DISTINCT FROM EXCLUDED.text
                           THEN NULL ELSE kb_chunks.embedding END,
                       embedding_model = CASE
                           WHEN kb_chunks.text IS DISTINCT FROM EXCLUDED.text
                           THEN NULL ELSE kb_chunks.embedding_model END
                 WHERE kb_chunks.text    IS DISTINCT FROM EXCLUDED.text
                    OR kb_chunks.heading IS DISTINCT FROM EXCLUDED.heading
                """
            ),
            {
                "document_id": document_id,
                "ord": chunk.ord,
                "heading": chunk.heading,
                "text": chunk.text,
            },
        )
        # DO UPDATE ... WHERE that matches nothing reports zero rows, which is
        # exactly the count we want: rows genuinely written.
        written += result.rowcount if result.rowcount and result.rowcount > 0 else 0

    ords = [chunk.ord for chunk in document.chunks]
    removed = connection.execute(
        text("DELETE FROM kb_chunks WHERE document_id = :document_id AND ord <> ALL(:ords)"),
        {"document_id": document_id, "ords": ords},
    )
    return written, (removed.rowcount if removed.rowcount and removed.rowcount > 0 else 0)


def ingest_document(connection: Connection, document: CorpusDocument) -> DocumentResult:
    """Bring one document's stored form in line with `document`.

    Runs inside the caller's transaction; it never commits, so a failure part way
    through a corpus leaves the whole corpus as it was.
    """
    slug = document.concept_slug or document.title

    existing = connection.execute(
        text(
            """
            SELECT id, content_hash, title, source, uri, license
              FROM kb_documents
             WHERE namespace = :namespace
               AND concept_slug IS NOT DISTINCT FROM :concept_slug
            """
        ),
        {"namespace": document.namespace, "concept_slug": document.concept_slug},
    ).one_or_none()

    if existing is None:
        document_id = connection.execute(
            text(
                """
                INSERT INTO kb_documents
                    (namespace, concept_slug, title, source, uri, license, content_hash)
                VALUES
                    (:namespace, :concept_slug, :title, :source, :uri, :license, :content_hash)
                RETURNING id
                """
            ),
            {
                "namespace": document.namespace,
                "concept_slug": document.concept_slug,
                "title": document.title,
                "source": document.source,
                "uri": document.uri,
                "license": document.license,
                "content_hash": document.content_hash,
            },
        ).scalar_one()
        written, removed = _write_chunks(connection, str(document_id), document)
        return DocumentResult(slug, "created", written, removed)

    content_changed = existing.content_hash != document.content_hash
    metadata_changed = _metadata_differs(document, existing)

    if not content_changed and not metadata_changed:
        return DocumentResult(slug, "unchanged")

    connection.execute(
        text(
            """
            UPDATE kb_documents
               SET title = :title, source = :source, uri = :uri, license = :license,
                   content_hash = :content_hash, updated_at = now()
             WHERE id = :id
            """
        ),
        {
            "id": existing.id,
            "title": document.title,
            "source": document.source,
            "uri": document.uri,
            "license": document.license,
            "content_hash": document.content_hash,
        },
    )

    if not content_changed:
        return DocumentResult(slug, "metadata")

    written, removed = _write_chunks(connection, str(existing.id), document)
    return DocumentResult(slug, "updated", written, removed)


def ingest_documents(
    connection: Connection, documents: list[CorpusDocument]
) -> list[DocumentResult]:
    """Ingest every document in one transaction, in the order given."""
    return [ingest_document(connection, document) for document in documents]


@dataclass(frozen=True, slots=True)
class EmbeddingResult:
    """What one embedding pass did, and with which model."""

    model: str
    chunks_embedded: int


async def embed_pending(
    connection: Connection,
    store: VectorStore,
    embedder: BaseEmbedder,
    *,
    namespace: str = NAMESPACE_CONCEPTS,
    batch_size: int = 64,
) -> EmbeddingResult:
    """Embed every chunk that has no vector from `embedder`'s model.

    Separate from `ingest_document` rather than folded into it, for two reasons
    that pull the same way. A document whose content did not change is never
    re-read by the ingester at all - that is the whole point of the content hash
    - so an embedding step living inside it could never catch up a corpus that
    was ingested before an embedder existed, which is precisely the state every
    installation is in right now. And embedding is the only part of ingestion
    that may reach the network, so it is the part that should be identifiable in
    a traceback and skippable by a caller that does not want it.

    Idempotent for the same reason the rest of ingestion is: a second run finds
    nothing pending and issues no statements. Runs inside the caller's
    transaction and never commits.

    Batched because a paid provider charges per request as well as per token and
    embeds a list in one call. The fixture ignores the batching entirely, which
    is the point of doing it at this layer instead of inside an adapter.
    """
    pending = store.pending_chunks(connection, model=embedder.model, namespace=namespace)
    if not pending:
        return EmbeddingResult(embedder.model, 0)

    written = 0
    for start in range(0, len(pending), batch_size):
        batch = pending[start : start + batch_size]
        vectors = await embedder.embed_documents([chunk.text for chunk in batch])
        if len(vectors) != len(batch):
            # The interface promises one vector per input. A provider that
            # breaks that promise would misattribute every vector after the
            # missing one - a corpus where `drawdown` is indexed under
            # `rebalancing`, which no test downstream could distinguish from a
            # bad model. Refused rather than zipped.
            raise EmbeddingError(
                f"{embedder.model} returned {len(vectors)} vectors for {len(batch)} texts"
            )
        written += store.store_embeddings(
            connection,
            model=embedder.model,
            embeddings=list(zip([chunk.id for chunk in batch], vectors, strict=True)),
        )

    return EmbeddingResult(embedder.model, written)
