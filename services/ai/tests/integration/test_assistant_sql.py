"""The assistant end to end over real SQL, with a scripted model (migration 0052).

As for an agent's scan (`test_agent_scan_sql.py`), the model is the one part
substituted: each test scripts its turns, so what is tested is what the code
does with them - the tools it runs, the check on the reply, what it stores and
what it refuses. What a real model says is the eval set's job
(`data/eval/assistant.json`), run against a real model in PR 4.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.agents.tools import scan_context
from app.analysis.thresholds import AnalysisThresholds
from app.assistant.budget import assistant_budget, start_of_local_day
from app.assistant.service import NO_REPLY_TEXT, STEP_LIMIT, ask
from app.assistant.tools import (
    TOOLS_BY_NAME,
    get_agents,
    get_observations,
    get_portfolio,
    get_proposals,
    get_topics,
    get_universe_info,
    primary_agent_id,
    replay_scan,
)
from app.corpus.hashed_embedder import HashedEmbedder
from app.corpus.vector_store import PgVectorStore
from app.llm.base import (
    LLMCompletion,
    LLMRequestError,
    LLMUnavailableError,
    TokenUsage,
    ToolCall,
    UserMessage,
)
from tests.integration.conftest import run_script
from tests.integration.test_agent_tools_sql import ScriptedMarket

FIXTURE_EMBEDDER = {"EMBEDDINGS_PROVIDER": "fixture"}
NOW = datetime.now(UTC)
TZ = "Asia/Jerusalem"
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


def _reply(**fields: Any) -> LLMCompletion:
    return _turn(json.dumps(fields))


def _call(name: str, **arguments: Any) -> LLMCompletion:
    return _turn(calls=(ToolCall(id=f"c-{name}", name=name, arguments=json.dumps(arguments)),))


class ScriptedLLM:
    """Answers `converse` from a script; keeps what it was sent."""

    name = "scripted"
    charges_per_token = True

    def __init__(self, *turns: LLMCompletion | Exception) -> None:
        self.turns = list(turns)
        self.sent: list[list[Any]] = []
        self.offered: list[int] = []
        self.purposes: list[str] = []
        self.verdicts: list[str] = []

    async def converse(self, **kwargs: Any) -> LLMCompletion:
        self.sent.append(list(kwargs["messages"]))
        self.offered.append(len(kwargs["tools"]))
        self.purposes.append(kwargs["caller"].purpose)
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


def _instrument(engine: Engine, symbol: str) -> str:
    with engine.connect() as connection:
        return connection.execute(
            text("SELECT id::text FROM instruments WHERE symbol = :s"), {"s": symbol}
        ).scalar_one()


def _symbols(engine: Engine, count: int) -> list[str]:
    with engine.connect() as connection:
        return list(
            connection.execute(
                text(
                    "SELECT i.symbol FROM instruments i JOIN instrument_profiles p "
                    "ON p.instrument_id = i.id WHERE upper(i.currency) = 'USD' "
                    "ORDER BY i.symbol LIMIT :n"
                ),
                {"n": count},
            ).scalars()
        )


@pytest.fixture()
def account(loaded: Engine) -> Iterator[dict[str, Any]]:
    """A user whose real portfolio holds two instruments (one priced) with a snapshot,
    an agent with a pending trade proposal, an expired one, a finding and a topic."""
    held, unpriced = _symbols(loaded, 2)
    with loaded.begin() as connection:
        user = connection.execute(
            text("INSERT INTO users (role) VALUES ('user') RETURNING id::text")
        ).scalar_one()
        primary = primary_agent_id(connection, user)
        agent = connection.execute(
            text(
                "INSERT INTO agents (user_id, slug, name, persona, budget_minor) "
                "VALUES (CAST(:u AS uuid), 'momentum', 'Momentum', 'Follows strength.', 100000) "
                "RETURNING id::text"
            ),
            {"u": user},
        ).scalar_one()
        for symbol, quantity in ((held, "10"), (unpriced, "3")):
            connection.execute(
                text(
                    "INSERT INTO holdings (user_id, agent_id, instrument_id, quantity, "
                    "cost_basis_minor) VALUES (CAST(:u AS uuid), CAST(:a AS uuid), "
                    "CAST(:i AS uuid), CAST(:q AS numeric), 10000)"
                ),
                {"u": user, "a": primary, "i": _instrument(loaded, symbol), "q": quantity},
            )
        for days_ago, total in ((0, 1_050_000), (7, 1_000_000)):
            connection.execute(
                text(
                    "INSERT INTO portfolio_snapshots (user_id, agent_id, as_of, total_minor, "
                    "cost_minor, currency, breakdown, holdings_count, priced_count, degraded) "
                    "VALUES (CAST(:u AS uuid), CAST(:a AS uuid), CAST(:d AS date), :t, 900000, "
                    "'USD', CAST(:b AS jsonb), 2, 1, true)"
                ),
                {
                    "u": user,
                    "a": primary,
                    "d": (NOW - timedelta(days=days_ago)).date(),
                    "t": total,
                    "b": json.dumps([{"symbol": held, "valueMinor": total, "weightPct": 100}]),
                },
            )
        for key, state, expires in (
            ("pending", "pending", NOW + timedelta(days=1)),
            ("lapsed", "pending", NOW - timedelta(hours=1)),
        ):
            connection.execute(
                text(
                    "INSERT INTO observations (user_id, agent_id, kind, severity, subject_kind, "
                    "subject_ref, headline, evidence, dedupe_key) VALUES (CAST(:u AS uuid), "
                    "CAST(:a AS uuid), 'price_move', 'notable', 'instrument', 'instrument:' || :s, "
                    "'moved', CAST(:e AS jsonb), :k)"
                ),
                {
                    "u": user,
                    "a": agent,
                    "s": held,
                    "e": json.dumps({"change_pct": 0.052}),
                    "k": key,
                },
            )
            connection.execute(
                text(
                    "INSERT INTO proposals (user_id, agent_id, observation_id, kind, payload, "
                    "state, expires_at) SELECT CAST(:u AS uuid), CAST(:a AS uuid), id, "
                    "'rebalance', '{}'::jsonb, :state, :expires FROM observations "
                    "WHERE dedupe_key = :k AND user_id = CAST(:u AS uuid)"
                ),
                {"u": user, "a": agent, "state": state, "expires": expires, "k": key},
            )
        topic = connection.execute(
            text(
                "INSERT INTO topics (user_id, label, status, created_by, confirmed_at) "
                "VALUES (CAST(:u AS uuid), 'Uranium', 'active', 'user', now()) RETURNING id::text"
            ),
            {"u": user},
        ).scalar_one()
        connection.execute(
            text(
                "INSERT INTO topic_instruments (topic_id, user_id, instrument_id, source, "
                "confidence, rationale) VALUES (CAST(:t AS uuid), CAST(:u AS uuid), "
                "CAST(:i AS uuid), 'resolver', 'confident', 'The company mines uranium.')"
            ),
            {"t": topic, "u": user, "i": _instrument(loaded, held)},
        )
    market = ScriptedMarket()
    market.prices[held] = 22928
    yield {
        "user": user,
        "primary": primary,
        "agent": agent,
        "held": held,
        "unpriced": unpriced,
        "market": market,
    }


def _context(engine: Engine, account: dict[str, Any]) -> Any:
    return scan_context(
        engine=engine,
        market=account["market"],
        embedder=HashedEmbedder(),
        vector_store=PgVectorStore(),
        thresholds=AnalysisThresholds(),
        excluded_price_sources=(),
        user_id=account["user"],
        agent_id=account["primary"],
        now=NOW,
    )


async def _ask(
    engine: Engine,
    account: dict[str, Any],
    llm: Any,
    question: str,
    conversation_id: str | None = None,
) -> Any:
    return await ask(
        engine=engine,
        llm=llm,
        context=_context(engine, account),
        question=question,
        conversation_id=conversation_id,
        now=NOW,
        timezone=TZ,
    )


def _stored(engine: Engine, conversation_id: str) -> list[Any]:
    with engine.connect() as connection:
        return list(
            connection.execute(
                text(
                    "SELECT role, content, outcome, reason, sources, suggestions, tool_calls, "
                    "cost_micro_usd FROM assistant_messages "
                    "WHERE conversation_id = CAST(:c AS uuid) ORDER BY created_at, role DESC"
                ),
                {"c": conversation_id},
            ).all()
        )


# -- the tools -----------------------------------------------------------------


async def test_get_portfolio_reports_live_prices_the_snapshot_and_what_is_unpriced(
    loaded: Engine, account: dict[str, Any]
) -> None:
    result = await get_portfolio(_context(loaded, account), {})

    held = {row["symbol"]: row for row in result["holdings"]}
    assert result["real"] is True and result["link"] == "/"
    assert held[account["held"]]["price"] == "229.28"
    assert held[account["held"]]["share_of_total_percent"] == "100.00"
    assert held[account["unpriced"]]["price"] is None
    assert result["unpriced"] == [account["unpriced"]]
    assert result["snapshot"]["total_value"] == "10500.00"
    assert result["snapshot"]["change_percent"]["7d"] == "5.00"
    assert result["snapshot"]["change_percent"]["30d"] is None


async def test_a_portfolio_with_no_snapshot_still_names_its_windows(
    loaded: Engine, account: dict[str, Any]
) -> None:
    """So "no 7-day figure yet" is about a window the evidence names (measured
    2026-10-11: a real reply saying so was refused for the 7 and the 30)."""
    with loaded.begin() as connection:
        connection.execute(
            text("DELETE FROM portfolio_snapshots WHERE user_id = CAST(:u AS uuid)"),
            {"u": account["user"]},
        )

    result = await get_portfolio(_context(loaded, account), {"agent": "None"})

    assert result["real"] is True
    assert result["snapshot"]["total_value"] is None
    assert result["snapshot"]["change_percent"] == {"1d": None, "7d": None, "30d": None}


async def test_get_portfolio_names_the_agents_when_asked_for_one_that_is_not(
    loaded: Engine, account: dict[str, Any]
) -> None:
    result = await get_portfolio(_context(loaded, account), {"agent": "Nobody"})

    assert "Momentum" in result["error"]


async def test_get_agents_values_a_simulated_agent_and_its_spend(
    loaded: Engine, account: dict[str, Any]
) -> None:
    result = await get_agents(_context(loaded, account), {})

    momentum = next(a for a in result["agents"] if a["name"] == "Momentum")
    assert momentum["real"] is False
    assert momentum["paper_budget"] == "1000.00"
    assert momentum["last_scan"] is None
    assert momentum["link"] == f"/agents/{account['agent']}"


async def test_get_proposals_reports_a_lapsed_pending_proposal_as_expired(
    loaded: Engine, account: dict[str, Any]
) -> None:
    context = _context(loaded, account)

    pending = await get_proposals(context, {})
    expired = await get_proposals(context, {"state": "expired"})
    by_symbol = await get_proposals(context, {"state": "any", "symbol": account["held"]})

    assert len(pending["proposals"]) == 1
    assert len(expired["proposals"]) == 1
    assert len(by_symbol["proposals"]) == 2
    assert pending["proposals"][0]["link"].startswith("/proposals/")


async def test_get_observations_and_get_topics_read_the_users_rows(
    loaded: Engine, account: dict[str, Any]
) -> None:
    context = _context(loaded, account)

    observations = await get_observations(context, {"symbol": account["held"]})
    topics = await get_topics(context, {"topic": "uran"})

    assert len(observations["observations"]) == 2
    assert topics["topics"][0]["instruments"][0]["reason"] == "The company mines uranium."


async def test_another_users_rows_are_never_read(loaded: Engine, account: dict[str, Any]) -> None:
    with loaded.begin() as connection:
        stranger = connection.execute(
            text("INSERT INTO users (role) VALUES ('user') RETURNING id::text")
        ).scalar_one()
        stranger_primary = primary_agent_id(connection, stranger)
    context = _context(loaded, {**account, "user": stranger, "primary": stranger_primary})

    assert (await get_proposals(context, {"state": "any"}))["proposals"] == []
    assert (await get_observations(context, {}))["observations"] == []
    assert (await get_topics(context, {}))["topics"] == []
    assert (await get_portfolio(context, {}))["holdings"] == []


def test_no_tool_can_write_what_a_user_decides() -> None:
    """The guardrail by construction: nothing to call that approves, trades or sets."""
    for name in TOOLS_BY_NAME:
        assert not name.startswith(("approve", "reject", "set_", "update", "delete", "trade"))


def _record_scan(engine: Engine, account: dict[str, Any], *, symbol: str, minutes_ago: int) -> str:
    """A finished scan of the account's agent: one tool call, then a buy."""
    transcript = [
        {
            "role": "assistant",
            "text": "",
            "tool_calls": [
                {"id": "c1", "name": "get_quote", "arguments": json.dumps({"symbols": [symbol]})}
            ],
        },
        {
            "role": "tool",
            "call_id": "c1",
            "name": "get_quote",
            "result": {"quotes": {symbol: {"price": "229.28"}}, "padding": "x" * 3000},
        },
        {"role": "assistant", "text": "{}", "tool_calls": []},
    ]
    with engine.begin() as connection:
        return connection.execute(
            text(
                """
                INSERT INTO agent_scans (user_id, agent_id, trigger, started_at, finished_at,
                                         outcome, steps, cost_micro_usd, model, briefing,
                                         transcript, answer)
                VALUES (CAST(:u AS uuid), CAST(:a AS uuid), 'schedule',
                        now() - make_interval(mins => :m), now() - make_interval(mins => :m),
                        'trade', 1, 2500, 'm', CAST(:b AS jsonb), CAST(:t AS jsonb),
                        CAST(:ans AS jsonb))
                RETURNING id::text
                """
            ),
            {
                "u": account["user"],
                "a": account["agent"],
                "m": minutes_ago,
                "b": json.dumps(
                    {
                        "cash": "1000.00",
                        "holdings": [],
                        "movers": {
                            "gainers": [{"symbol": symbol}],
                            "losers": [],
                            "most_active": [],
                        },
                        "followed_topics": [{"topic": "Uranium", "symbols": [symbol]}],
                    }
                ),
                "t": json.dumps(transcript),
                "ans": json.dumps(
                    {"decision": "buy", "symbol": symbol, "quantity": "2", "thesis": "Momentum."}
                ),
            },
        ).scalar_one()


