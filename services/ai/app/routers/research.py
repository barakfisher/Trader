"""`POST /research/runs`: start the assigned agent's research on the main portfolio (D254, D290).

Thin, like every router here. Every refusal is made before a model could be
paid for, each with its code: no agent assigned (`no_research_agent`), the
agent paused or archived (`agent_not_active`), its daily allowance spent
(`budget_spent`), nobody to pay for the user's calls (the payer rule's codes,
D245, D250), no holdings to rate (`no_holdings`), a run already going
(`research_running`), or no model at all (503 `no_model`).

The run itself takes a model call per holding, so it is not awaited: the
route claims the run's row, starts it in the background and answers 202 with
its id. The research page reads the run's progress from Postgres; a restart
mid-run leaves the row `running` until the next claim closes it out
(`store.ABANDONED_AFTER`).
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Request, status
from sqlalchemy.engine import Engine

from app.agents.scan_budget import agent_budget
from app.agents.scan_log import find_agent
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
from app.models import ResearchRunRequest, ResearchRunStarted
from app.news.on_demand import news_on_demand
from app.providers.price_provenance import excluded_price_sources
from app.providers.registry import MarketDataService
from app.research.run import RESEARCH_MAX_HOLDINGS, run_research
from app.research.store import (
    ResearchAlreadyRunningError,
    claim_run,
    main_holdings,
    research_agent_id,
)
from app.routers.agents import _model, _payable, _refuse

router = APIRouter(
    prefix="/research", tags=["research"], dependencies=[Depends(require_internal_key)]
)


def _tasks(request: Request) -> set[asyncio.Task[object]]:
    """The runs in flight, held so the event loop does not collect them mid-run."""
    tasks = getattr(request.app.state, "research_tasks", None)
    if tasks is None:
        tasks = set()
        request.app.state.research_tasks = tasks
    return tasks


@router.post("/runs", response_model=ResearchRunStarted, status_code=status.HTTP_202_ACCEPTED)
async def start_research(
    payload: ResearchRunRequest,
    request: Request,
    settings: SettingsDep,
    engine: Engine = Depends(get_engine),
    market: MarketDataService = Depends(get_market_data),
    embedder: BaseEmbedder = Depends(get_embedder),
    store: VectorStore = Depends(get_vector_store),
) -> ResearchRunStarted:
    user_id = str(payload.user_id)
    now = datetime.now(UTC)
    assigned = research_agent_id(engine, user_id)
    agent = find_agent(engine, user_id, assigned) if assigned else None
    if agent is None or agent.is_primary:
        raise _refuse("no_research_agent", "no agent is assigned to research the main portfolio")
    if agent.state != "active":
        raise _refuse("agent_not_active", f"the agent is {agent.state}")
    if agent_budget(engine, agent.agent_id, now).exhausted:
        raise _refuse("budget_spent", "the agent's model budget for today is spent")
    llm = _model(request, settings)
    _payable(request, user_id)
    holdings = main_holdings(engine, user_id)
    if not holdings:
        raise _refuse("no_holdings", "the main portfolio has no holdings to research")
    try:
        run_id = claim_run(engine, user_id, agent.agent_id, payload.trigger, now)
    except ResearchAlreadyRunningError as error:
        raise _refuse("research_running", "research is already running") from error
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
    task = asyncio.create_task(
        run_research(
            engine=engine,
            llm=llm,
            context=context,
            agent=agent,
            run_id=run_id,
            holdings=holdings,
            trigger=payload.trigger,
        )
    )
    tasks = _tasks(request)
    tasks.add(task)
    task.add_done_callback(tasks.discard)
    return ResearchRunStarted(
        run_id=run_id,
        agent_id=agent.agent_id,
        holdings=min(len(holdings), RESEARCH_MAX_HOLDINGS),
    )
