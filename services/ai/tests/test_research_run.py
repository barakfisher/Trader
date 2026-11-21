"""What one holding's rating does with the model's answer (D417).

The whole run is tested over real SQL (`integration/test_research_sql.py`).
This file pins the part that needs no database: an answer the output limit cut
is not sent back, while an answer a check refused still is.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import pytest

from app.agents.scan_budget import AgentBudget
from app.agents.scan_log import ScanAgent
from app.llm.base import LLMCompletion, TokenUsage
from app.research import run as research_run
from app.research.rating import MAX_RATIONALE_CHARS, UNSOURCED_PREFIX
from app.research.run import (
    CUT_BY_LIMIT,
    MAX_OUTPUT_TOKENS,
    RESEARCH_ATTEMPTS,
    RunTally,
)

NOW = datetime(2026, 11, 20, 21, 17, tzinfo=UTC)
CALL_COST = 1_000
EVIDENCE = {"symbol": "CCJ", "quote": {"price": "54.32", "currency": "USD"}}
AGENT = ScanAgent(
    agent_id="90000000-0000-0000-0000-0000000000a1",
    user_id="00000000-0000-0000-0000-000000000001",
    name="Analyst",
    persona="A patient value investor.",
    state="active",
    is_primary=False,
)


def _completion(text: str, *, truncated: bool = False) -> LLMCompletion:
    return LLMCompletion(
        text=text,
        model="scripted/model",
        usage=TokenUsage(prompt_tokens=10, completion_tokens=5),
        estimated_cost_micro_usd=CALL_COST,
        provider="scripted",
        truncated=truncated,
    )


WHOLE = json.dumps(
    {"rating": "hold", "rationale": "CCJ trades at 54.32.", "findings": ["Steady news."]}
)
#: A real answer's shape when the limit falls: valid JSON up to the cut.
CUT = WHOLE[: len(WHOLE) // 2]


class ScriptedLLM:
    def __init__(self, *answers: LLMCompletion) -> None:
        self.answers = list(answers)
        self.calls: list[dict[str, Any]] = []
        self.verdicts: list[str] = []

    async def complete(self, **kwargs: Any) -> LLMCompletion:
        self.calls.append(kwargs)
        return self.answers.pop(0)

    async def record_verdict(self, _call_id: int | None, verdict: str) -> None:
        self.verdicts.append(verdict)


@pytest.fixture(autouse=True)
def within_allowance(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        research_run,
        "agent_budget",
        lambda *_a: AgentBudget(allowance_micro_usd=CALL_COST * 100, spent_micro_usd=0),
    )


async def _rate(llm: ScriptedLLM) -> tuple[Any, list[str], RunTally]:
    tally = RunTally()
    parsed, problems, _model = await research_run._rate(
        engine=object(),  # type: ignore[arg-type]
        llm=llm,  # type: ignore[arg-type]
        agent=AGENT,
        evidence=EVIDENCE,
        held=True,
        tally=tally,
        now=NOW,
    )
    return parsed, problems, tally


async def test_an_answer_cut_by_the_limit_is_not_sent_back() -> None:
    llm = ScriptedLLM(_completion(CUT, truncated=True), _completion(WHOLE))

    parsed, problems, tally = await _rate(llm)

    assert parsed is None
    assert len(problems) == 1 and problems[0].startswith(CUT_BY_LIMIT)
    # One call, paid once: the second answer was never asked for.
    assert len(llm.calls) == 1
    assert tally.cost_micro_usd == CALL_COST
    assert llm.verdicts == ["malformed"]


async def test_every_call_asks_for_the_research_limit() -> None:
    llm = ScriptedLLM(_completion(WHOLE))

    await _rate(llm)

    assert llm.calls[0]["max_output_tokens"] == MAX_OUTPUT_TOKENS


async def test_a_malformed_answer_that_was_not_cut_still_goes_back() -> None:
    # Prose instead of JSON is the model's mistake, and telling it so can fix it.
    llm = ScriptedLLM(_completion("I would hold CCJ."), _completion(WHOLE))

    parsed, problems, tally = await _rate(llm)

    assert parsed is not None and parsed.rating == "hold"
    assert problems == []
    assert len(llm.calls) == RESEARCH_ATTEMPTS
    assert "Your previous answer was refused" in llm.calls[1]["user"]
    assert tally.cost_micro_usd == RESEARCH_ATTEMPTS * CALL_COST
    assert llm.verdicts == ["malformed", "accepted"]


async def test_a_whole_answer_that_reached_the_limit_is_kept() -> None:
    # The limit can fall after the closing brace: the answer parses, so it is checked.
    llm = ScriptedLLM(_completion(WHOLE, truncated=True))

    parsed, problems, _tally = await _rate(llm)

    assert parsed is not None and problems == []
    assert llm.verdicts == ["accepted"]


async def test_a_whole_answer_at_the_limit_that_a_check_refuses_still_goes_back() -> None:
    # Whole JSON whose rationale is too long: the limit did not cut it, so asking
    # again can fix it, and it is not stored as a cut answer.
    long = json.dumps({"rating": "hold", "rationale": "x" * (MAX_RATIONALE_CHARS + 1)})
    llm = ScriptedLLM(_completion(long, truncated=True), _completion(WHOLE))

    parsed, problems, _tally = await _rate(llm)

    assert parsed is not None and problems == []
    assert len(llm.calls) == RESEARCH_ATTEMPTS


async def test_an_unsourced_figure_goes_back_once_and_is_then_refused() -> None:
    invented = json.dumps({"rating": "hold", "rationale": "CCJ is a buy at 99.99."})
    llm = ScriptedLLM(*([_completion(invented)] * RESEARCH_ATTEMPTS))

    parsed, problems, tally = await _rate(llm)

    assert parsed is None
    assert len(problems) == 1 and problems[0].startswith(UNSOURCED_PREFIX)
    assert len(llm.calls) == RESEARCH_ATTEMPTS
    assert tally.cost_micro_usd == RESEARCH_ATTEMPTS * CALL_COST
    assert llm.verdicts == ["unsourced_figures"] * RESEARCH_ATTEMPTS