async def test_replay_scan_walks_a_scan_step_by_step(
    loaded: Engine, account: dict[str, Any]
) -> None:
    held = account["held"]
    older = _record_scan(loaded, account, symbol=held, minutes_ago=60)
    latest = _record_scan(loaded, account, symbol=held, minutes_ago=5)

    # Part of the name finds the agent (a real model asked for "Test" for "Test agent").
    result = await replay_scan(_context(loaded, account), {"agent": "moment", "symbol": held})

    assert result["scan_id"] == latest
    assert result["agent"] == "Momentum" and result["outcome"] == "trade"
    assert result["briefing"]["movers"]["gainers"] == [held]
    assert result["briefing"]["followed_topics"] == [{"topic": "Uranium", "symbols": [held]}]
    [step] = result["steps"]
    assert (step["step"], step["tool"], step["arguments"]) == (1, "get_quote", {"symbols": [held]})
    # A long result is cut, and says so.
    assert step["result"]["full_length"] > 3000 and len(step["result"]["truncated"]) < 1300
    assert result["decision"]["thesis"] == "Momentum."
    assert result["link"] == f"/agents/{account['agent']}"
    assert [s["scan_id"] for s in result["other_matching_scans"]] == [older]


async def test_replay_scan_finds_one_scan_by_id_and_only_the_users_own(
    loaded: Engine, account: dict[str, Any]
) -> None:
    scan = _record_scan(loaded, account, symbol=account["held"], minutes_ago=1)
    with loaded.begin() as connection:
        stranger = connection.execute(
            text("INSERT INTO users (role) VALUES ('user') RETURNING id::text")
        ).scalar_one()
        stranger_primary = primary_agent_id(connection, stranger)

    mine = await replay_scan(_context(loaded, account), {"scan_id": scan})
    theirs = await replay_scan(
        _context(loaded, {**account, "user": stranger, "primary": stranger_primary}),
        {"scan_id": scan},
    )

    assert mine["scan_id"] == scan and "other_matching_scans" not in mine
    assert theirs == {"note": "no recorded scan matches", "scans": []}


