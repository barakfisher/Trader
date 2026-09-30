"""`POST /ask` (FR-17, M3 slice 3): a question in, a checkable answer out.

Thin, like every router here. Routing, the relevance floor and the arithmetic
live in `app/ask`; this converts the wire shape to that package's shape and back.

**A refusal is a 200.** `answered: false` with a `refused_reason` is an outcome,
not a fault: the milestone's exit criterion names refusing out-of-index questions
as something the product must do *well*, and a 4xx would make a correct refusal
indistinguishable from a broken corpus to every caller and every dashboard.

**The LLM is optional and its absence is not an error.** With no model
configured the answer is the retrieved passages verbatim, which is a complete
answer with better provenance than a generated one - so `/ask` is fully
functional on a deployment with no credentials at all.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from sqlalchemy.engine import Engine

from app.ask.portfolio import Position
from app.ask.service import answer as answer_question
from app.corpus.embeddings import BaseEmbedder
from app.corpus.vector_store import VectorStore
from app.db import get_engine
from app.deps import get_embedder, get_vector_store, require_internal_key
from app.models import AskCitation, AskRequest, AskResponse

router = APIRouter(tags=["ask"], dependencies=[Depends(require_internal_key)])


@router.post("/ask", response_model=AskResponse)
async def ask(
    payload: AskRequest,
    request: Request,
    engine: Engine = Depends(get_engine),
    store: VectorStore = Depends(get_vector_store),
    embedder: BaseEmbedder = Depends(get_embedder),
) -> AskResponse:
    positions = [
        Position(symbol=h.symbol, value_minor=h.value_minor, currency=h.currency)
        for h in payload.holdings
    ]

    with engine.connect() as connection:
        result = await answer_question(
            connection,
            store,
            embedder,
            question=payload.question,
            positions=positions,
            currency=payload.base_currency,
            targets=payload.target_weights,
            # Read off app.state rather than injected, so a deployment with no
            # model configured reaches the extractive path instead of failing a
            # dependency. NullProvider raises LLMUnavailableError on call, which
            # the service records as a fallback reason like any other.
            llm=getattr(request.app.state, "llm", None),
            user_id=str(payload.user_id) if payload.user_id else None,
        )

    return AskResponse(
        question=result.question,
        intent=result.intent.value,
        answered=result.answered,
        text=result.text,
        citations=[
            AskCitation(
                chunk_id=c.chunk_id,
                document_id=c.document_id,
                concept_slug=c.concept_slug,
                title=c.title,
                heading=c.heading,
                text=c.text,
                similarity=c.similarity,
            )
            for c in result.citations
        ],
        concept_refs=list(result.concept_refs),
        evidence=result.evidence,
        answer_source=result.answer_source,
        fallback_reason=result.fallback_reason,
        relevance=result.relevance.value,
        best_similarity=result.best_similarity,
        refused_reason=result.refused_reason,
        vector_is_semantic=result.vector_is_semantic,
    )
