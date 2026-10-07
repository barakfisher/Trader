"""`POST /agents/{agent_id}/scans`: run one scan of a simulated agent now (D15, D50).

Thin, like every router here: the agent's eligibility is checked, the tools'
context assembled, and `app/agents/scan.py` does the rest. The orchestrator owns
the session and calls this with the user it authenticated; the schedule (Stage
4's last PR) will call it the same way, with `trigger: "schedule"`.

**Refusals, and why each is a 409 rather than a 400:** the request is well
formed, but the agent is not in a state to scan - the primary never scans (D1),
a paused or archived agent does not (D18), an agent with no persona has nothing
to decide by, one asked to scan now with its day's budget spent is refused (D52),
and one already scanning would be billed twice. A model that is
not configured is a 503: the service cannot do this at all right now.
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.engine import Engine

from app.agents.scan import run_scan
from app.agents.scan_budget import agent_budget
from app.agents.scan_log import ScanAlreadyRunningError, find_agent
from app.agents.tools import scan_context
from app.analysis.thresholds import AnalysisThresholds
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
from app.models import AgentScanAnswer, AgentScanRequest, AgentScanResponse
from app.providers.price_provenance import excluded_price_sources
from app.providers.registry import MarketDataService

router = APIRouter(prefix="/agents", tags=["agents"], dependencies=[Depends(require_internal_key)])


def _now() -> datetime:
    return datetime.now(UTC)


def _refuse(code: str, message: str, status_code: int = status.HTTP_409_CONFLICT) -> HTTPException:
    return HTTPException(status_code, {"code": code, "message": message})


@router.post("/{agent_id}/scans", response_model=AgentScanResponse)
async def scan_agent(
    agent_id: str,
    payload: AgentScanRequest,
    request: Request,
    settings: SettingsDep,
    engine: Engine = Depends(get_engine),
    market: MarketDataService = Depends(get_market_data),
    embedder: BaseEmbedder = Depends(get_embedder),
    store: VectorStore = Depends(get_vector_store),
) -> AgentScanResponse:
    user_id = str(payload.user_id)
    agent = find_agent(engine, user_id, agent_id)
    if agent is None:
        raise _refuse("agent_not_found", "no such agent", status.HTTP_404_NOT_FOUND)
    if agent.is_primary:
        raise _refuse("primary_agent", "the main portfolio does not scan (D1)")
    if agent.state != "active":
        raise _refuse("agent_not_active", f"the agent is {agent.state}")
    if not (agent.persona or "").strip():
        raise _refuse("no_persona", "the agent needs a persona to decide by")

    # D52: a scan asked for now is refused with the day's budget spent. A
    # scheduled one is run and recorded as `budget_reached`, so the Decisions tab
    # shows the slot that did not happen and why.
    if payload.trigger == "manual" and agent_budget(engine, agent.agent_id, _now()).exhausted:
        raise _refuse("budget_spent", "the agent's model budget for today is spent")

    llm = getattr(request.app.state, "llm", None)
    # Off on purpose (LLM_PROVIDER=null) is refused up front. A provider that is
    # configured but broken fails its first call, and the scan records why.
    if llm is None or configured_model(settings) is None:
        raise _refuse(
            "no_model", "no model is configured for scans", status.HTTP_503_SERVICE_UNAVAILABLE
        )

    context = scan_context(
        engine=engine,
        market=market,
        embedder=embedder,
        vector_store=store,
        thresholds=AnalysisThresholds.from_settings(settings),
        excluded_price_sources=excluded_price_sources(settings.market_data_chain),
        user_id=user_id,
        agent_id=agent.agent_id,
    )
    try:
        result = await run_scan(
            engine=engine,
            llm=llm,
            context=context,
            agent=agent,
            trigger=payload.trigger,
            movers=await market.movers(),
        )
    except ScanAlreadyRunningError as error:
        raise _refuse("scan_running", "this agent is already scanning") from error

    return AgentScanResponse(
        scan_id=result.scan_id,
        outcome=result.outcome,
        steps=result.steps,
        cost_micro_usd=result.cost_micro_usd,
        model=result.model,
        answer=AgentScanAnswer(**result.answer) if result.answer else None,
        error=result.error,
    )
