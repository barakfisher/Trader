"""An agent's scan end to end over real SQL, with a scripted model (D14, D15, D50).

The model is the one part substituted: each test scripts its turns, so what is
tested is what the code does with them - the briefing it opens with, the tools
it runs, the limits it enforces and the row it stores. What a real model would
choose is measured on real scans once the account is funded (§14.2, PR 4).
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.agents.scan import SCAN_STEP_LIMIT, instructions, run_scan
from app.agents.scan_log import (
    ABANDONED_AFTER,
    ScanAgent,
    ScanAlreadyRunningError,
    find_agent,
    start_scan,
)
from app.agents.tools import scan_context
from app.analysis.thresholds import AnalysisThresholds
from app.corpus.hashed_embedder import HashedEmbedder
from app.corpus.vector_store import PgVectorStore
from app.llm.base import (
    LLMBudgetExceededError,
    LLMCompletion,
    TokenUsage,
    ToolCall,
)
from tests.integration.conftest import run_script
from tests.integration.test_agent_tools_sql import NOW as QUOTED_AT
from tests.integration.test_agent_tools_sql import ScriptedMarket

FIXTURE_EMBEDDER = {"EMBEDDINGS_PROVIDER": "fixture"}
NOW = datetime.now(UTC)
STEP_COST = 1_000


def _turn(text_: str = "", calls: tuple[ToolCall, ...] = ()) -> LLMCompletion:
    return LLMCompletion(
        text=text_,
        model="scripted/model",
        usage=TokenUsage(prompt_tokens=10, completion_tokens=5),
        estimated_cost_micro_usd=STEP_COST,
        provider="scripted",
        call_id=None,
        tool_calls=calls,
    )


def _answer(**fields: Any) -> LLMCompletion:
    return _turn(json.dumps(fields))


class ScriptedLLM:
    """Answers `converse` from a script; records what it was offered."""

    name = "scripted"
    charges_per_token = True

    def __init__(self, *turns: LLMCompletion | Exception) -> None:
        self.turns = list(turns)
        self.offered: list[int] = []
        self.verdicts: list[str] = []

    async def converse(self, **kwargs: Any) -> LLMCompletion:
        self.offered.append(len(kwargs["tools"]))
        turn = self.turns.pop(0)
        if isinstance(turn, Exception):
            raise turn
        return turn

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
    with loaded.begin() as connection:
        user = connection.execute(
            text("INSERT INTO users (role) VALUES ('user') RETURNING id::text")
        ).scalar_one()
        agent_id = connection.execute(
            text(
                "INSERT INTO agents (user_id, slug, name, persona, budget_minor) "
                "VALUES (CAST(:u AS uuid), 'scanner', 'Scanner', 'A patient value investor.', "
                "100000) RETURNING id::text"
            ),
            {"u": user},
        ).scalar_one()
    found = find_agent(loaded, user, agent_id)
    assert found is not None
    yield found


def _context(engine: Engine, agent: ScanAgent, market: ScriptedMarket | None = None) -> Any:
    return scan_context(
        engine=engine,
        market=market or ScriptedMarket(),  # type: ignore[arg-type]
        embedder=HashedEmbedder(),
        vector_store=PgVectorStore(),
        thresholds=AnalysisThresholds(),
        excluded_price_sources=(),
        user_id=agent.user_id,
        agent_id=agent.agent_id,
        now=NOW,
    )


async def _scan(engine: Engine, agent: ScanAgent, llm: ScriptedLLM, market: Any = None) -> Any:
    return await run_scan(
        engine=engine,
        llm=llm,  # type: ignore[arg-type]
        context=_context(engine, agent, market),
        agent=agent,
        trigger="manual",
        movers=[],
    )


def _stored(engine: Engine, scan_id: str) -> Any:
    with engine.connect() as connection:
        return connection.execute(
            text("SELECT * FROM agent_scans WHERE id = CAST(:id AS uuid)"), {"id": scan_id}
        ).one()


async def test_a_scan_that_decides_nothing_is_stored_whole(
    loaded: Engine, agent: ScanAgent
) -> None:
    llm = ScriptedLLM(
        _answer(decision="none", thesis="Nothing in the briefing fits a value investor.")
    )

    result = await _scan(loaded, agent, llm)

    assert result.outcome == "no_trade"
    row = _stored(loaded, result.scan_id)
    assert (row.outcome, row.steps, row.cost_micro_usd, row.model) == (
        "no_trade",
        0,
        STEP_COST,
        "scripted/model",
    )
    assert row.finished_at is not None and row.trigger == "manual"
    assert row.briefing["cash"] == "1000.00"
    assert row.answer["decision"] == "none"
    assert [entry["role"] for entry in row.transcript] == ["assistant"]
    assert llm.verdicts == ["accepted"]


async def test_tools_run_and_a_sourced_trade_is_accepted(loaded: Engine, agent: ScanAgent) -> None:
    market = ScriptedMarket()
    market.prices = {"CCJ": 5_432}
    llm = ScriptedLLM(
        _turn(calls=(ToolCall("c1", "get_quote", json.dumps({"symbols": ["CCJ"]})),)),
        _answer(
            decision="buy",
            symbol="ccj",
            quantity="3",
            thesis="CCJ trades at 54.32, inside what a patient buyer pays for uranium.",
        ),
    )

    result = await _scan(loaded, agent, llm, market)

    assert result.outcome == "trade", result.problems
    row = _stored(loaded, result.scan_id)
    assert row.steps == 1
    assert row.answer == {
        "decision": "buy",
        "symbol": "CCJ",
        "quantity": "3",
        "thesis": "CCJ trades at 54.32, inside what a patient buyer pays for uranium.",
        # The agent's price, read at the scan's end, which the proposal carries (D47).
        "price_minor": 5_432,
        "price_as_of": QUOTED_AT.isoformat(),
    }
    assert [entry["role"] for entry in row.transcript] == ["assistant", "tool", "assistant"]
    assert row.transcript[1]["result"]["quotes"]["CCJ"]["price"] == "54.32"


async def test_an_invented_figure_makes_the_answer_invalid(
    loaded: Engine, agent: ScanAgent
) -> None:
    llm = ScriptedLLM(
        _answer(decision="buy", symbol="CCJ", quantity="2", thesis="CCJ will reach 80.00 soon.")
    )
    result = await _scan(loaded, agent, llm)
    assert result.outcome == "invalid_answer"
    assert any("80.00" in problem for problem in result.problems)
    assert llm.verdicts == ["unsourced_figures"]


@pytest.mark.parametrize(
    ("fields", "reason"),
    [
        ({"decision": "buy", "symbol": "TSLA", "quantity": "1", "thesis": "t"}, "not tradable"),
        ({"decision": "buy", "symbol": "CCJ", "quantity": "1.5", "thesis": "t"}, "whole number"),
        ({"decision": "sell", "symbol": "CCJ", "quantity": "1", "thesis": "t"}, "holds 0"),
        ({"decision": "hold", "thesis": "t"}, "decision must be"),
    ],
)
async def test_the_server_checks_the_answer_whatever_the_model_said(
    loaded: Engine, agent: ScanAgent, fields: dict[str, str], reason: str
) -> None:
    result = await _scan(loaded, agent, ScriptedLLM(_answer(**fields)))
    assert result.outcome == "invalid_answer"
    assert any(reason in problem for problem in result.problems), result.problems


async def test_a_buy_cash_cannot_cover_with_its_fee_is_invalid_with_the_amounts(
    loaded: Engine, agent: ScanAgent
) -> None:
    # 18 x 54.32 = 977.76, plus the $1.50 minimum fee: 979.26 fits the 1000.00
    # of cash; 19 x 54.32 = 1032.08 does not (D54, D55).
    market = ScriptedMarket()
    market.prices = {"CCJ": 5_432}
    fits = await _scan(
        loaded,
        agent,
        ScriptedLLM(_answer(decision="buy", symbol="CCJ", quantity="18", thesis="t")),
        market,
    )
    assert fits.outcome == "trade", fits.problems

    llm = ScriptedLLM(_answer(decision="buy", symbol="CCJ", quantity="19", thesis="t"))
    short = await _scan(loaded, agent, llm, market)

    assert short.outcome == "invalid_answer"
    assert short.problems == ("buying 19 CCJ at 54.32 costs 1033.58 with the fee; cash is 1000.00",)
    assert _stored(loaded, short.scan_id).answer["price_minor"] == 5_432
    # The model's answer was well formed; the refusal is the server's, not a bad answer.
    assert llm.verdicts == ["accepted"]


async def test_the_thesis_may_state_the_quantity_it_proposes(
    loaded: Engine, agent: ScanAgent
) -> None:
    market = ScriptedMarket()
    market.prices = {"CCJ": 5_432}
    llm = ScriptedLLM(
        _answer(decision="buy", symbol="CCJ", quantity="7", thesis="קנייה של 7 מניות CCJ.")
    )
    result = await _scan(loaded, agent, llm, market)
    assert result.outcome == "trade", result.problems
    # Only the quantity it proposes: any other number is still a figure. 777 is
    # no part of a date or a time: the briefing's `as_of` is today's timestamp,
    # so a small number such as 8 is sourced by it on the 8th of the month.
    llm = ScriptedLLM(
        _answer(decision="buy", symbol="CCJ", quantity="7", thesis="7 now, 777 next week.")
    )
    assert (await _scan(loaded, agent, llm, market)).problems == (
        "figures not in the evidence: 777",
    )


async def test_a_trade_with_no_price_is_not_proposed(loaded: Engine, agent: ScanAgent) -> None:
    result = await _scan(
        loaded, agent, ScriptedLLM(_answer(decision="buy", symbol="CCJ", quantity="1", thesis="t"))
    )
    assert result.outcome == "invalid_answer"
    assert result.problems == ("no USD price is available for CCJ",)


async def test_prose_instead_of_json_is_an_invalid_answer(loaded: Engine, agent: ScanAgent) -> None:
    llm = ScriptedLLM(_turn("I think we should wait."))
    result = await _scan(loaded, agent, llm)
    assert result.outcome == "invalid_answer"
    assert llm.verdicts == ["malformed"]


async def test_the_step_limit_takes_the_tools_away_then_ends_the_scan(
    loaded: Engine, agent: ScanAgent
) -> None:
    position = ToolCall("p", "get_position", "{}")
    llm = ScriptedLLM(*[_turn(calls=(position,)) for _ in range(SCAN_STEP_LIMIT + 1)])

    result = await _scan(loaded, agent, llm)

    assert result.outcome == "step_limit"
    assert result.steps == SCAN_STEP_LIMIT
    # Tools offered on every turn but the last, which must answer.
    assert llm.offered[:-1] == [7] * SCAN_STEP_LIMIT and llm.offered[-1] == 0


async def test_calls_past_the_limit_in_one_turn_are_answered_but_not_run(
    loaded: Engine, agent: ScanAgent
) -> None:
    many = tuple(ToolCall(f"c{n}", "get_position", "{}") for n in range(SCAN_STEP_LIMIT + 2))
    llm = ScriptedLLM(_turn(calls=many), _answer(decision="none", thesis="Enough looked at."))

    result = await _scan(loaded, agent, llm)

    assert result.steps == SCAN_STEP_LIMIT
    refused = [e for e in result.transcript if e["role"] == "tool" and "error" in e["result"]]
    assert len(refused) == 2


async def test_the_agents_daily_budget_stops_the_scan_before_a_call(
    loaded: Engine, agent: ScanAgent
) -> None:
    with loaded.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO llm_calls (user_id, agent_id, purpose, provider, outcome, "
                "latency_ms, prompt, cost_micro_usd) VALUES (CAST(:u AS uuid), "
                "CAST(:a AS uuid), 'agent_scan', 'openrouter', 'ok', 1, 'p', "
                "(SELECT llm_budget_micro_usd FROM agents WHERE id = CAST(:a AS uuid)))"
            ),
            {"u": agent.user_id, "a": agent.agent_id},
        )
    llm = ScriptedLLM()

    result = await _scan(loaded, agent, llm)

    assert result.outcome == "budget_reached"
    assert llm.offered == []


async def test_the_installations_spend_guard_also_reads_as_budget_reached(
    loaded: Engine, agent: ScanAgent
) -> None:
    llm = ScriptedLLM(LLMBudgetExceededError(5_000_000, 5_000_000, "2026-10-07"))
    assert (await _scan(loaded, agent, llm)).outcome == "budget_reached"


async def test_one_scan_at_a_time_and_an_abandoned_one_is_closed(
    loaded: Engine, agent: ScanAgent
) -> None:
    start_scan(loaded, agent, "manual", {}, NOW)
    with pytest.raises(ScanAlreadyRunningError):
        start_scan(loaded, agent, "manual", {}, NOW)

    later = NOW + ABANDONED_AFTER + timedelta(minutes=1)
    start_scan(loaded, agent, "schedule", {}, later)
    with loaded.connect() as connection:
        outcomes = (
            connection.execute(
                text(
                    "SELECT outcome FROM agent_scans WHERE agent_id = CAST(:a AS uuid) "
                    "ORDER BY started_at"
                ),
                {"a": agent.agent_id},
            )
            .scalars()
            .all()
        )
    assert outcomes == ["failed", None]


def test_the_primary_never_scans(loaded: Engine, agent: ScanAgent) -> None:
    with loaded.connect() as connection:
        primary = connection.execute(
            text("SELECT id::text FROM agents WHERE user_id = CAST(:u AS uuid) AND is_primary"),
            {"u": agent.user_id},
        ).scalar_one()
    main = find_agent(loaded, agent.user_id, primary)
    assert main is not None and main.is_primary
    with pytest.raises(Exception, match="does not scan"):
        start_scan(loaded, main, "manual", {}, NOW)


def test_the_instructions_carry_the_persona_and_the_limits(agent: ScanAgent) -> None:
    prompt = instructions(agent)
    assert "A patient value investor." in prompt
    assert str(SCAN_STEP_LIMIT) in prompt
    assert '"decision"' in prompt
    assert "Write the thesis in English" in prompt


def test_the_thesis_is_asked_for_in_the_users_language(agent: ScanAgent) -> None:
    from dataclasses import replace

    assert "Write the thesis in Hebrew" in instructions(replace(agent, language="he"))


def test_the_agent_carries_its_users_language(loaded: Engine, agent: ScanAgent) -> None:
    with loaded.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO user_settings (user_id, language) VALUES (CAST(:u AS uuid), 'he') "
                "ON CONFLICT (user_id) DO UPDATE SET language = 'he'"
            ),
            {"u": agent.user_id},
        )
    found = find_agent(loaded, agent.user_id, agent.agent_id)
    assert found is not None and found.language == "he"
