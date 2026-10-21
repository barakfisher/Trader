"""An agent's scan end to end over real SQL, with a scripted model (D14, D15, D50).

The model is the one part substituted: each test scripts its turns, so what is
tested is what the code does with them - the briefing it opens with, the tools
it runs, the limits it enforces and the row it stores. What a real model would
choose is measured on real scans once the account is funded (§14.2, PR 4).
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
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
from app.agents.tools import money, scan_context
from app.analysis.thresholds import AnalysisThresholds
from app.core.fees import fee_minor
from app.corpus.hashed_embedder import HashedEmbedder
from app.corpus.vector_store import PgVectorStore
from app.llm.base import (
    LLMBudgetExceededError,
    LLMCompletion,
    TokenUsage,
    ToolCall,
)
from app.llm.monthly_cap import DatabaseCapLedger, MonthlyCapProvider
from app.llm.pricing import DEFAULT_UNKNOWN_MODEL_PRICE_USD_PER_MTOK
from tests.integration.conftest import run_script
from tests.integration.test_agent_tools_sql import NOW as QUOTED_AT
from tests.integration.test_agent_tools_sql import ScriptedMarket, _instrument

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


def _trades(*trades: dict[str, Any], thesis: str | None = None) -> LLMCompletion:
    body: dict[str, Any] = {"trades": list(trades)}
    if thesis is not None:
        body["thesis"] = thesis
    return _turn(json.dumps(body))


def _trade(decision: str, symbol: str, quantity: str, thesis: str = "t") -> dict[str, str]:
    return {"decision": decision, "symbol": symbol, "quantity": quantity, "thesis": thesis}


class ScriptedLLM:
    """Answers `converse` from a script; records what it was offered."""

    name = "scripted"
    charges_per_token = True

    def __init__(self, *turns: LLMCompletion | Exception) -> None:
        self.turns = list(turns)
        self.offered: list[int] = []
        self.verdicts: list[str] = []
        self.heard: list[Any] = []

    async def converse(self, **kwargs: Any) -> LLMCompletion:
        self.offered.append(len(kwargs["tools"]))
        self.heard.append(kwargs["messages"][-1])
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
            text(
                "INSERT INTO users (role, status, llm_cap_micro_usd) "
                "VALUES ('user', 'active', 10000000) RETURNING id::text"
            )
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
    assert row.answer == {
        "trades": [],
        "thesis": "Nothing in the briefing fits a value investor.",
        "problems": [],
    }
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
    # The one-trade shape from before D197 is still read, and stored as a list of one.
    assert row.answer == {
        "trades": [
            {
                "decision": "buy",
                "symbol": "CCJ",
                "quantity": "3",
                "thesis": "CCJ trades at 54.32, inside what a patient buyer pays for uranium.",
                # The agent's price, read at the scan's end, which the proposal carries (D47).
                "price_minor": 5_432,
                "price_as_of": QUOTED_AT.isoformat(),
                "funded_by": [],
            }
        ],
        "thesis": None,
        "problems": [],
    }
    assert [entry["role"] for entry in row.transcript] == ["assistant", "tool", "assistant"]
    assert row.transcript[1]["result"]["quotes"]["CCJ"]["price"] == "54.32"


async def test_an_invented_figure_twice_makes_the_answer_invalid(
    loaded: Engine, agent: ScanAgent
) -> None:
    llm = ScriptedLLM(
        _answer(decision="buy", symbol="CCJ", quantity="2", thesis="CCJ will reach 80.00 soon."),
        _answer(decision="buy", symbol="CCJ", quantity="2", thesis="CCJ will reach 90.00 soon."),
    )
    result = await _scan(loaded, agent, llm)
    assert result.outcome == "invalid_answer"
    assert result.problems == ("figures not in the evidence: 90.00",)
    assert llm.verdicts == ["unsourced_figures", "unsourced_figures"]
    row = _stored(loaded, result.scan_id)
    assert [entry["role"] for entry in row.transcript] == ["assistant", "returned", "assistant"]
    assert row.transcript[1]["problems"] == ["figures not in the evidence: 80.00"]
    assert "90.00" in row.answer["trades"][0]["thesis"]
    assert row.answer["trades"][0]["refused"] is True


async def test_an_invented_figure_goes_back_once_and_a_sourced_answer_is_a_trade(
    loaded: Engine, agent: ScanAgent
) -> None:
    market = ScriptedMarket()
    market.prices = {"CCJ": 5_432}
    llm = ScriptedLLM(
        _answer(decision="buy", symbol="CCJ", quantity="2", thesis="CCJ will reach 80.00."),
        _answer(decision="buy", symbol="CCJ", quantity="2", thesis="CCJ is a uranium miner."),
    )
    result = await _scan(loaded, agent, llm, market)
    assert result.outcome == "trade", result.problems
    assert llm.verdicts == ["unsourced_figures", "accepted"]
    # The model hears which figure, as it wrote it.
    assert "figures not in the evidence: 80.00" in str(llm.heard[-1])


async def test_a_pass_with_an_invented_figure_also_goes_back_once(
    loaded: Engine, agent: ScanAgent
) -> None:
    llm = ScriptedLLM(
        _answer(decision="none", thesis="Nothing moved more than 777% today."),
        _answer(decision="none", thesis="Nothing worth buying today."),
    )
    result = await _scan(loaded, agent, llm)
    assert result.outcome == "no_trade", result.problems
    assert len(llm.verdicts) == 2


async def test_a_figure_from_the_agents_own_instructions_is_sourced(
    loaded: Engine, agent: ScanAgent
) -> None:
    # Test agent's rule quoted in its pass was refused twice on compose (D227).
    ruled = replace(agent, persona="Buy only after a drop of 3% or more in a day.")
    llm = ScriptedLLM(
        _answer(decision="none", thesis="No large company dropped 3% or more today."),
    )
    result = await _scan(loaded, ruled, llm)
    assert result.outcome == "no_trade", result.problems
    assert llm.verdicts == ["accepted"]


async def test_a_figure_the_instructions_do_not_hold_is_still_refused(
    loaded: Engine, agent: ScanAgent
) -> None:
    ruled = replace(agent, persona="Buy only after a drop of 3% or more in a day.")
    llm = ScriptedLLM(
        _answer(decision="none", thesis="No large company dropped 4% or more today."),
        _answer(decision="none", thesis="No large company dropped 4% or more today."),
    )
    result = await _scan(loaded, ruled, llm)
    assert result.outcome == "invalid_answer"
    assert result.problems == ("figures not in the evidence: 4",)


async def test_an_answer_with_another_fault_is_not_sent_back(
    loaded: Engine, agent: ScanAgent
) -> None:
    # Not tradable as well as unsourced: a second answer is not owed. The script
    # holding one turn is itself the assertion - a retry would run out of it.
    llm = ScriptedLLM(
        _answer(decision="buy", symbol="TSLA", quantity="1", thesis="TSLA will reach 999.00.")
    )
    result = await _scan(loaded, agent, llm)
    assert result.outcome == "invalid_answer"
    assert len(result.problems) == 2
    roles = [entry["role"] for entry in _stored(loaded, result.scan_id).transcript]
    assert "returned" not in roles


@pytest.mark.parametrize(
    ("fields", "reason"),
    [
        ({"decision": "buy", "symbol": "TSLA", "quantity": "1", "thesis": "t"}, "not tradable"),
        ({"decision": "buy", "symbol": "CCJ", "quantity": "1.5", "thesis": "t"}, "whole number"),
        ({"decision": "sell", "symbol": "CCJ", "quantity": "1", "thesis": "t"}, "holds 0"),
        ({"decision": "hold", "thesis": "t"}, "decision is one of"),
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
    # 18 x 54.32 = 977.76 plus the minimum fee fits the 1000.00 of cash;
    # 19 x 54.32 = 1032.08 does not (D54, D55, D76).
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
    cost = money(19 * 5_432 + fee_minor(Decimal("19")), "USD")
    assert short.problems == (
        f"buying 19 CCJ at 54.32 costs {cost} with the fee; cash after the other proposals"
        " is 1000.00",
    )
    assert _stored(loaded, short.scan_id).answer["trades"][0]["price_minor"] == 5_432
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
    bad = _answer(decision="buy", symbol="CCJ", quantity="7", thesis="7 now, 777 next week.")
    llm = ScriptedLLM(bad, bad)
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


async def test_the_users_monthly_cap_ends_the_scan_as_cap_reached(
    loaded: Engine, agent: ScanAgent
) -> None:
    with loaded.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO llm_calls (user_id, purpose, provider, outcome, latency_ms, prompt, "
                "cost_micro_usd) VALUES (CAST(:u AS uuid), 'ask', 'openrouter', 'ok', 1, 'p', "
                "(SELECT llm_cap_micro_usd FROM users WHERE id = CAST(:u AS uuid)))"
            ),
            {"u": agent.user_id},
        )
    inner = ScriptedLLM()
    capped = MonthlyCapProvider(
        inner,  # type: ignore[arg-type]
        DatabaseCapLedger(loaded),
        model="vendor/unpriced",
        prices={},
        unknown_price_usd_per_mtok=DEFAULT_UNKNOWN_MODEL_PRICE_USD_PER_MTOK,
        max_output_tokens=1,
    )

    result = await _scan(loaded, agent, capped)  # type: ignore[arg-type]

    assert result.outcome == "cap_reached"
    assert _stored(loaded, result.scan_id).outcome == "cap_reached"
    assert inner.offered == []


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


# -- several trades a scan (D197) ----------------------------------------------------


def _limit(engine: Engine, agent: ScanAgent, max_decisions: int) -> ScanAgent:
    with engine.begin() as connection:
        connection.execute(
            text("UPDATE agents SET max_decisions = :n WHERE id = CAST(:a AS uuid)"),
            {"n": max_decisions, "a": agent.agent_id},
        )
    found = find_agent(engine, agent.user_id, agent.agent_id)
    assert found is not None and found.max_decisions == max_decisions
    return found


def _hold(engine: Engine, agent: ScanAgent, symbol: str, quantity: str, cost_minor: int) -> None:
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                INSERT INTO holdings (user_id, agent_id, instrument_id, quantity,
                                      cost_basis_minor, opened_at)
                VALUES (CAST(:u AS uuid), CAST(:a AS uuid), CAST(:i AS uuid),
                        CAST(:q AS numeric), :c, '2026-10-01')
                """
            ),
            {
                "u": agent.user_id,
                "a": agent.agent_id,
                "i": _instrument(engine, symbol),
                "q": quantity,
                "c": cost_minor,
            },
        )


