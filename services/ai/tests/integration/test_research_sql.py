"""Research end to end over real SQL, with a scripted model (D254, D289-D293).

The model is the one part substituted: each test scripts its answers, so what
is tested is what the code does with them - the evidence it hands over, the
checks it applies, the retry, the limits and the rows it stores.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.agents.scan_log import ScanAgent, find_agent
from app.agents.tools import scan_context
from app.analysis.thresholds import AnalysisThresholds
from app.corpus.hashed_embedder import HashedEmbedder
from app.corpus.vector_store import PgVectorStore
from app.llm.base import (
    LLMCompletion,
    LLMTimeoutError,
    LLMUnavailableError,
    OwnKeyRequiredError,
    TokenUsage,
)
from app.research.rating import UNSOURCED_PREFIX, WORDING_PREFIX
from app.research.run import (
    CALL_FAILED,
    RESEARCH_ATTEMPTS,
    STOP_BUDGET,
    STOP_NO_MODEL,
    run_research,
)
from app.research.store import (
    ABANDONED_AFTER,
    ResearchAlreadyRunningError,
    claim_run,
    main_holdings,
)
from tests.integration.conftest import run_script
from tests.integration.test_agent_tools_sql import ScriptedMarket, _instrument

FIXTURE_EMBEDDER = {"EMBEDDINGS_PROVIDER": "fixture"}
NOW = datetime.now(UTC)
CALL_COST = 1_000


def _completion(body: dict[str, Any] | str) -> LLMCompletion:
    return LLMCompletion(
        text=body if isinstance(body, str) else json.dumps(body),
        model="scripted/model",
        usage=TokenUsage(prompt_tokens=10, completion_tokens=5),
        estimated_cost_micro_usd=CALL_COST,
        provider="scripted",
    )


def _rating(rating: str = "bullish", rationale: str = "CCJ trades at 54.32.") -> LLMCompletion:
    return _completion({"rating": rating, "rationale": rationale, "findings": ["Steady news."]})


class ScriptedLLM:
    """Answers `complete` from a script; records what it was asked."""

    name = "scripted"
    charges_per_token = True

    def __init__(self, *answers: LLMCompletion | Exception) -> None:
        self.answers = list(answers)
        self.prompts: list[str] = []
        self.systems: list[str] = []
        self.callers: list[Any] = []
        self.verdicts: list[str] = []

    async def complete(self, **kwargs: Any) -> LLMCompletion:
        self.prompts.append(kwargs["user"])
        self.systems.append(kwargs["system"])
        self.callers.append(kwargs["caller"])
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    async def record_verdict(self, _call_id: int | None, verdict: str) -> None:
        self.verdicts.append(verdict)


@pytest.fixture(scope="module")
def loaded(migrated: Engine, database_url: str) -> Engine:
    universe = run_script(
        database_url, "scripts/ingest_universe.py", "--fixture", **FIXTURE_EMBEDDER
    )
    assert universe.returncode == 0, universe.stdout + universe.stderr
    return migrated


@pytest.fixture()
def agent(loaded: Engine) -> Iterator[ScanAgent]:
    """A user with a main portfolio holding CCJ and NXE, and an agent assigned to research it."""
    with loaded.begin() as connection:
        user = connection.execute(
            text(
                "INSERT INTO users (role, status, llm_cap_micro_usd) "
                "VALUES ('user', 'active', 10000000) RETURNING id::text"
            )
        ).scalar_one()
        # A user's main portfolio is created with the user (D1).
        primary = connection.execute(
            text("SELECT id::text FROM agents WHERE user_id = CAST(:u AS uuid) AND is_primary"),
            {"u": user},
        ).scalar_one()
        agent_id = connection.execute(
            text(
                "INSERT INTO agents (user_id, slug, name, persona, budget_minor) "
                "VALUES (CAST(:u AS uuid), 'analyst', 'Analyst', 'A patient value investor.', "
                "100000) RETURNING id::text"
            ),
            {"u": user},
        ).scalar_one()
        for symbol in ("NXE", "CCJ"):
            connection.execute(
                text(
                    "INSERT INTO holdings (user_id, agent_id, instrument_id, quantity) "
                    "VALUES (CAST(:u AS uuid), CAST(:a AS uuid), CAST(:i AS uuid), 3)"
                ),
                {"u": user, "a": primary, "i": _instrument(loaded, symbol)},
            )
        connection.execute(
            text(
                "INSERT INTO user_settings (user_id, research_agent_id) "
                "VALUES (CAST(:u AS uuid), CAST(:a AS uuid))"
            ),
            {"u": user, "a": agent_id},
        )
    found = find_agent(loaded, user, agent_id)
    assert found is not None
    yield found


def _market() -> ScriptedMarket:
    market = ScriptedMarket()
    market.prices = {"CCJ": 5_432, "NXE": 812}
    return market


async def _run(engine: Engine, agent: ScanAgent, llm: ScriptedLLM) -> tuple[str, Any]:
    run_id = claim_run(engine, agent.user_id, agent.agent_id, "manual", NOW)
    context = scan_context(
        engine=engine,
        market=_market(),  # type: ignore[arg-type]
        embedder=HashedEmbedder(),
        vector_store=PgVectorStore(),
        thresholds=AnalysisThresholds(),
        excluded_price_sources=(),
        user_id=agent.user_id,
        agent_id=agent.agent_id,
        now=NOW,
    )
    tally = await run_research(
        engine=engine,
        llm=llm,  # type: ignore[arg-type]
        context=context,
        agent=agent,
        run_id=run_id,
        holdings=main_holdings(engine, agent.user_id),
        trigger="manual",
    )
    return run_id, tally


def _rows(engine: Engine, run_id: str) -> tuple[Any, list[Any]]:
    with engine.connect() as connection:
        run = connection.execute(
            text("SELECT * FROM research_runs WHERE id = CAST(:id AS uuid)"), {"id": run_id}
        ).one()
        ratings = connection.execute(
            text("SELECT * FROM research_ratings WHERE run_id = CAST(:id AS uuid) ORDER BY symbol"),
            {"id": run_id},
        ).all()
    return run, ratings


async def test_each_holding_is_rated_from_its_evidence(loaded: Engine, agent: ScanAgent) -> None:
    llm = ScriptedLLM(_rating("bullish"), _rating("neutral", "NXE trades at 8.12."))

    run_id, tally = await _run(loaded, agent, llm)

    run, ratings = _rows(loaded, run_id)
    assert (run.status, run.holdings, run.rated, run.error) == ("done", 2, 2, None)
    assert run.cost_micro_usd == 2 * CALL_COST == tally.cost_micro_usd
    assert [(r.symbol, r.status, r.rating) for r in ratings] == [
        ("CCJ", "rated", "bullish"),
        ("NXE", "rated", "neutral"),
    ]
    assert ratings[0].findings == ["Steady news."]
    assert ratings[0].evidence["quote"]["price"] == "54.32"
    # The rating is about the stock: the evidence never carries the position.
    assert "quantity" not in json.dumps(ratings[0].evidence)
    assert llm.verdicts == ["accepted", "accepted"]
    assert {(c.purpose, c.agent_id) for c in llm.callers} == {("research", agent.agent_id)}
    assert "A patient value investor." in llm.systems[0]


async def test_a_refused_answer_goes_back_once_then_is_stored_refused(
    loaded: Engine, agent: ScanAgent
) -> None:
    bad = _rating(rationale="CCJ is a buy at 99.99.")
    llm = ScriptedLLM(*([bad] * RESEARCH_ATTEMPTS), _rating("bearish", "NXE trades at 8.12."))

    run_id, _ = await _run(loaded, agent, llm)

    run, ratings = _rows(loaded, run_id)
    assert (run.status, run.rated) == ("done", 1)
    ccj = ratings[0]
    assert (ccj.status, ccj.rating, ccj.rationale) == ("refused", None, None)
    assert ccj.problems == [f"{WORDING_PREFIX}: buy", f"{UNSOURCED_PREFIX}: 99.99"]
    assert "Your previous answer was refused" in llm.prompts[1]
    assert llm.verdicts[:RESEARCH_ATTEMPTS] == ["unsourced_figures"] * RESEARCH_ATTEMPTS


async def test_a_failed_call_fails_that_holding_only(loaded: Engine, agent: ScanAgent) -> None:
    llm = ScriptedLLM(LLMTimeoutError("scripted", 30), _rating("neutral", "NXE trades at 8.12."))

    run_id, _ = await _run(loaded, agent, llm)

    _, ratings = _rows(loaded, run_id)
    assert [r.status for r in ratings] == ["failed", "rated"]
    assert ratings[0].problems[0].startswith(CALL_FAILED)


async def test_a_refused_key_stops_the_run(loaded: Engine, agent: ScanAgent) -> None:
    llm = ScriptedLLM(OwnKeyRequiredError("own_key_required"))

    run_id, _ = await _run(loaded, agent, llm)

    run, ratings = _rows(loaded, run_id)
    assert (run.status, run.rated, run.error) == ("done", 0, "own_key_required")
    assert ratings == []


async def test_no_model_stops_the_run_at_its_first_call(loaded: Engine, agent: ScanAgent) -> None:
    llm = ScriptedLLM(LLMUnavailableError("no model"))

    run_id, _ = await _run(loaded, agent, llm)

    run, ratings = _rows(loaded, run_id)
    assert (run.status, run.error) == ("done", STOP_NO_MODEL)
    assert ratings == [] and len(llm.prompts) == 1


async def test_a_spent_allowance_stops_the_run_before_a_call(
    loaded: Engine, agent: ScanAgent
) -> None:
    with loaded.begin() as connection:
        connection.execute(
            text("UPDATE agents SET llm_budget_micro_usd = 1 WHERE id = CAST(:a AS uuid)"),
            {"a": agent.agent_id},
        )
        connection.execute(
            text(
                "INSERT INTO llm_calls (purpose, provider, model, outcome, user_id, agent_id, "
                "cost_micro_usd, latency_ms, prompt, started_at) VALUES ('research', "
                "'scripted', 'm', 'ok', CAST(:u AS uuid), CAST(:a AS uuid), 5, 1, 'p', now())"
            ),
            {"u": agent.user_id, "a": agent.agent_id},
        )
    llm = ScriptedLLM()

    run_id, _ = await _run(loaded, agent, llm)

    run, _ = _rows(loaded, run_id)
    assert (run.status, run.error) == ("done", STOP_BUDGET)
    assert llm.prompts == []


def test_one_run_at_a_time_and_an_abandoned_one_is_closed(loaded: Engine, agent: ScanAgent) -> None:
    first = claim_run(loaded, agent.user_id, agent.agent_id, "schedule", NOW)
    with pytest.raises(ResearchAlreadyRunningError):
        claim_run(loaded, agent.user_id, agent.agent_id, "manual", NOW)

    later = NOW + ABANDONED_AFTER + timedelta(seconds=1)
    second = claim_run(loaded, agent.user_id, agent.agent_id, "manual", later)

    with loaded.connect() as connection:
        status, error = connection.execute(
            text("SELECT status, error FROM research_runs WHERE id = CAST(:id AS uuid)"),
            {"id": first},
        ).one()
    assert (status, error) == ("failed", "abandoned")
    assert second != first


def test_the_assigned_agent_must_be_the_users_own(loaded: Engine, agent: ScanAgent) -> None:
    with loaded.begin() as connection:
        other = connection.execute(
            text(
                "INSERT INTO users (role, status, llm_cap_micro_usd) "
                "VALUES ('user', 'active', 10000000) RETURNING id::text"
            )
        ).scalar_one()
    with (
        pytest.raises(Exception, match="user_settings_research_agent_fkey"),
        loaded.begin() as connection,
    ):
        connection.execute(
            text(
                "INSERT INTO user_settings (user_id, research_agent_id) "
                "VALUES (CAST(:u AS uuid), CAST(:a AS uuid))"
            ),
            {"u": other, "a": agent.agent_id},
        )
