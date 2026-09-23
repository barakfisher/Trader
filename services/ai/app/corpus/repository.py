"""Reading the corpus back out: a concept by its slug.

Separate from `ingest.py` because the two have opposite shapes and opposite
risks. Ingestion writes, runs from a CLI, and may take its time; this runs on a
request path, reads one document, and must be fast and total - a slug that does
not exist is an ordinary answer, not an error condition.

There is deliberately no ranking here. A chip names exactly one concept, so
there is nothing to score and no relevance floor to apply: the lookup is an
equality test on an indexed column. Retrieval - hybrid, ranked, with a floor
below which the answer is "I don't have that indexed" - is what `/ask` will need,
and it is a different function rather than a parameter on this one.
"""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.corpus.documents import NAMESPACE_CONCEPTS
from app.models import ConceptDocumentResponse, ConceptSection


def concept_by_slug(connection: Connection, slug: str) -> ConceptDocumentResponse | None:
    """The concept document for `slug`, or None if the corpus has no such entry.

    Two statements rather than a join: a join would repeat the document's
    columns once per section and then need de-duplicating in Python, and the
    document row is the cheap half of the pair.
    """
    document = connection.execute(
        text(
            """
            SELECT id, concept_slug, title, source, uri, license
              FROM kb_documents
             WHERE namespace = :namespace
               AND concept_slug = :slug
            """
        ),
        {"namespace": NAMESPACE_CONCEPTS, "slug": slug},
    ).one_or_none()

    if document is None:
        return None

    sections = connection.execute(
        text(
            """
            SELECT id, ord, heading, text
              FROM kb_chunks
             WHERE document_id = :document_id
             ORDER BY ord
            """
        ),
        {"document_id": document.id},
    ).all()

    return ConceptDocumentResponse(
        slug=document.concept_slug,
        title=document.title,
        source=document.source,
        uri=document.uri,
        license=document.license,
        sections=[
            ConceptSection(id=str(row.id), ord=row.ord, heading=row.heading, text=row.text)
            for row in sections
        ],
    )


def concept_slugs(connection: Connection) -> list[str]:
    """Every slug the corpus can answer for, in alphabetical order.

    Exists so a caller can find out what is available without guessing, and so
    an operator can answer "did the corpus actually load?" with one request
    rather than a psql session.
    """
    rows = connection.execute(
        text(
            """
            SELECT concept_slug
              FROM kb_documents
             WHERE namespace = :namespace
               AND concept_slug IS NOT NULL
             ORDER BY concept_slug
            """
        ),
        {"namespace": NAMESPACE_CONCEPTS},
    ).all()
    return [row.concept_slug for row in rows]
