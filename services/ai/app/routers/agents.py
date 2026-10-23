"""`POST /agents/{agent_id}/scans`: run one scan of a simulated agent now (D15, D50).

Thin, like every router here: the agent's eligibility is checked, the tools'
context assembled, and `app/agents/scan.py` does the rest. The orchestrator owns
the session and calls this with the user it authenticated; the schedule (Stage
4's last PR) will call it the same way, with `trigger: "schedule"`.

**Refusals, and why each is a 409 rather than a 400:** the request is well
formed, but the agent is not in a state to scan - the primary never scans (D1),
a paused or archived agent does not (D18), an agent with neither instructions nor
a mandate has nothing to decide by (D174; the code keeps its old name,
`no_persona`), one asked to scan now with its day's budget spent is refused (D52),
and one already scanning would be billed twice. A user who is not the admin and
has no working key of their own, or has spent their monthly safety limit, is
refused before anything runs (`own_key_required`, `own_key_failed`,
`safety_limit_reached`; D245, D250) - a scheduled scan too, which the
orchestrator then skips. A model that is
not configured is a 503: the service cannot do this at all right now.

`POST /agents/{agent_id}/proposals/{proposal_id}/recheck` re-checks one expired
trade proposal (D212-D216, `app/agents/recheck.py`): the same agent checks as a
manual scan, then the proposal's own - not found, not a trade, not expired, past
the week, already re-checked, or superseded by a later approved proposal (D218) -
each with its code, before any model is called.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.engine import Engine

from app.agents.mandate_check import check_instructions
from app.agents.recheck import NotRecheckableError, find_expired_trade, run_recheck
from app.agents.scan import ScanResult, run_scan
from app.agents.scan_budget import agent_budget
from app.agents.scan_log import (
    AlreadyRefreshedError,
    ScanAgent,
    ScanAlreadyRunningError,
    find_agent,
)
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
    payer_refusal,
    require_internal_key,
)
from app.llm.factory import configured_model
from app.models import (
    AgentRecheckRequest,
    AgentScanAnswer,
    AgentScanRequest,
    AgentScanResponse,
    MandateCheckRequest,
    MandateCheckResponse,
    MandateConflict,
)
from app.news.on_demand import news_on_demand
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
    # D52: a scan asked for now is refused with the day's budget spent. A
    # scheduled one is run and recorded as `budget_reached`, so the Decisions tab
    # shows the slot that did not happen and why.
    agent = _scannable(engine, user_id, agent_id, asked_now=payload.trigger == "manual")
    llm = _model(request, settings)
    _payable(request, user_id)
    context = scan_context(
        engine=engine,
        market=market,
        embedder=embedder,
        vector_store=store,
        thresholds=AnalysisThresholds.from_settings(settings),
        excluded_price_sources=excluded_price_sources(settings.market_data_chain),
        user_id=user_id,
        agent_id=agent.agent_id,
        news=news_on_demand(settings, engine, getattr(request.app.state, "redis", None)),
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
    return _response(result)


@router.post("/{agent_id}/proposals/{proposal_id}/recheck", response_model=AgentScanResponse)
async def recheck_proposal(
    agent_id: str,
    proposal_id: str,
    payload: AgentRecheckRequest,
    request: Request,
    settings: SettingsDep,
    engine: Engine = Depends(get_engine),
    market: MarketDataService = Depends(get_market_data),
    embedder: BaseEmbedder = Depends(get_embedder),
    store: VectorStore = Depends(get_vector_store),
) -> AgentScanResponse:
    """Re-check one expired trade proposal (D212): a `refresh` scan of that one trade."""
    user_id = str(payload.user_id)
    agent = _scannable(engine, user_id, agent_id, asked_now=True)
    try:
        trade = find_expired_trade(engine, user_id, agent.agent_id, proposal_id, _now())
    except NotRecheckableError as error:
        code = status.HTTP_404_NOT_FOUND if error.code == "proposal_not_found" else None
        raise _refuse(error.code, error.message, code or status.HTTP_409_CONFLICT) from error
    llm = _model(request, settings)
    _payable(request, user_id)
    context = scan_context(
        engine=engine,
        market=market,
        embedder=embedder,
        vector_store=store,
        thresholds=AnalysisThresholds.from_settings(settings),
        excluded_price_sources=excluded_price_sources(settings.market_data_chain),
        user_id=user_id,
        agent_id=agent.agent_id,
        news=news_on_demand(settings, engine, getattr(request.app.state, "redis", None)),
    )
    try:
        result = await run_recheck(
            engine=engine, llm=llm, context=context, agent=agent, trade=trade
        )
    except ScanAlreadyRunningError as error:
        raise _refuse("scan_running", "this agent is already scanning") from error
    except AlreadyRefreshedError as error:
        raise _refuse("already_rechecked", "this proposal has had its re-check") from error
    return _response(result)


def _scannable(engine: Engine, user_id: str, agent_id: str, *, asked_now: bool) -> ScanAgent:
    """The agent, if it may scan; otherwise the refusal that says why."""
    agent = find_agent(engine, user_id, agent_id)
    if agent is None:
        raise _refuse("agent_not_found", "no such agent", status.HTTP_404_NOT_FOUND)
    if agent.is_primary:
        raise _refuse("primary_agent", "the main portfolio does not scan (D1)")
    if agent.state != "active":
        raise _refuse("agent_not_active", f"the agent is {agent.state}")
    if not agent.ready:
        raise _refuse("no_persona", "the agent needs instructions or settings to decide by")
    if asked_now and agent_budget(engine, agent.agent_id, _now()).exhausted:
        raise _refuse("budget_spent", "the agent's model budget for today is spent")
    return agent


#: What each refusal of the payer rule says, in the 409's message (server text).
PAYER_REFUSALS = {
    "own_key_required": "add your own OpenRouter key in Settings to run this",
    "own_key_failed": "OpenRouter refused your saved key; replace it in Settings",
    "safety_limit_reached": "your monthly safety limit on model spending is reached",
}


def _payable(request: Request, user_id: str) -> None:
    """Refuse up front when nobody may pay for this user's calls (D245, D250)."""
    refusal = payer_refusal(request, user_id)
    if refusal is not None:
        raise _refuse(refusal, PAYER_REFUSALS[refusal])


