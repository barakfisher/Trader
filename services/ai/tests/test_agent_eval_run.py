"""The agent-scan eval's run: its spend cap, its guards and the report it writes.

Hermetic: no scan is run here. A sample is built by hand, as `run_sample` leaves it.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest

from app.agents.scan import ScanResult
from scripts.agent_eval.frozen_world import WorldError
from scripts.agent_eval.readings import PASS_OUTCOME, RETURN_KINDS, read_scan
from scripts.run_agent_eval import (
    Sample,
    Spend,
    clone_name,
    digest,
    refused_key,
    run_counter,
    summary,
)

CAP = Decimal("0.50")
THESIS = "Cash stays idle because nothing in the briefing fits the mandate today."


def _sample(
    case: str,
    n: int,
    *,
    outcome: str = PASS_OUTCOME,
    briefing: str = "one",
    transcript: list[dict[str, Any]] | None = None,
    earlier: tuple[str, ...] = (),
    unpriced: tuple[str, ...] = (),
) -> Sample:
    result = ScanResult(
        scan_id="s",
        outcome=outcome,  # type: ignore[arg-type]
        transcript=transcript or [],
        answer={"trades": [], "thesis": THESIS},
        cost_micro_usd=1_000,
    )
    return Sample(
        case=case,
        world="w",
        agent="A",
        sample=n,
        briefing_sha256=briefing,
        readings=read_scan(result, list(earlier)),
        unpriced=list(unpriced),
    )


def _report(samples: list[Sample], spend: Spend | None = None) -> str:
    return summary(
        samples,
        spend or Spend(cap_usd=CAP),
        model="some/model",
        side="main",
        commit="abc1234",
        repeat=2,
    )


# -- the cap ----------------------------------------------------------------------------


def test_a_scan_may_start_until_the_recorded_spend_reaches_the_cap() -> None:
    spend = Spend(cap_usd=CAP)
    assert spend.may_start()
    spend.micro_usd = int(CAP * 1_000_000) - 1
    assert spend.may_start() and spend.stopped is None
    spend.micro_usd = int(CAP * 1_000_000)
    assert not spend.may_start()
    assert spend.stopped is not None and str(CAP) in spend.stopped


def test_a_run_that_stopped_starts_nothing_more_and_keeps_its_first_reason() -> None:
    spend = Spend(cap_usd=CAP, stopped="the provider refused the key")
    assert not spend.may_start()
    assert spend.stopped == "the provider refused the key"


# -- the guards ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    ["redis://127.0.0.1:6379/0", "redis://127.0.0.1:6379", "redis://cache.example.com:6379/5"],
)
def test_the_run_empties_only_a_redis_database_of_its_own(url: str) -> None:
    with pytest.raises(WorldError):
        run_counter(url)


def test_a_numbered_database_on_this_machine_is_the_run_s_to_empty() -> None:
    redis = run_counter("redis://127.0.0.1:56379/1")
    assert redis.connection_pool.connection_kwargs["db"] == 1


def test_a_refused_key_is_told_from_a_scan_that_failed_otherwise() -> None:
    refused = Sample(case="c", world="w", agent="A", sample=1, error="LLMError: HTTP 401 no")
    slow = Sample(case="c", world="w", agent="A", sample=1, error="TimeoutError: slow")
    assert refused_key(refused) == "LLMError: HTTP 401 no"
    assert refused_key(slow) is None
    assert refused_key(_sample("c", 1)) is None


def test_a_briefing_s_digest_ignores_key_order_and_sees_a_changed_value() -> None:
    assert digest({"a": 1, "b": [1, 2]}) == digest({"b": [1, 2], "a": 1})
    assert digest({"a": 1}) != digest({"a": 2})


def test_a_clone_is_named_for_its_case_and_sample_in_plain_characters() -> None:
    assert clone_name("George-2026-11-12", 3) == "run_george_2026_11_12_3_ci"
    assert clone_name("a", 1) != clone_name("a", 2)


# -- the report ---------------------------------------------------------------------------


def test_the_report_names_what_was_run_and_counts_each_reading() -> None:
    looked = [{"role": "assistant", "tool_calls": [{"id": "1", "name": "get_news"}]}]
    samples = [
        _sample("george", 1),
        _sample("george", 2, transcript=looked, earlier=(THESIS,), unpriced=("QLYS",)),
    ]
    report = _report(samples)
    assert "main" in report and "some/model" in report and "abc1234" in report
    assert "| passed (no trade) | 2 / 2 |" in report
    assert "| passed without a tool call | 1 / 2 of the passes |" in report
    assert "| a sentence repeated word for word from an earlier thesis | 1 / 2 |" in report
    assert "| asked a price the frozen world lacks | 1 / 2 |" in report
    for kind in RETURN_KINDS:
        assert f"sent back for {kind.replace('_', ' ')}" in report
    assert "What this cannot show" in report
    # Every thesis is in the report to be read, and the repeat is pointed at.
    assert report.count(f"> {THESIS}") == len(samples)
    assert f"- repeated: {THESIS}" in report
    assert "Unpriced: QLYS." in report


def test_samples_of_one_case_with_different_briefings_are_called_out() -> None:
    fixed = _report([_sample("george", 1), _sample("george", 2)])
    moved = _report([_sample("george", 1), _sample("george", 2, briefing="another")])
    assert "The world moved" not in fixed and "**NO**" not in fixed
    assert "The world moved between samples of ['george']" in moved
    assert moved.count("**NO**") == 2


def test_a_scan_that_could_not_run_is_a_row_and_not_a_reading() -> None:
    missing = Sample(case="warren", world="w", agent="B", sample=1, error="WorldError: no agent")
    report = _report([_sample("george", 1), missing])
    assert "1 of 2 scans ran" in report
    assert "| warren | 1 | **not run**: WorldError: no agent |" in report
    assert "| passed (no trade) | 1 / 1 |" in report


def test_a_run_stopped_early_says_why_at_the_top() -> None:
    spend = Spend(cap_usd=CAP, micro_usd=int(CAP * 1_000_000))
    assert not spend.may_start()
    report = _report([_sample("george", 1)], spend)
    assert f"**Stopped early:** {spend.stopped}" in report
