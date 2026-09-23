"""The other end of a concept chip (FR-16, M3).

Since M2 every observation has carried `concept_refs` and they have rendered as
dead labels, because there was nothing to click through to. This is what they
point at.

Served from this service rather than the orchestrator for the same reason as
narration config: the corpus belongs here. The AI service owns the schema, the
ingester, and - when `/ask` lands - the retrieval that will read these same
tables. A second reader of `kb_chunks` in another process would be a second
place that has to agree about chunk ordering and namespace filtering.

A missing slug is a plain 404 with the concept named. It is a real condition
rather than a bug: the corpus is data, an environment may not have ingested it
yet, and the orchestrator turns this into a message that says so rather than
into a broken page.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.engine import Engine

from app.corpus.repository import concept_by_slug, concept_slugs
from app.db import get_engine
from app.deps import require_internal_key
from app.models import ConceptDocumentResponse

router = APIRouter(tags=["concepts"], dependencies=[Depends(require_internal_key)])


@router.get("/concepts", response_model=list[str])
async def list_concepts(engine: Engine = Depends(get_engine)) -> list[str]:
    """Every concept the corpus can answer for."""
    with engine.connect() as connection:
        return concept_slugs(connection)


@router.get("/concepts/{slug}", response_model=ConceptDocumentResponse)
async def get_concept(slug: str, engine: Engine = Depends(get_engine)) -> ConceptDocumentResponse:
    with engine.connect() as connection:
        document = concept_by_slug(connection, slug)

    if document is None:
        raise HTTPException(
            status_code=404,
            detail=f"no concept document for {slug!r}; the corpus may not have been ingested",
        )
    return document