def _waiting(
    engine: Engine, agent: ScanAgent, side: str, symbol: str, quantity: str, price: int
) -> None:
    """A trade proposal from an earlier scan, still waiting for the user."""
    with engine.begin() as connection:
        scan = connection.execute(
            text(
                "INSERT INTO agent_scans (user_id, agent_id, trigger, briefing, finished_at, "
                "outcome) VALUES (CAST(:u AS uuid), CAST(:a AS uuid), 'schedule', '{}', now(), "
                "'trade') RETURNING id"
            ),
            {"u": agent.user_id, "a": agent.agent_id},
        ).scalar_one()
        observation = connection.execute(
            text(
                "INSERT INTO observations (user_id, agent_id, kind, severity, subject_kind, "
                "subject_ref, headline, explanation, evidence, dedupe_key) VALUES "
                "(CAST(:u AS uuid), CAST(:a AS uuid), 'agent_trade', 'notable', 'instrument', "
                ":ref, 'h', 'e', '{}', :key) RETURNING id"
            ),
            {
                "u": agent.user_id,
                "a": agent.agent_id,
                "ref": f"instrument:{symbol}",
                "key": f"k:{scan}",
            },
        ).scalar_one()
        connection.execute(
            text(
                "INSERT INTO proposals (user_id, agent_id, observation_id, kind, payload, "
                "expires_at, scan_id) VALUES (CAST(:u AS uuid), CAST(:a AS uuid), :o, :kind, "
                "CAST(:payload AS jsonb), now() + interval '1 hour', :s)"
            ),
            {
                "u": agent.user_id,
                "a": agent.agent_id,
                "o": observation,
                "kind": side,
                "s": scan,
                "payload": json.dumps(
                    {"symbol": symbol, "quantity": quantity, "priceMinor": price, "currency": "USD"}
                ),
            },
        )


