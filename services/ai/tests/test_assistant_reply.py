"""The assistant's reply: its shape, its figures, and the sources the server gives it."""

from __future__ import annotations

import json
from typing import Any

import pytest

from app.assistant.reply import (
    MAX_PROPOSAL_REASON_CHARS,
    MAX_SUGGESTIONS,
    check,
    parse,
    sources,
)


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


#: The shape production refused twice on 2026-11-03 (`llm_calls` 94-95, found in its
#: Langfuse trace): a right answer, its suggestions written without quotes.
UNQUOTED_SUGGESTIONS = r"""```json
{
 "outcome": "answer",
 "text": "בסריקה האחרונה של הסוכן, הכלים נקראו בסדר הזה:\n1. `search_universe`\n2. `get_quote`",
 "suggestions": [
   מה התזה של הסוכן שלי?,
   איך עובדים הסוכנים באפליקציה?
 ]
}
```"""


def test_a_reply_whose_suggestions_are_not_json_keeps_its_answer() -> None:
    reply = parse(UNQUOTED_SUGGESTIONS)

    assert reply is not None
    assert reply.outcome == "answer"
    assert reply.text.startswith("בסריקה האחרונה של הסוכן")
    assert reply.suggestions == ()


def test_broken_suggestions_written_first_are_dropped_too() -> None:
    raw = '{"suggestions": [What is a drawdown?], "outcome": "clarify", "text": "Which agent?"}'

    reply = parse(raw)

    assert reply is not None and (reply.outcome, reply.suggestions) == ("clarify", ())


def test_a_reply_broken_outside_its_suggestions_is_still_malformed() -> None:
    assert parse('{"outcome": "answer", "text": NVDA is up, "suggestions": []}') is None
    assert parse('{"outcome": "answer", "text": "NVDA is up" "suggestions": ["x"]}') is None


def test_a_salvaged_reply_is_checked_for_figures_like_any_other() -> None:
    raw = '{"outcome": "answer", "text": "NVDA fell 9.9% today.", "suggestions": [Why?]}'

    checked = check(raw, tool_results=[PORTFOLIO], user_messages=["How is NVDA?"])

    assert not checked.valid and checked.unsourced == ("9.9",)


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
        {"name": "get_research", "result": {"error": "bad"}},
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


def test_a_replayed_scan_and_the_universe_are_sources_too() -> None:
    calls = [
        {
            "name": "replay_scan",
            "result": {
                "scan_id": "s1",
                "agent": "Momentum",
                "started_at": "2026-10-12T09:00:00+00:00",
                "link": "/agents/a1",
            },
        },
        {"name": "replay_scan", "result": {"note": "no recorded scan matches", "scans": []}},
        {"name": "get_universe_info", "result": {"screened_at": "2026-09-24T12:04:35+00:00"}},
    ]

    assert sources(calls) == [
        {
            "kind": "page",
            "label": "Momentum's scan, 2026-10-12 09:00 UTC",
            "link": "/agents/a1",
        },
        {"kind": "data", "label": "The universe snapshot"},
    ]


def test_a_numbered_list_is_not_read_as_figures() -> None:
    """Measured 2026-10-12: a real step-by-step reply was refused for its "2."."""
    listed = _raw(outcome="answer", text="1. The briefing.\n2. The decision.\n10) The end.")
    inline = _raw(outcome="answer", text="It rose 2. Then 7 more.")

    assert check(listed, tool_results=[], user_messages=["hi"]).valid
    assert check(inline, tool_results=[], user_messages=["hi"]).unsourced == ("2", "7")


def test_a_result_that_carries_an_error_field_is_still_a_source() -> None:
    """Only a tool's refusal - a result that is nothing but `error` - is skipped."""
    calls = [
        {
            "name": "replay_scan",
            "result": {
                "scan_id": "s1",
                "agent": "A",
                "started_at": "t",
                "link": "/agents/a",
                "scan_error": None,
                "error": None,
            },
        },
        {"name": "get_universe_info", "result": {"symbol": {"symbol": "RIVN", "known": True}}},
        {"name": "get_research", "result": {"error": "no such holding"}},
    ]

    assert sources(calls) == [
        {"kind": "page", "label": "A's scan, t", "link": "/agents/a"},
        {"kind": "data", "label": "The universe snapshot"},
    ]


TIMESTAMPED = {
    "loaded_at": "2026-10-12T09:57:05.199619+00:00",
    "screened_at": "2026-09-24T12:04:35+00:00",
}


def test_a_date_the_evidence_states_passes_whole_and_its_digits_source_nothing() -> None:
    """Measured 2026-10-12: a real reply quoting a timestamp was refused for "57",
    and an invented "12%" passed on the 12th because a timestamp held a 12."""
    quoted = _raw(
        outcome="answer", text="Loaded 2026-10-12T09:57:05.199619+00:00; screened 2026-09-24."
    )
    invented = _raw(outcome="answer", text="Up 12% on 2026-10-12.")
    wrong_day = _raw(outcome="answer", text="Screened 2026-09-25.")

    assert check(quoted, tool_results=[TIMESTAMPED], user_messages=["hi"]).valid
    assert check(invented, tool_results=[TIMESTAMPED], user_messages=["hi"]).unsourced == ("12",)
    assert not check(wrong_day, tool_results=[TIMESTAMPED], user_messages=["hi"]).valid


