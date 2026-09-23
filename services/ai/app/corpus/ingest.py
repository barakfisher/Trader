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
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.corpus.documents import CorpusDocument

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
                       text    = EXCLUDED.text
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
