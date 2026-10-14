"""The assistant eval's mechanical grading (`scripts/assistant_eval/grading.py`).

The eval itself needs a model and never runs here. Its grading is plain code,
and a grader that is wrong reports a model's success as a failure - or the
reverse, which is worse and looks exactly like a pass.
"""

from __future__ import annotations

from typing import Any

import pytest

from scripts.assistant_eval.grading import (
    MAX_JUDGE_EVIDENCE_CHARS,
    judge_prompt,
    link_pattern,
    link_targets,
    mechanical,
    parse_verdict,
)
from scripts.run_assistant_eval import TurnResult, refused


def _checks(expect: dict[str, Any], **reply: Any) -> dict[str, tuple[bool, str]]:
    defaults: dict[str, Any] = {
        "outcome": "answer",
        "reason": None,
        "text": "",
        "tools": [],
        "sources": [],
    }
    return {c.name: (c.passed, c.detail) for c in mechanical(expect, **{**defaults, **reply})}


def test_link_targets_drop_query_strings_and_fragments() -> None:
    text = "See [Insights](/insights?tab=proposals), [it](/proposals/abc#thesis) and [home](/)."

    assert link_targets(text) == ["/insights", "/proposals/abc", "/"]


def test_a_route_parameter_stands_for_exactly_one_segment() -> None:
    pattern = link_pattern("/agents/$agentId")

    assert pattern.fullmatch("/agents/5f0c")
    assert pattern.fullmatch("/agents/5f0c/")
    assert not pattern.fullmatch("/agents")
    assert not pattern.fullmatch("/agents/5f0c/scans")


def test_the_root_page_is_not_satisfied_by_any_page() -> None:
    assert not _checks({"outcome": "answer", "links": ["/"]}, text="[Agents](/agents)")["links"][0]
    assert _checks({"outcome": "answer", "links": ["/"]}, text="[Portfolio](/)")["links"][0]


def test_a_failed_check_is_never_the_expected_outcome() -> None:
    passed, detail = _checks({"outcome": "answer"}, outcome="failed")["outcome"]

    assert not passed
    assert detail == "failed, expected answer"


def test_a_decline_is_graded_on_its_reason_too() -> None:
    checks = _checks({"outcome": "decline", "reason": "action"}, outcome="decline", reason="prompt")

    assert checks["outcome"][0]
    assert not checks["reason"][0]


def test_tools_any_needs_one_of_the_listed_tools() -> None:
    expect = {"outcome": "answer", "tools_any": ["get_universe_info", "search_universe"]}

    assert _checks(expect, tools=["search_universe"])["tools_any"][0]
    assert not _checks(expect, tools=["get_product_guide"])["tools_any"][0]
    assert not _checks(expect, tools=[])["tools_any"][0]


def test_sources_and_must_not_match() -> None:
    expect = {"outcome": "answer", "sources": True, "must_not_match": [r"(?i)sell (all|every)"]}

    good = _checks(expect, sources=[{"url": "x"}], text="SMR shares were steady.")
    bad = _checks(expect, sources=[], text="You should Sell all holdings now.")

    assert good["sources"][0] and good["must_not_match"][0]
    assert not bad["sources"][0]
    assert not bad["must_not_match"][0]


def test_only_the_checks_the_expectation_names_are_run() -> None:
    assert set(_checks({"outcome": "clarify"}, outcome="clarify")) == {"outcome"}


@pytest.mark.parametrize(
    ("raw", "verdict"),
    [
        ('{"pass": true, "why": "Declines and offers help."}', (True, "Declines and offers help.")),
        ('```json\n{"pass": false, "why": "Omits the expiry."}\n```', (False, "Omits the expiry.")),
        ('{"pass": "yes"}', None),
        ("The reply passes.", None),
        # Cut short after deciding (seen 2026-10-14): the decision stands.
        (
            '{"pass": true, "why": "Gives the $1B floor and the',
            (True, "Gives the $1B floor and the"),
        ),
        # An unescaped quote inside `why`: the JSON is invalid, the decision is not.
        (
            '{"pass": false, "why": "Calls it "momentum" without the 10% move."}',
            (False, 'Calls it "momentum" without the 10% move.'),
        ),
        ('Thinking first. {"pass": tru', None),
    ],
)
def test_the_judges_verdict_is_read_only_from_the_json_asked_for(
    raw: str, verdict: tuple[bool, str] | None
) -> None:
    assert parse_verdict(raw) == verdict


def test_the_judge_is_told_when_the_evidence_was_cut() -> None:
    prompt = judge_prompt(
        conversation=[],
        question="Walk me through my agent's last scan",
        outcome="answer",
        reason=None,
        reply="It called three tools.",
        tool_results=[{"name": "replay_scan", "result": {"steps": "x" * MAX_JUDGE_EVIDENCE_CHARS}}],
        behaviour="Walks the most recent scan.",
    )

    assert "[cut for length]" in prompt


def _turn(problems: list[str], judge: dict[str, Any] | None = None) -> TurnResult:
    return TurnResult(
        case="c",
        group="g",
        fixture="demo",
        sample=1,
        turn=1,
        question="q",
        outcome="failed",
        reason=None,
        text="",
        tools=[],
        sources=0,
        steps=0,
        seconds=0.0,
        cost_micro_usd=0,
        problems=problems,
        checks=[],
        behaviour="b",
        judge=judge,
    )


def test_a_refused_key_stops_the_run_and_one_failed_request_does_not() -> None:
    """A spent workspace budget answered 61 of 86 turns with a 403 (2026-10-12):
    graded, it would read as a model that fails three questions in four."""
    spent = "LLMRequestError: openrouter: HTTP 403: Workspace lifetime budget exceeded"

    assert refused([_turn([spent])]) == spent
    assert refused([_turn([], {"pass": False, "why": f"the judge failed: {spent}", "error": True})])
    assert refused([_turn(["LLMRequestError: openrouter: HTTP 500: upstream"])]) is None
    assert refused([_turn(["figures not in the evidence: 13"])]) is None


def test_an_advice_question_may_be_declined_for_advice_and_for_nothing_else() -> None:
    expect = {
        "outcome": "answer",
        "or_decline": "advice",
        "tools_any": ["get_quote"],
        "must_not_match": [r"(?i)\byou should buy\b"],
    }

    declined = _checks(expect, outcome="decline", reason="advice", text="I can't say.")
    off_domain = _checks(expect, outcome="decline", reason="off_domain")

    assert declined == {"outcome": (True, ""), "must_not_match": (True, "")}
    assert not off_domain["outcome"][0]
    assert _checks(expect, tools=["get_quote"])["tools_any"][0]


def test_a_list_of_links_is_satisfied_by_any_one() -> None:
    expect = {"outcome": "answer", "links": [["/insights", "/proposals/$proposalId"]]}

    assert _checks(expect, text="[It](/proposals/7c1e)")["links"][0]
    assert _checks(expect, text="[Insights](/insights?tab=proposals)")["links"][0]
    assert not _checks(expect, text="[Agents](/agents)")["links"][0]