def _model(request: Request, settings: SettingsDep) -> Any:
    """The model provider. Off on purpose (LLM_PROVIDER=null) is refused up front; a
    provider configured but broken fails its first call, and the scan records why."""
    llm = getattr(request.app.state, "llm", None)
    if llm is None or configured_model(settings) is None:
        raise _refuse(
            "no_model", "no model is configured for scans", status.HTTP_503_SERVICE_UNAVAILABLE
        )
    return llm


def _response(result: ScanResult) -> AgentScanResponse:
    return AgentScanResponse(
        scan_id=result.scan_id,
        outcome=result.outcome,
        steps=result.steps,
        cost_micro_usd=result.cost_micro_usd,
        model=result.model,
        answer=AgentScanAnswer.model_validate(result.answer) if result.answer else None,
        error=result.error,
    )


@router.post("/{agent_id}/mandate-check", response_model=MandateCheckResponse)
async def mandate_check(
    agent_id: str,
    payload: MandateCheckRequest,
    request: Request,
    settings: SettingsDep,
    engine: Engine = Depends(get_engine),
) -> MandateCheckResponse:
    """D176-D177: one call reading the agent's instructions against its settings.

    Refused only for an agent that is not the user's or is the primary; every
    other reason not to check is a `skipped` answer, because a check is a
    courtesy after a save and its absence is never the user's problem.
    """
    agent = find_agent(engine, str(payload.user_id), agent_id)
    if agent is None:
        raise _refuse("agent_not_found", "no such agent", status.HTTP_404_NOT_FOUND)
    if agent.is_primary:
        raise _refuse("primary_agent", "the main portfolio has no instructions to check (D1)")
    llm = getattr(request.app.state, "llm", None)
    if llm is None or configured_model(settings) is None:
        return MandateCheckResponse(status="skipped", reason="no_model")
    if agent_budget(engine, agent.agent_id, _now()).exhausted:
        return MandateCheckResponse(status="skipped", reason="budget_spent")
    refusal = payer_refusal(request, str(payload.user_id))
    if refusal is not None:
        return MandateCheckResponse(status="skipped", reason=refusal)
    result = await check_instructions(llm, agent)
    return MandateCheckResponse(
        status=result.status,
        reason=result.reason,
        conflicts=[MandateConflict(setting=c.setting, quote=c.quote) for c in result.conflicts],
    )