async def test_get_universe_info_reports_the_snapshot_its_rules_and_a_symbol(
    loaded: Engine, account: dict[str, Any]
) -> None:
    with loaded.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO runs (kind, run_key, trigger, status, started_at, finished_at, stats) "
                "VALUES ('universe_rescreen', :k, 'schedule', 'ok', now(), now(), "
                '\'{"created": 20, "dropped": 22}\')'
            ),
            {"k": f"universe-rescreen:test:{NOW.isoformat()}"},
        )
    context = _context(loaded, account)

    result = await get_universe_info(context, {"symbol": account["held"].lower()})
    unknown = await get_universe_info(context, {"symbol": "ZZZQX"})

    assert result["screened_at"].startswith("2026-")
    assert result["rules"]["min_stock_market_cap"] == "1000000000.00"
    assert result["rules"]["min_etf_net_assets"] == "100000000.00"
    assert result["counts"]["kept"] > 0
    assert result["rescreen_every_days"] == 91
    assert result["last_rescreen"]["dropped"] == 22
    assert result["symbol"]["symbol"] == account["held"] and result["symbol"]["known"] is True
    assert result["symbol"]["membership"] in ("screened", "on_demand", "dropped")
    assert unknown["symbol"] == {"symbol": "ZZZQX", "known": False}