async def test_a_sell_funds_a_buy_in_the_same_answer_and_the_buy_names_it(
    loaded: Engine, agent: ScanAgent
) -> None:
    agent = _limit(loaded, agent, 3)
    _hold(loaded, agent, "NXE", "20", 500)
    market = ScriptedMarket()
    market.prices = {"NXE": 600, "CCJ": 5_432}
    # 1000.00 of cash buys 18 CCJ at 54.32 with the fee; 20 more need the sale of NXE.
    llm = ScriptedLLM(_trades(_trade("buy", "CCJ", "20"), _trade("sell", "NXE", "20")))

    result = await _scan(loaded, agent, llm, market)

    assert result.outcome == "trade", result.problems
    trades = _stored(loaded, result.scan_id).answer["trades"]
    # Sells are reviewed first, and stored in the order they were kept.
    assert [(t["decision"], t["symbol"], t["funded_by"]) for t in trades] == [
        ("sell", "NXE", []),
        ("buy", "CCJ", ["NXE"]),
    ]


async def test_the_good_trades_are_kept_and_only_the_bad_one_goes_back(
    loaded: Engine, agent: ScanAgent
) -> None:
    agent = _limit(loaded, agent, 3)
    market = ScriptedMarket()
    market.prices = {"NXE": 600, "CCJ": 5_432}
    llm = ScriptedLLM(
        _trades(
            _trade("buy", "NXE", "10", "NXE is a uranium developer."),
            _trade("buy", "CCJ", "2", "CCJ will reach 80.00."),
        ),
        _trades(_trade("buy", "CCJ", "2", "CCJ trades at 54.32.")),
    )

    result = await _scan(loaded, agent, llm, market)

    assert result.outcome == "trade", result.problems
    assert [t["symbol"] for t in _stored(loaded, result.scan_id).answer["trades"]] == ["NXE", "CCJ"]
    # Only CCJ was sent back, named with its figure.
    heard = str(llm.heard[-1])
    assert "CCJ: figures not in the evidence: 80.00" in heard and "NXE:" not in heard


