"""The assistant eval file, checked without a database or a model.

The assistant does not exist yet, and every case needs a model to run, so none
of the cases runs on a PR. What can rot meanwhile is the file's grip on the
code it names: a tool renamed in `app/assistant/tools.py`, a page removed from the
web router, a decline that quietly lists tools. Each of those would leave the
eval asserting something that can never happen, which reads as an assistant
failure on the day it first runs. This test keeps them honest until then.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from app.assistant.tools import TOOLS_BY_NAME

ROOT = Path(__file__).resolve().parents[3]
EVAL = ROOT / "data" / "eval" / "assistant.json"
QUESTIONS = ROOT / "docs" / "ASSISTANT_QUESTIONS.md"
ROUTER = ROOT / "apps" / "web" / "src" / "router.tsx"

OUTCOMES = {"answer", "decline", "clarify"}
DECLINE_REASONS = {"off_domain", "advice", "action", "prompt"}
SOURCES = {"user", "claude"}
EXPECT_KEYS = {
    "outcome",
    "reason",
    "or_decline",
    "tools_any",
    "links",
    "sources",
    "must_not_match",
    "behaviour",
}


def _normalise(question: str) -> str:
    return re.sub(r"\s+", " ", question.lower().strip())


@pytest.fixture(scope="module")
def data() -> dict[str, object]:
    return json.loads(EVAL.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def cases(data: dict[str, object]) -> list[dict[str, object]]:
    return data["cases"]  # type: ignore[return-value]


def _turns(cases: list[dict[str, object]]):  # type: ignore[no-untyped-def]
    for case in cases:
        for index, turn in enumerate(case["turns"]):  # type: ignore[arg-type]
            yield f"{case['id']}#{index}", turn


def test_case_ids_and_opening_questions_are_unique(cases: list[dict[str, object]]) -> None:
    ids = [c["id"] for c in cases]
    openers = [_normalise(c["turns"][0]["user"]) for c in cases]  # type: ignore[index]

    assert len(ids) == len(set(ids))
    assert len(openers) == len(set(openers))


def test_every_turn_names_a_known_outcome(cases: list[dict[str, object]]) -> None:
    for where, turn in _turns(cases):
        expect = turn["expect"]
        assert set(expect) <= EXPECT_KEYS, where
        assert expect["outcome"] in OUTCOMES, where
        assert expect["behaviour"].strip(), where
        if expect["outcome"] == "decline":
            assert expect.get("reason") in DECLINE_REASONS, where
        else:
            assert "reason" not in expect, where
        if "or_decline" in expect:
            assert expect["outcome"] == "answer", where
            assert expect["or_decline"] in DECLINE_REASONS, where


def test_a_decline_or_a_clarify_calls_no_tools(cases: list[dict[str, object]]) -> None:
    """An off-domain question answered by searching the news is the failure the
    narrow scope exists to prevent; a case expecting a tool there would reward it."""
    for where, turn in _turns(cases):
        if turn["expect"]["outcome"] != "answer":
            assert "tools_any" not in turn["expect"], where
            assert not turn["expect"].get("sources"), where


def test_every_named_tool_is_registered(
    data: dict[str, object], cases: list[dict[str, object]]
) -> None:
    registry = data["tools"]
    for where, turn in _turns(cases):
        unknown = set(turn["expect"].get("tools_any", [])) - set(registry)  # type: ignore[arg-type]
        assert not unknown, f"{where} names {unknown}"
    for case in cases:
        if "inject" in case:
            assert case["inject"]["tool"] in registry, case["id"]  # type: ignore[index]


def test_tool_status_matches_the_assistants_tools(data: dict[str, object]) -> None:
    """'exists' must be an assistant tool today; 'planned' must not be one yet.

    Renaming a tool fails here instead of on the day the eval first runs.
    Building a planned tool under its planned name fails here too, which is the
    reminder to flip its status.
    """
    for name, entry in data["tools"].items():  # type: ignore[union-attr]
        if entry["status"] == "exists":
            assert name in TOOLS_BY_NAME, f"{name} is not an assistant tool"
        else:
            assert entry["status"] == "planned", name
            assert name not in TOOLS_BY_NAME, f"{name} exists now: mark it 'exists'"


def test_every_planned_tool_is_needed_by_some_case(
    data: dict[str, object], cases: list[dict[str, object]]
) -> None:
    named = {tool for _, turn in _turns(cases) for tool in turn["expect"].get("tools_any", [])}
    planned = {n for n, e in data["tools"].items() if e["status"] == "planned"}  # type: ignore[union-attr]

    assert planned <= named, f"planned but no case needs it: {planned - named}"


def test_every_link_is_a_page_in_the_web_router(cases: list[dict[str, object]]) -> None:
    pages = set(re.findall(r"path: '(/[^']*)'", ROUTER.read_text(encoding="utf-8")))
    for where, turn in _turns(cases):
        named = {
            page
            for link in turn["expect"].get("links", [])
            for page in (link if isinstance(link, list) else [link])
        }
        missing = named - pages
        assert not missing, f"{where} links to {missing}, which the router does not serve"


def test_every_fixture_and_source_is_defined(
    data: dict[str, object], cases: list[dict[str, object]]
) -> None:
    for case in cases:
        assert case["fixture"] in data["fixtures"], case["id"]  # type: ignore[operator]
        assert case["source"] in SOURCES, case["id"]


def test_every_pattern_compiles(cases: list[dict[str, object]]) -> None:
    for where, turn in _turns(cases):
        for pattern in turn["expect"].get("must_not_match", []):
            try:
                re.compile(pattern)
            except re.error as error:
                pytest.fail(f"{where}: {pattern!r} does not compile: {error}")


def test_the_scope_line_is_tested_from_both_sides(cases: list[dict[str, object]]) -> None:
    """Only declines would pass an assistant that refuses everything near the
    line; only answers would pass one that answers everything."""
    scope = [c["turns"][0]["expect"]["outcome"] for c in cases if c["group"] == "scope"]  # type: ignore[index]

    assert "decline" in scope and "answer" in scope


def test_the_guardrails_have_attack_cases(cases: list[dict[str, object]]) -> None:
    attacks = [c for c in cases if c["group"] == "attack"]

    assert len(attacks) >= 6
    assert any("inject" in c for c in attacks), "no case puts instructions in a tool result"
    assert any(len(c["turns"]) > 1 for c in attacks), "no attack spans turns"  # type: ignore[arg-type]


def test_the_users_questions_are_all_cases(cases: list[dict[str, object]]) -> None:
    """The user's own questions are the least biased cases in the set; one
    dropped from the file in an edit should not go unnoticed."""
    text = QUESTIONS.read_text(encoding="utf-8")
    asked = re.findall(r"^\| U\d+ \| ([^|]+?) \|", text, flags=re.MULTILINE)
    present = {_normalise(c["turns"][0]["user"]) for c in cases if c["source"] == "user"}  # type: ignore[index]

    assert asked
    assert {_normalise(q) for q in asked} == present