# -- a question ----------------------------------------------------------------


async def test_a_question_runs_a_tool_and_stores_a_checked_reply_with_its_sources(
    loaded: Engine, account: dict[str, Any]
) -> None:
    llm = ScriptedLLM(
        _call("get_portfolio"),
        _reply(
            outcome="answer",
            text="Your portfolio was worth $10,500.00, up 5.00% over 7 days.",
            suggestions=["Which holding moved most?"],
        ),
    )

    turn = await _ask(loaded, account, llm, "How is my portfolio doing?")

    assert turn.outcome == "answer", turn.problems
    assert turn.sources == [{"kind": "page", "label": "Portfolio", "link": "/"}]
    assert turn.suggestions == ["Which holding moved most?"]
    assert turn.steps == 1 and turn.cost_micro_usd == 2 * STEP_COST
    assert llm.purposes == ["assistant", "assistant"]
    assert llm.verdicts == ["accepted"]
    stored = _stored(loaded, turn.conversation_id)
    assert [(m.role, m.outcome) for m in stored] == [("user", None), ("assistant", "answer")]
    assert stored[1].sources == turn.sources
    assert [e["name"] for e in stored[1].tool_calls if e["role"] == "tool"] == ["get_portfolio"]


async def test_an_unsourced_figure_is_sent_back_once_and_the_repair_is_shown(
    loaded: Engine, account: dict[str, Any]
) -> None:
    # Invented figures here have two decimals: a whole number such as "12" can be
    # sourced by a timestamp in the evidence ("2026-10-12T..."), which made this
    # test pass or fail by the day of the month (CI, 2026-10-12).
    llm = ScriptedLLM(
        _call("get_portfolio"),
        _reply(outcome="answer", text="Up 83.71% this week."),
        _reply(outcome="answer", text="Up 5.00% over 7 days."),
    )

    turn = await _ask(loaded, account, llm, "How did I do this week?")

    assert turn.outcome == "answer" and turn.text == "Up 5.00% over 7 days."
    assert llm.verdicts == ["unsourced_figures", "accepted"]
    correction = llm.sent[2][-1]
    assert isinstance(correction, UserMessage)
    assert "figures not in the evidence: 83.71" in correction.text