async def test_a_trade_still_failing_after_its_chance_is_dropped_and_the_rest_proposed(
    loaded: Engine, agent: ScanAgent
) -> None:
    agent = _limit(loaded, agent, 3)
    market = ScriptedMarket()
    market.prices = {"NXE": 600, "CCJ": 5_432}
    llm = ScriptedLLM(
        _trades(_trade("buy", "NXE", "10"), _trade("buy", "CCJ", "2", "CCJ will reach 80.00.")),
        _trades(_trade("buy", "CCJ", "2", "CCJ will reach 90.00.")),
    )

    result = await _scan(loaded, agent, llm, market)

    assert result.outcome == "trade"
    trades = _stored(loaded, result.scan_id).answer["trades"]
    assert [(t["symbol"], t.get("refused", False)) for t in trades] == [
        ("NXE", False),
        ("CCJ", True),
    ]
    assert result.problems == ("figures not in the evidence: 90.00",)


async def test_trades_past_the_agents_limit_are_refused(loaded: Engine, agent: ScanAgent) -> None:
    agent = _limit(loaded, agent, 1)
    market = ScriptedMarket()
    market.prices = {"NXE": 600, "CCJ": 5_432}
    llm = ScriptedLLM(_trades(_trade("buy", "NXE", "1"), _trade("buy", "CCJ", "1")))

    result = await _scan(loaded, agent, llm, market)

    assert result.outcome == "trade"
    assert result.problems == ("over this agent's limit of 1 decisions a scan",)
    assert "at most one trade" in instructions(agent)


async def test_a_waiting_proposal_is_briefed_not_repeated_and_its_cash_set_aside(
    loaded: Engine, agent: ScanAgent
) -> None:
    agent = _limit(loaded, agent, 3)
    _waiting(loaded, agent, "buy", "CCJ", "10", 5_000)  # 500.00 and its fee are spoken for
    market = ScriptedMarket()
    market.prices = {"NXE": 600, "CCJ": 5_432}
    llm = ScriptedLLM(_trades(_trade("buy", "CCJ", "1"), _trade("buy", "NXE", "90")))

    result = await _scan(loaded, agent, llm, market)

    row = _stored(loaded, result.scan_id)
    assert row.briefing["waiting_for_approval"][0] | {"expires_at": None} == {
        "side": "buy",
        "symbol": "CCJ",
        "quantity": "10",
        "price": "50.00",
        "expires_at": None,
    }
    assert result.outcome == "invalid_answer"
    assert result.problems[0] == "buy CCJ is already waiting for the user's approval"
    # 90 NXE at 6.00 is 540.00 plus the fee: more than what the waiting buy leaves.
    assert "cash after the other proposals is" in result.problems[1]


async def test_a_buy_over_the_mandate_goes_back_alone_and_the_sell_stays(
    loaded: Engine, agent: ScanAgent
) -> None:
    agent = _limit(loaded, agent, 3)
    with loaded.begin() as connection:
        connection.execute(
            text("UPDATE agents SET blocked_symbols = '{CCJ}' WHERE id = CAST(:a AS uuid)"),
            {"a": agent.agent_id},
        )
    agent = find_agent(loaded, agent.user_id, agent.agent_id)
    assert agent is not None
    _hold(loaded, agent, "NXE", "20", 500)
    market = ScriptedMarket()
    market.prices = {"NXE": 600, "CCJ": 5_432}
    llm = ScriptedLLM(
        _trades(_trade("sell", "NXE", "5"), _trade("buy", "CCJ", "1")),
        _trades(thesis="CCJ is blocked; the sale stands alone."),  # withdraws it
    )

    result = await _scan(loaded, agent, llm, market)

    assert result.outcome == "trade"
    assert "CCJ: CCJ is on this agent's blocked list" in llm.heard[-1].text
    # Withdrawn by the agent, not refused: only the sale is stored as a trade.
    assert [t["symbol"] for t in _stored(loaded, result.scan_id).answer["trades"]] == ["NXE"]
