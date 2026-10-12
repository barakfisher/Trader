"""`POST /assistant/messages`: one question to the assistant (`/ask` with tools).

Thin, like every router here: the tools' context is assembled and
`app/assistant/service.py` does the rest. The orchestrator owns the session and
calls this with the user it authenticated; listing, reading and deleting
conversations are its own SQL, as for every table the screens read.

**Every reply is a 200**, a decline and a failure included: the screen shows
each as what it is, and a 4xx would make a correct decline look like a broken
service. The one 404 is a conversation that is not this user's - the same answer
as one that does not exist.

**No model is an outcome, not a 503**: the question is kept, and the reply says
the assistant needs a model (decided 2026-10-07: no path without one).
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.engine import Engine

from app.agents.tools import scan_context
from app.analysis.thresholds import AnalysisThresholds
from app.assistant.service import ask
from app.assistant.tools import primary_agent_id
from app.corpus.embeddings import BaseEmbedder
from app.corpus.vector_store import VectorStore
from app.db import get_engine
from app.deps import (
    SettingsDep,
    get_embedder,
    get_market_data,
    get_vector_store,
    require_internal_key,
)
from app.llm.factory import configured_model
from app.models import AssistantMessageRequest, AssistantReply, AssistantSource
from app.news.on_demand import news_on_demand
from app.providers.price_provenance import excluded_price_sources
from app.providers.registry import MarketDataService

router = APIRouter(
    prefix="/assistant", tags=["assistant"], dependencies=[Depends(require_internal_key)]
)


@router.post("/messages", response_model=AssistantReply)
async def assistant_message(
    payload: AssistantMessageRequest,
    request: Request,
    settings: SettingsDep,
    engine: Engine = Depends(get_engine),
    market: MarketDataService = Depends(get_market_data),
    embedder: BaseEmbedder = Depends(get_embedder),
    store: VectorStore = Depends(get_vector_store),
) -> AssistantReply:
    user_id = str(payload.user_id)
    with engine.connect() as connection:
        primary = primary_agent_id(connection, user_id)
    if primary is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, {"code": "no_account", "message": "no such user"}
        )

    llm = getattr(request.app.state, "llm", None)
    context = scan_context(
        engine=engine,
        market=market,
        embedder=embedder,
        vector_store=store,
        thresholds=AnalysisThresholds.from_settings(settings),
        excluded_price_sources=excluded_price_sources(settings.market_data_chain),
        user_id=user_id,
        agent_id=primary,
        news=news_on_demand(settings, engine, getattr(request.app.state, "redis", None)),
    )
    turn = await ask(
        engine=engine,
        llm=llm if llm is not None and configured_model(settings) is not None else None,
        context=context,
        question=payload.message,
        conversation_id=str(payload.conversation_id) if payload.conversation_id else None,
        now=datetime.now(UTC),
        timezone=settings.app_timezone,
    )
    if turn is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            {"code": "conversation_not_found", "message": "no such conversation"},
        )
    return AssistantReply(
        conversation_id=UUID(turn.conversation_id) if turn.conversation_id else None,
        message_id=UUID(turn.message_id) if turn.message_id else None,
        outcome=turn.outcome,
        reason=turn.reason,  # type: ignore[arg-type]
        text=turn.text,
        sources=[AssistantSource(**source) for source in turn.sources],
        suggestions=turn.suggestions,
        model=turn.model,
        cost_micro_usd=turn.cost_micro_usd,
        steps=turn.steps,
    )