async def test_a_reply_that_fails_twice_is_not_shown(
    loaded: Engine, account: dict[str, Any]
) -> None:
    llm = ScriptedLLM(
        _reply(outcome="answer", text="NVDA will rise 61.29%."),
        _reply(outcome="answer", text="Fine: 61.29%."),
    )

    turn = await _ask(loaded, account, llm, "Tell me something")

    assert turn.outcome == "failed"
    assert turn.text == NO_REPLY_TEXT["failed"]
    assert "61.29" not in turn.text
    stored = _stored(loaded, turn.conversation_id)
    assert stored[1].outcome == "failed" and stored[1].content == NO_REPLY_TEXT["failed"]
    # The model's words are kept for review, never shown.
    assert "61.29%" in json.dumps(stored[1].tool_calls)


async def test_a_follow_up_sees_the_conversation_and_may_repeat_an_earlier_figure(
    loaded: Engine, account: dict[str, Any]
) -> None:
    first = ScriptedLLM(
        _call("get_portfolio"), _reply(outcome="answer", text="Up 5.00% over 7 days.")
    )
    opened = await _ask(loaded, account, first, "How did I do this week?")
    follow = ScriptedLLM(
        _reply(outcome="answer", text="Your portfolio grew 5.00% in the last 7 days.")
    )

    turn = await _ask(loaded, account, follow, "Say that more simply", opened.conversation_id)

    assert turn.outcome == "answer", turn.problems
    sent = [type(m).__name__ for m in follow.sent[0]]
    assert sent == ["UserMessage", "AssistantMessage", "UserMessage"]
    assert follow.sent[0][1].text == "Up 5.00% over 7 days."


