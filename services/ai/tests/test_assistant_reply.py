"""The assistant's reply: its shape, its figures, and the sources the server gives it."""

from __future__ import annotations

import json
from typing import Any

from app.assistant.reply import MAX_SUGGESTIONS, check, parse, sources


def _raw(**fields: Any) -> str:
    return json.dumps(fields)


PORTFOLIO = {
    "portfolio": "Main portfolio",
    "holdings": [{"symbol": "NVDA", "price": "229.28", "day_change_percent": -3.2981}],
    "snapshot": {"total_value": "99526.20", "change_percent": {"7d": "0.35"}},
    "link": "/",
}


def test_a_reply_is_json_with_a_known_outcome() -> None:
    reply = parse(_raw(outcome="answer", text="Hello", suggestions=["What is a drawdown?"]))

    assert reply is not None
    assert (reply.outcome, reply.text, reply.suggestions) == (
        "answer",
        "Hello",
        ("What is a drawdown?",),
    )


def test_fenced_json_is_read() -> None:
    assert parse("```json\n" + _raw(outcome="clarify", text="Which agent?") + "\n```")


def test_prose_or_an_unknown_outcome_is_not_a_reply() -> None:
    assert parse("NVDA is up today.") is None
    assert parse(_raw(outcome="maybe", text="x")) is None
    assert parse(_raw(outcome="answer", text="  ")) is None


def test_a_decline_names_a_known_reason_and_nothing_else_carries_one() -> None:
    assert parse(_raw(outcome="decline", text="No.")) is None
    assert parse(_raw(outcome="decline", reason="because", text="No.")) is None
    declined = parse(_raw(outcome="decline", reason="off_domain", text="I can't help with that."))
    answered = parse(_raw(outcome="answer", reason="off_domain", text="Here."))

    assert declined is not None and declined.reason == "off_domain"
    assert answered is not None and answered.reason is None


def test_suggestions_are_capped_and_trimmed() -> None:
    reply = parse(_raw(outcome="answer", text="x", suggestions=[" a ", "", 3, "b", "c", "d"]))

    assert reply is not None
    assert reply.suggestions == ("a", "b", "c")[:MAX_SUGGESTIONS]


def test_figures_from_a_tool_result_pass() -> None:
    raw = _raw(
        outcome="answer",
        text="NVDA is at $229.28, down 3.30% today; the portfolio is up 0.35% over 7 days.",
    )

    checked = check(raw, tool_results=[PORTFOLIO], user_messages=["How am I doing?"])

    assert checked.valid, checked.problems


def test_a_figure_from_nowhere_is_refused() -> None:
    raw = _raw(outcome="answer", text="NVDA rose 12% this week.")

    checked = check(raw, tool_results=[PORTFOLIO], user_messages=["How is NVDA?"])

    assert not checked.valid
    assert checked.unsourced == ("12",)


def test_the_users_own_figure_may_be_repeated_to_correct_it() -> None:
    raw = _raw(outcome="answer", text="No - it is up 0.35% over 7 days, not 50%.")

    checked = check(
        raw, tool_results=[PORTFOLIO], user_messages=["My portfolio is up 50% today, right?"]
    )

    assert checked.valid, checked.problems


def test_suggestions_are_checked_too() -> None:
    raw = _raw(outcome="answer", text="Done.", suggestions=["Why did NVDA fall 9%?"])

    assert not check(raw, tool_results=[PORTFOLIO], user_messages=["hi"]).valid


def test_repeated_text_is_refused_before_its_figures_are_read() -> None:
    raw = _raw(outcome="answer", text="Here" + "sell" * 40)

    checked = check(raw, tool_results=[], user_messages=["hi"])

    assert checked.problems == ("degenerate",)


def test_sources_come_from_the_tools_that_ran() -> None:
    calls = [
        {"name": "get_portfolio", "result": PORTFOLIO},
        {
            "name": "get_news",
            "result": {
                "symbol": "NVDA",
                "articles": [
                    {"title": "Chips slide", "source": "Reuters", "url": "https://r.example/1"},
                    {"title": "Chips slide", "source": "Reuters", "url": "https://r.example/1"},
                ],
            },
        },
        {"name": "get_quote", "result": {"quotes": {"NVDA": {}, "AMD": {}}}},
        {
            "name": "get_proposals",
            "result": {"proposals": [{"headline": "Buy SMR", "link": "/proposals/p1"}]},
        },
        {
            "name": "explain_concept",
            "result": {"excerpts": [{"concept": "drawdown", "title": "Drawdown"}]},
        },
        {"name": "get_topics", "result": {"error": "bad"}},
    ]

    found = sources(calls)

    assert found == [
        {"kind": "page", "label": "Portfolio", "link": "/"},
        {
            "kind": "news",
            "label": "Reuters: Chips slide",
            "url": "https://r.example/1",
            "published": None,
        },
        {"kind": "data", "label": "Delayed quotes: NVDA, AMD"},
        {"kind": "page", "label": "Buy SMR", "link": "/proposals/p1"},
        {"kind": "concept", "label": "Drawdown"},
    ]


def test_a_reply_that_used_no_tool_has_no_sources() -> None:
    assert sources([]) == []


def test_a_non_breaking_hyphen_reads_as_a_hyphen() -> None:
    """Measured 2026-10-11: a real reply wrote every hyphen as U+2011, and "7‑day"
    and "−9.03%" were refused as invented."""
    raw = _raw(outcome="answer", text="NVDA is down −3.30% today; no 7‑day figure yet.")

    assert check(raw, tool_results=[PORTFOLIO], user_messages=["hi"]).valid