@pytest.mark.parametrize(
    "written", ["12 October", "Oct 12, 2026", "October 12th", "12th of October 2026", "24 Sept."]
)
def test_a_date_in_words_the_evidence_states_passes(written: str) -> None:
    """The instructions ask for "12 October"; Haiku wrote "Oct 12, 2026" and was
    refused for it (measured 2026-10-12, PR 4's eval)."""
    reply = _raw(outcome="answer", text=f"Loaded on {written}.")

    assert check(reply, tool_results=[TIMESTAMPED], user_messages=["hi"]).valid


@pytest.mark.parametrize("written", ["13 October", "Oct 12, 2025", "12 Marketing"])
def test_a_date_in_words_the_evidence_does_not_state_is_checked(written: str) -> None:
    reply = _raw(outcome="answer", text=f"Loaded on {written}.")

    assert not check(reply, tool_results=[TIMESTAMPED], user_messages=["hi"]).valid


def test_a_link_is_checked_as_a_page_never_read_for_figures() -> None:
    linked = _raw(
        outcome="answer",
        text="See [the agent](/agents/491ed17e-cc85-4c47-b55b-c195a7e0d9f5), [home](/) and "
        "[the article](https://r.example/2026/77).",
    )
    invented_page = _raw(outcome="answer", text="See [the universe](/universe) and [home](/).")

    assert check(linked, tool_results=[], user_messages=["hi"]).valid
    checked = check(invented_page, tool_results=[], user_messages=["hi"])
    # A broken link is dropped, its words kept; the reply is not sent back for it.
    assert checked.valid
    assert checked.reply is not None
    assert checked.reply.text == "See the universe and [home](/)."


def test_a_hebrew_reply_is_checked_for_figures_as_an_english_one_is() -> None:
    """D220: a reply is in the question's language, and its figures are still the tools'."""
    sourced = _raw(outcome="answer", text="‏NVDA נסחרת ב-229.28, ירידה של 3.2981% היום.")
    invented = _raw(outcome="answer", text="‏NVDA נסחרת ב-231.10 היום.")

    assert check(sourced, tool_results=[PORTFOLIO], user_messages=["מה המחיר של NVDA?"]).valid
    checked = check(invented, tool_results=[PORTFOLIO], user_messages=["מה המחיר של NVDA?"])
    assert not checked.valid and "231.10" in " ".join(checked.unsourced)


# -- a drafted proposal (D393) -------------------------------------------------


def _with_proposal(proposal: Any, outcome: str = "answer") -> str:
    return json.dumps({"outcome": outcome, "text": "My view.", "proposal": proposal})


def test_an_answer_may_carry_a_drafted_proposal() -> None:
    reply = parse(_with_proposal({"action": "trim", "symbol": " nvda ", "reason": "It ran hard."}))

    assert reply is not None and reply.proposal is not None
    assert (reply.proposal.action, reply.proposal.symbol) == ("trim", "NVDA")
    assert reply.proposal.reason == "It ran hard."


def test_only_an_answer_carries_one() -> None:
    raw = json.dumps(
        {
            "outcome": "clarify",
            "text": "Which stock?",
            "proposal": {"action": "trim", "symbol": "NVDA", "reason": "x"},
        }
    )
    reply = parse(raw)

    assert reply is not None and reply.proposal is None and not reply.proposal_malformed


@pytest.mark.parametrize(
    "proposal",
    [
        {"action": "hold", "symbol": "NVDA", "reason": "x"},
        {"action": "trim", "symbol": "", "reason": "x"},
        {"action": "trim", "symbol": "NVDA"},
        {
            "action": "trim",
            "symbol": "NVDA",
            "reason": " ".join(str(i) for i in range(MAX_PROPOSAL_REASON_CHARS)),
        },
        "trim NVDA",
    ],
)
def test_a_malformed_proposal_goes_back_rather_than_being_dropped(proposal: Any) -> None:
    """Dropped, the answer around it would promise buttons that are not there."""
    checked = check(_with_proposal(proposal), tool_results=[], user_messages=[])

    assert not checked.valid
    assert "the proposal is malformed" in checked.problems[0]


def test_a_proposals_reason_is_checked_for_figures_like_the_answer() -> None:
    raw = _with_proposal({"action": "trim", "symbol": "NVDA", "reason": "Up 83.71% this week."})

    checked = check(raw, tool_results=[], user_messages=[])

    assert checked.unsourced == ("83.71",)
    assert check(raw, tool_results=[{"change": "83.71"}], user_messages=[]).valid