async def test_a_decline_is_stored_with_its_reason(loaded: Engine, account: dict[str, Any]) -> None:
    llm = ScriptedLLM(
        _reply(outcome="decline", reason="off_domain", text="I can only help with investing.")
    )

    turn = await _ask(loaded, account, llm, "What's the weather tomorrow?")

    assert (turn.outcome, turn.reason) == ("decline", "off_domain")
    assert turn.sources == []
    assert _stored(loaded, turn.conversation_id)[1].reason == "off_domain"


async def test_another_users_conversation_is_not_found(
    loaded: Engine, account: dict[str, Any]
) -> None:
    opened = await _ask(
        loaded, account, ScriptedLLM(_reply(outcome="clarify", text="Which one?")), "Hm"
    )
    with loaded.begin() as connection:
        stranger = connection.execute(
            text("INSERT INTO users (role) VALUES ('user') RETURNING id::text")
        ).scalar_one()
        stranger_primary = primary_agent_id(connection, stranger)
    llm = ScriptedLLM()

    turn = await _ask(
        loaded,
        {**account, "user": stranger, "primary": stranger_primary},
        llm,
        "Show me",
        opened.conversation_id,
    )

    assert turn is None
    assert llm.sent == []


async def test_a_spent_budget_answers_without_calling_the_model(
    loaded: Engine, account: dict[str, Any]
) -> None:
    with loaded.begin() as connection:
        connection.execute(
            text("UPDATE installation_settings SET assistant_daily_budget_micro_usd = 0")
        )
    llm = ScriptedLLM()
    try:
        turn = await _ask(loaded, account, llm, "How is my portfolio?")
    finally:
        with loaded.begin() as connection:
            connection.execute(
                text("UPDATE installation_settings SET assistant_daily_budget_micro_usd = 500000")
            )

    assert turn.outcome == "budget_reached"
    assert turn.text == NO_REPLY_TEXT["budget_reached"]
    assert llm.sent == []


async def test_no_model_is_an_outcome_and_the_question_is_kept(
    loaded: Engine, account: dict[str, Any]
) -> None:
    configured_but_absent = await _ask(
        loaded, account, ScriptedLLM(LLMUnavailableError("none")), "Hello?"
    )
    off = await _ask(loaded, account, None, "Hello again?")

    assert configured_but_absent.outcome == "no_model"
    assert off.outcome == "no_model"
    assert [m.role for m in _stored(loaded, off.conversation_id)] == ["user", "assistant"]


