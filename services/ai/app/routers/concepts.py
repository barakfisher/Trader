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

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.engine import Engine

from app.corpus.embeddings import BaseEmbedder
from app.corpus.repository import concept_by_slug, concept_slugs
from app.corpus.retrieval import hybrid_search
from app.corpus.vector_store import VectorStore
from app.db import get_engine
from app.deps import get_embedder, get_vector_store, require_internal_key
from app.models import ConceptDocumentResponse, ConceptSearchMatch, ConceptSearchResponse

router = APIRouter(tags=["concepts"], dependencies=[Depends(require_internal_key)])


@router.get("/concepts", response_model=list[str])
async def list_concepts(engine: Engine = Depends(get_engine)) -> list[str]:
    """Every concept the corpus can answer for."""
    with engine.connect() as connection:
        return concept_slugs(connection)


@router.get("/concepts/search", response_model=ConceptSearchResponse)
async def search_concepts(
    q: str = Query(description="A question or phrase to search the corpus for"),
    limit: int = Query(default=5, ge=1, le=20),
    engine: Engine = Depends(get_engine),
    store: VectorStore = Depends(get_vector_store),
    embedder: BaseEmbedder = Depends(get_embedder),
) -> ConceptSearchResponse:
    """Hybrid retrieval over the corpus: the half of `/ask` that finds things.

    **Declared before `/concepts/{slug}`, and that is load-bearing.** FastAPI
    matches routes in registration order, so a path parameter registered first
    would swallow `/concepts/search` as a request for a concept called "search" -
    which fails as a 404 naming a slug nobody asked for, and reads as a missing
    corpus rather than as a shadowed route.

    This exists in slice 2, before `/ask` in slice 3, on purpose. The hermetic
    Python suite has no Postgres and therefore cannot execute a line of the SQL
    underneath this - the same blind spot that shipped a namespace bug in slice 1
    - so the retrieval path needs a way to be exercised by hand against a real
    database *before* something else is built on top of it. It is a diagnostic
    surface, not a product feature: no relevance floor, no refusal, no intent
    routing. Those are judgements `/ask` makes, and making them here as well
    would put them in two places at once.
    """
    with engine.connect() as connection:
        result = await hybrid_search(connection, store, embedder, query=q, limit=limit)

    return ConceptSearchResponse(
        query=result.query,
        matches=[
            ConceptSearchMatch(
                chunk_id=chunk.chunk_id,
                document_id=chunk.document_id,
                concept_slug=chunk.concept_slug,
                title=chunk.title,
                heading=chunk.heading,
                ord=chunk.ord,
                text=chunk.text,
                score=chunk.score,
                vector_rank=chunk.vector_rank,
                text_rank=chunk.text_rank,
            )
            for chunk in result.chunks
        ],
        embedding_model=result.embedding_model,
        vector_is_semantic=result.vector_is_semantic,
    )


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
