"""The eval's mechanical readings: what is counted from a scan's transcript (D423)."""

from __future__ import annotations

from typing import Any

from app.agents.answer import UNSOURCED_PREFIX
from app.agents.scan import IDLE_CASH_PROBLEM, ScanResult
from scripts.agent_eval.readings import (
    MIN_SENTENCE_LENGTH,
    PASS_OUTCOME,
    RETURN_KINDS,
    read_scan,
    repeated,
    return_kind,
    sentences,
)

LONG = "x" * MIN_SENTENCE_LENGTH


def _call(name: str) -> dict[str, Any]:
    return {"role": "assistant", "text": "", "tool_calls": [{"id": "1", "name": name}]}


def _scan(
    outcome: str,
    transcript: list[dict[str, Any]],
    answer: dict[str, Any] | None = None,
) -> ScanResult:
    return ScanResult(scan_id="s", outcome=outcome, transcript=transcript, answer=answer)  # type: ignore[arg-type]


def test_a_pass_that_called_no_tool_is_told_from_one_that_looked() -> None:
    blind = read_scan(_scan(PASS_OUTCOME, [], {"trades": [], "thesis": "nothing"}), [])
    looked = read_scan(_scan(PASS_OUTCOME, [_call("get_news")], {"trades": []}), [])
    assert blind.passed_without_tools is True
    assert looked.passed_without_tools is False
    assert looked.tools == ["get_news"]


def test_a_trade_made_without_a_tool_is_not_a_pass_without_tools() -> None:
    trade = {"decision": "buy", "symbol": "NVDA", "thesis": "because"}
    reading = read_scan(_scan("trade", [], {"trades": [trade]}), [])
    assert reading.passed_without_tools is False
    assert reading.trades == ["buy NVDA"]


def test_what_was_sent_back_is_counted_by_kind() -> None:
    transcript = [
        {"role": "returned", "problems": [f"{UNSOURCED_PREFIX}: 20", IDLE_CASH_PROBLEM]},
        {"role": "returned", "problems": ["NVDA would be 43% of the account"]},
    ]
    reading = read_scan(_scan(PASS_OUTCOME, transcript, {"trades": []}), [])
    assert reading.returned == {"figures": 1, "idle_cash": 1, "mandate": 1}
    assert set(reading.returned) == set(RETURN_KINDS)


def test_every_problem_has_one_of_the_kinds() -> None:
    assert return_kind(f"{UNSOURCED_PREFIX}: 7") == "figures"
    assert return_kind(IDLE_CASH_PROBLEM) == "idle_cash"
    # Whatever is neither is the mandate's: the server sends back nothing else (D170).
    assert return_kind("NVDA would be 43% of the account") == "mandate"


def test_a_return_with_no_problems_listed_counts_nothing() -> None:
    reading = read_scan(_scan(PASS_OUTCOME, [{"role": "returned", "problems": None}], None), [])
    assert reading.returned == dict.fromkeys(RETURN_KINDS, 0)


def test_refused_trades_are_counted_by_code_and_kept_ones_listed() -> None:
    answer = {
        "trades": [
            {"decision": "buy", "symbol": "AXON", "thesis": "kept"},
            {"decision": "buy", "symbol": "TTEK", "refused": True, "code": "over_position"},
            {"decision": "sell", "symbol": "PEP", "refused": True, "code": "over_position"},
        ],
        "cash_unjustified": True,
    }
    reading = read_scan(_scan("trade", [], answer), [])
    assert reading.trades == ["buy AXON"]
    assert reading.refused == {"over_position": 2}
    assert reading.cash_unjustified is True


def test_a_sentence_repeated_word_for_word_is_found_and_a_reworded_one_is_not() -> None:
    earlier = [f"Cash stays idle because {LONG}. Something else entirely {LONG}."]
    same = f"Today is new {LONG}.\nCash stays   idle because {LONG}."
    reworded = f"Cash remains idle since {LONG}."
    assert repeated(same, earlier) == [f"Cash stays idle because {LONG}."]
    assert repeated(reworded, earlier) == []


def test_short_sentences_are_not_compared() -> None:
    # One short of the limit with its full stop counted.
    short = "x" * (MIN_SENTENCE_LENGTH - 2)
    assert sentences(f"{short}. {LONG}.") == [f"{LONG}."]
    assert repeated(f"{short}.", [f"{short}."]) == []


def test_the_thesis_read_is_the_overall_one_and_every_trade_s() -> None:
    answer = {"thesis": f"Overall {LONG}.", "trades": [{"symbol": "A", "thesis": f"Trade {LONG}."}]}
    reading = read_scan(_scan("trade", [], answer), [f"Trade {LONG}."])
    assert reading.sentences == 2
    assert reading.repeated_sentences == [f"Trade {LONG}."]


def test_a_tool_answer_with_no_price_is_the_world_s_gap() -> None:
    transcript = [
        {"role": "tool", "name": "get_quote", "result": {"quotes": {}, "unpriced": ["QLYS"]}},
        {"role": "tool", "name": "get_price_history", "result": {"symbol": "QLYS", "closes": []}},
        {"role": "tool", "name": "get_quote", "result": {"quotes": {"NVDA": {}}}},
    ]
    assert read_scan(_scan(PASS_OUTCOME, transcript, None), []).unpriced_answers == 2


def test_a_scan_that_failed_keeps_its_error_and_reads_empty() -> None:
    failed = ScanResult(scan_id="s", outcome="failed", error="TimeoutError: slow")
    reading = read_scan(failed, [])
    assert (reading.outcome, reading.error) == ("failed", "TimeoutError: slow")
    assert (reading.thesis, reading.tools, reading.trades) == (None, [], [])
