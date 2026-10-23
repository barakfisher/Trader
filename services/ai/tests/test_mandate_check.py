"""The contradiction check (D176-D178): what the model may say, and what reaches the user.

The model is scripted. What is pinned is the code's side: the model names a
sentence by number and the quote is cut from the user's text (D183), a number
with no sentence behind it is dropped, a malformed answer is a quiet skip, and
every reason not to check is `skipped`, never an error.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.agents.mandate import Mandate
from app.agents.mandate_check import (
    MAX_CONFLICTS,
    MAX_QUOTE_CHARS,
    SETTINGS,
    check_instructions,
    parse_conflicts,
    sentences,
    settings_text,
)
from app.agents.scan_budget import AgentBudget
from app.agents.scan_log import ScanAgent
from app.config import Settings, get_settings
from app.db import get_engine
from app.llm.base import (
    LLMBudgetExceededError,
    LLMCompletion,
    LLMRequestError,
    MonthlyCapReachedError,
    OwnKeyRequiredError,
    TokenUsage,
)
from app.main import app
from app.models import MandateConflict

INTERNAL_KEY = "test-key"
USER = "00000000-0000-0000-0000-000000000001"
AGENT = "90000000-0000-0000-0000-0000000000a1"
WORDS = "Trade momentum   daily and sell within the week.\nAvoid ETFs entirely."
LONG_TERM = Mandate(horizon="long", max_position_bps=1000)


def _agent(**overrides: Any) -> ScanAgent:
    fields: dict[str, Any] = {
        "agent_id": AGENT,
        "user_id": USER,
        "name": "Value",
        "persona": WORDS,
        "state": "active",
        "is_primary": False,
        "mandate": LONG_TERM,
        **overrides,
    }
    return ScanAgent(**fields)


class ScriptedLLM:
    def __init__(self, reply: str | Exception) -> None:
        self.reply = reply
        self.calls: list[dict[str, Any]] = []
        self.verdicts: list[str] = []

    async def complete(self, **kwargs: Any) -> LLMCompletion:
        self.calls.append(kwargs)
        if isinstance(self.reply, Exception):
            raise self.reply
        return LLMCompletion(
            text=self.reply,
            model="m",
            usage=TokenUsage(prompt_tokens=10, completion_tokens=5),
            estimated_cost_micro_usd=100,
            provider="scripted",
            call_id=7,
        )

    async def record_verdict(self, _call_id: int | None, verdict: str) -> None:
        self.verdicts.append(verdict)


def test_the_settings_are_named_as_a_conflict_may_name_them() -> None:
    stated = settings_text(
        Mandate(
            risk_level=3,
            horizon="long",
            thesis_style="academic",
            max_position_bps=1250,
            cash_buffer_bps=2000,
            max_holdings=8,
            allow_etfs=False,
            market_caps=("large",),
            sectors=("Energy",),
            blocked_symbols=("XOM",),
        )
    )
    assert set(stated) == set(SETTINGS)
    assert stated["max_position"] == "at most 12.5% of capital in one position"
    assert settings_text(Mandate()) == {}


def test_the_wire_names_the_same_settings() -> None:
    import typing

    assert set(typing.get_args(MandateConflict.model_fields["setting"].annotation)) == set(SETTINGS)


def test_the_instructions_are_numbered_by_sentence() -> None:
    assert sentences(WORDS) == [
        "Trade momentum daily and sell within the week.",
        "Avoid ETFs entirely.",
    ]
    # A colon does not end a sentence; a line break always does.
    assert sentences("You day-trade: buy movers.\nNo lists") == [
        "You day-trade: buy movers.",
        "No lists",
    ]


def test_the_quote_is_the_numbered_sentence_never_the_models_words() -> None:
    stated = settings_text(LONG_TERM)
    raw = """```json
    {"conflicts": [
      {"setting": "horizon", "sentence": 1, "quote": "Hold for a decade"},
      {"setting": "horizon", "sentence": 9},
      {"setting": "etfs", "sentence": 2},
      {"setting": "made_up", "sentence": 1},
      {"setting": "horizon", "sentence": "1"},
      {"setting": "horizon", "sentence": true}
    ]}
    ```"""
    conflicts = parse_conflicts(raw, WORDS, stated)
    # A quote the model adds is ignored; a sentence that does not exist, a setting that is
    # not set (ETFs are allowed here), a setting that does not exist and a number that is
    # not an integer are all dropped.
    assert conflicts is not None
    assert [(c.setting, c.quote) for c in conflicts] == [
        ("horizon", "Trade momentum daily and sell within the week.")
    ]


def test_a_hebrew_sentence_is_quoted_letter_for_letter() -> None:
    # The first real check (2026-10-19) found this conflict and lost it: the model's copied
    # quote read מנויות for מניות, and an exact match dropped it.
    hebrew = "אתה סוחר יומי: אתה קונה מניות שזזו חזק היום. אתה אף פעם לא מחזיק פוזיציה יותר משבוע."
    conflicts = parse_conflicts(
        '{"conflicts": [{"setting": "horizon", "sentence": 1}]}', hebrew, settings_text(LONG_TERM)
    )
    assert conflicts is not None
    assert conflicts[0].quote == "אתה סוחר יומי: אתה קונה מניות שזזו חזק היום."


def test_a_long_sentence_is_cut_at_a_word() -> None:
    long = "word " * 100
    conflicts = parse_conflicts(
        '{"conflicts": [{"setting": "horizon", "sentence": 1}]}', long, settings_text(LONG_TERM)
    )
    assert conflicts is not None
    quote = conflicts[0].quote
    assert len(quote) <= MAX_QUOTE_CHARS and quote.endswith("word…")


def test_at_most_three_conflicts_and_none_twice() -> None:
    words = "A. B. C. D. E."
    raw = (
        '{"conflicts": ['
        + ",".join(f'{{"setting": "horizon", "sentence": {n}}}' for n in (1, 1, 2, 3, 4, 5))
        + "]}"
    )
    conflicts = parse_conflicts(raw, words, settings_text(LONG_TERM))
    assert conflicts is not None
    assert [c.quote for c in conflicts] == ["A.", "B.", "C."][:MAX_CONFLICTS]


def test_an_answer_that_is_not_the_json_asked_for_is_none() -> None:
    stated = settings_text(LONG_TERM)
    assert parse_conflicts("Looks fine to me.", WORDS, stated) is None
    assert parse_conflicts('{"issues": []}', WORDS, stated) is None
    assert parse_conflicts('{"conflicts": []}', WORDS, stated) == ()


async def test_a_check_is_an_agent_call_on_the_agents_budget() -> None:
    llm = ScriptedLLM('{"conflicts": [{"setting": "horizon", "sentence": 1}]}')
    result = await check_instructions(llm, _agent())  # type: ignore[arg-type]
    assert result.status == "checked" and result.conflicts[0].setting == "horizon"
    caller = llm.calls[0]["caller"]
    assert (caller.purpose, caller.agent_id, caller.user_id) == ("mandate_check", AGENT, USER)
    assert (
        "1. Trade momentum daily and sell within the week.\n2. Avoid ETFs" in llm.calls[0]["user"]
    )
    assert llm.verdicts == ["accepted"]


@pytest.mark.parametrize(
    ("agent", "reply", "reason"),
    [
        (_agent(persona="  "), "{}", "no_instructions"),
        (_agent(mandate=Mandate()), "{}", "no_settings"),
        (_agent(), LLMBudgetExceededError(500_000, 500_000, "2026-10-19"), "budget_spent"),
        # The user's safety limit, and a missing or refused key, each say which (D245).
        (
            _agent(),
            MonthlyCapReachedError(1, 1, 1, datetime(2026, 11, 1, tzinfo=UTC)),
            "safety_limit_reached",
        ),
        (_agent(), OwnKeyRequiredError("own_key_required"), "own_key_required"),
        (_agent(), OwnKeyRequiredError("own_key_failed"), "own_key_failed"),
        (_agent(), LLMRequestError("stub", "down"), "failed"),
        (_agent(), "not json", "failed"),
    ],
)
async def test_every_reason_not_to_check_is_a_quiet_skip(
    agent: ScanAgent, reply: str | Exception, reason: str
) -> None:
    result = await check_instructions(ScriptedLLM(reply), agent)  # type: ignore[arg-type]
    assert (result.status, result.reason, result.conflicts) == ("skipped", reason, ())


@pytest.fixture
def route(monkeypatch: pytest.MonkeyPatch) -> Iterator[dict[str, Any]]:
    state: dict[str, Any] = {"agent": _agent(), "spent": 0}
    monkeypatch.setattr("app.routers.agents.find_agent", lambda *_a: state["agent"])
    monkeypatch.setattr(
        "app.routers.agents.agent_budget",
        lambda *_a: AgentBudget(allowance_micro_usd=500_000, spent_micro_usd=state["spent"]),
    )
    settings = Settings(  # type: ignore[call-arg]
        _env_file=None, internal_api_key=INTERNAL_KEY, llm_provider="openrouter", llm_model="m"
    )
    app.dependency_overrides.clear()
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_engine] = lambda: object()
    previous = getattr(app.state, "llm", None)
    app.state.llm = ScriptedLLM('{"conflicts": [{"setting": "horizon", "sentence": 1}]}')
    state["client"] = TestClient(app)
    yield state
    app.state.llm = previous
    app.dependency_overrides.clear()


def _post(route: dict[str, Any]) -> Any:
    return route["client"].post(
        f"/agents/{AGENT}/mandate-check",
        json={"user_id": USER},
        headers={"x-internal-key": INTERNAL_KEY},
    )


def test_the_route_answers_the_conflicts(route: dict[str, Any]) -> None:
    response = _post(route)
    assert response.status_code == 200
    assert response.json() == {
        "status": "checked",
        "reason": None,
        "conflicts": [
            {"setting": "horizon", "quote": "Trade momentum daily and sell within the week."}
        ],
    }


def test_the_route_skips_with_the_budget_spent_before_any_call(route: dict[str, Any]) -> None:
    route["spent"] = 500_000
    assert _post(route).json() == {"status": "skipped", "reason": "budget_spent", "conflicts": []}
    assert app.state.llm.calls == []


@pytest.mark.parametrize("refusal", ["own_key_required", "own_key_failed", "safety_limit_reached"])
def test_the_route_skips_when_nobody_may_pay_before_any_call(
    route: dict[str, Any], monkeypatch: pytest.MonkeyPatch, refusal: str
) -> None:
    monkeypatch.setattr("app.routers.agents.payer_refusal", lambda *_a: refusal)
    assert _post(route).json() == {"status": "skipped", "reason": refusal, "conflicts": []}
    assert app.state.llm.calls == []


def test_the_route_refuses_the_primary_and_another_users_agent(route: dict[str, Any]) -> None:
    route["agent"] = _agent(is_primary=True)
    assert _post(route).json()["detail"]["code"] == "primary_agent"
    route["agent"] = None
    assert _post(route).status_code == 404