async def test_a_blank_question_asks_what_is_wanted_and_stores_nothing(
    loaded: Engine, account: dict[str, Any]
) -> None:
    llm = ScriptedLLM()

    turn = await _ask(loaded, account, llm, "   ")

    assert turn.outcome == "clarify" and turn.conversation_id is None
    assert llm.sent == []


async def test_the_step_limit_leaves_the_model_to_answer_with_what_it_has(
    loaded: Engine, account: dict[str, Any]
) -> None:
    llm = ScriptedLLM(
        *[_call("get_product_guide") for _ in range(STEP_LIMIT)],
        _reply(outcome="answer", text="Traders watches a portfolio."),
    )

    turn = await _ask(loaded, account, llm, "What is this app?")

    assert turn.outcome == "answer"
    assert llm.offered[-1] == 0
    assert turn.steps == STEP_LIMIT


def _spend(engine: Engine, user: str, purpose: str, cost: int, at: datetime) -> None:
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO llm_calls (user_id, provider, outcome, latency_ms, cost_micro_usd, "
                "prompt, started_at, purpose) VALUES (CAST(:u AS uuid), 'scripted', 'ok', 1, "
                ":cost, 'p', :at, :purpose)"
            ),
            {"u": user, "cost": cost, "at": at, "purpose": purpose},
        )


def test_only_the_users_assistant_calls_since_local_midnight_count(
    loaded: Engine, account: dict[str, Any]
) -> None:
    user = account["user"]
    midnight = start_of_local_day(NOW, TZ)
    allowance = assistant_budget(loaded, user, NOW, TZ).allowance_micro_usd
    _spend(loaded, user, "narration", allowance, NOW)
    _spend(loaded, user, "assistant", allowance, midnight - timedelta(minutes=1))
    _spend(loaded, user, "assistant", 1, midnight)

    budget = assistant_budget(loaded, user, NOW, TZ)

    assert budget.spent_micro_usd == 1
    assert not budget.exhausted
    _spend(loaded, user, "assistant", allowance, NOW)
    assert assistant_budget(loaded, user, NOW, TZ).exhausted


async def test_part_of_a_name_finds_one_agent_and_never_guesses_between_two(
    loaded: Engine, account: dict[str, Any]
) -> None:
    context = _context(loaded, account)
    with loaded.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO agents (user_id, slug, name, budget_minor) "
                "VALUES (CAST(:u AS uuid), 'momentum-2', 'Momentum Two', 100000)"
            ),
            {"u": account["user"]},
        )

    exact = await get_portfolio(context, {"agent": "MOMENTUM"})
    partial = await get_portfolio(context, {"agent": "two"})
    ambiguous = await get_portfolio(context, {"agent": "mom"})

    assert exact["portfolio"] == "Momentum"
    assert partial["portfolio"] == "Momentum Two"
    assert "Momentum Two" in ambiguous["error"]
    assert "error" in await get_proposals(context, {"agent": "mom"})


async def test_a_failed_model_call_is_made_once_more(
    loaded: Engine, account: dict[str, Any]
) -> None:
    llm = ScriptedLLM(
        _call("get_portfolio"),
        LLMRequestError("openrouter", "response carried no completion text"),
        _reply(outcome="answer", text="Up 5.00% over 7 days."),
    )

    turn = await _ask(loaded, account, llm, "How did I do this week?")

    assert turn.outcome == "answer", turn.problems
    assert turn.steps == 1


async def test_a_model_call_that_fails_twice_ends_the_question(
    loaded: Engine, account: dict[str, Any]
) -> None:
    error = LLMRequestError("openrouter", "response carried no completion text")
    llm = ScriptedLLM(error, error)

    turn = await _ask(loaded, account, llm, "Hello")

    assert turn.outcome == "failed" and turn.text == NO_REPLY_TEXT["failed"]
    assert len(llm.sent) == 2
