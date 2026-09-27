"""Rule 5: a topic's confirmed instruments, measured as one equal-weighted basket.

Same fixture shape as `test_sigma_move.py`: quiet members alternating between
100.00 and 100.50, then one final session that is the event under test. Three
members moving in lockstep make a basket whose own history is exactly that quiet
alternation, so the expected z-scores match the instrument rule's by hand.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.analysis.findings import SeverityBands
from app.analysis.price_series import PricePoint
from app.analysis.thresholds import AnalysisThresholds
from app.analysis.topic_move import (
    FLOORED_SEVERITY_CEILING,
    TOPIC_MIN_COVERAGE,
    TOPIC_MIN_MEMBERS,
    TOPIC_MOVERS_SHOWN,
    TopicMember,
    topic_move_findings,
)
from app.narration.evidence_validator import unsourced_figures
from app.narration.templates import concepts_for, explanation_for, headline_for

MONDAY_CLOSE = datetime(2026, 3, 2, 20, 0, tzinfo=UTC)
TOPIC_ID = "5f0c1d2e-0000-4000-8000-000000000001"

THRESHOLDS = AnalysisThresholds(
    sigma_move=SeverityBands(info=2.0, notable=3.0, high=4.0),
    sigma_window_days=30,
    sigma_min_observations=10,
    sigma_min_move=0.01,
    sigma_stdev_floor=0.0025,
    max_gap_days=5,
)

#: Eleven observations, so ten prior returns: exactly the minimum sample.
QUIET = [10000, 10050, 10000, 10050, 10000, 10050, 10000, 10050, 10000, 10050, 10000]
BARELY_MOVING = [10000, 10001, 10000, 10001, 10000, 10001, 10000, 10001, 10000, 10001, 10000]


def series(prices: list[int], currency: str = "USD", offset: int = 0) -> list[PricePoint]:
    return [
        PricePoint(MONDAY_CLOSE + timedelta(days=index + offset), price, currency)
        for index, price in enumerate(prices)
    ]


def member(symbol: str, prices: list[int], **kwargs: object) -> TopicMember:
    return TopicMember(symbol=symbol, points=series(prices, **kwargs))  # type: ignore[arg-type]


def measure(members: list[TopicMember], thresholds: AnalysisThresholds = THRESHOLDS):
    return topic_move_findings(TOPIC_ID, "uranium", members, thresholds)


# -- happy path ---------------------------------------------------------------


def test_a_topic_that_falls_together_is_one_finding_about_the_topic():
    result = measure(
        [
            member("CCJ", [*QUIET, 9400]),
            member("NXE", [*QUIET, 9500]),
            member("UEC", [*QUIET, 9600]),
        ]
    )

    assert result.skipped_reason is None
    (finding,) = result.findings
    assert finding.kind == "topic_move"
    assert finding.subject_ref == f"topic:{TOPIC_ID}"
    assert finding.severity == "high"
    assert finding.as_of == MONDAY_CLOSE + timedelta(days=11)

    evidence = finding.evidence
    assert evidence["topic_label"] == "uranium"
    assert evidence["basket_change_pct"] == pytest.approx(-0.05)
    assert evidence["equal_weighted"] is True
    assert (evidence["members"], evidence["members_moved"]) == (3, 3)
    assert (evidence["advancers"], evidence["decliners"], evidence["unchanged"]) == (0, 3, 0)
    assert evidence["not_priced_on_session"] == []
    assert evidence["sample_size"] == 10
    # The basket's history is the same quiet alternation as each member's, so
    # the z-score is the instrument rule's -9.5105 for a -5% day.
    assert evidence["z_score"] == pytest.approx(-9.5105, abs=1e-3)


def test_movers_are_the_largest_moves_either_way_and_capped():
    result = measure(
        [
            member("AAA", [*QUIET, 9400]),
            member("BBB", [*QUIET, 10300]),
            member("CCC", [*QUIET, 9000]),
            member("DDD", [*QUIET, 9900]),
            member("EEE", [*QUIET, 9500]),
        ]
    )

    (finding,) = result.findings
    movers = finding.evidence["movers"]
    assert len(movers) == TOPIC_MOVERS_SHOWN
    assert [item["symbol"] for item in movers] == ["CCC", "AAA", "EEE"]
    assert (finding.evidence["advancers"], finding.evidence["decliners"]) == (1, 4)


# -- the set is the subject, not its loudest member ---------------------------


def test_members_that_cancel_out_say_nothing_about_the_topic():
    # One name up 6%, one down 6%: each is a sigma move on its own, and the
    # topic did not move. The per-instrument rules are where those belong.
    result = measure([member("UP", [*QUIET, 10600]), member("DOWN", [*QUIET, 9400])])

    assert result.findings == []
    assert result.skipped_reason is None


def test_an_ordinary_day_for_the_basket_is_quiet_rather_than_skipped():
    result = measure([member("A", [*QUIET, 10050]), member("B", [*QUIET, 10050])])

    assert result.findings == []
    assert result.skipped_reason is None


# -- refusals are reasons, never silence ---------------------------------------


def test_a_single_instrument_is_not_a_basket():
    result = measure([member("CCJ", [*QUIET, 9000])])

    assert result.findings == []
    assert result.skipped_reason is not None
    assert str(TOPIC_MIN_MEMBERS) in result.skipped_reason


def test_too_little_of_the_topic_priced_on_the_session_is_refused():
    # Four confirmed, one priced on the latest session: a quarter of the topic.
    stale = QUIET[:-1]
    result = measure(
        [
            member("A", [*QUIET, 9000]),
            member("B", stale),
            member("C", stale),
            member("D", stale),
        ]
    )

    assert TOPIC_MIN_COVERAGE > 0.25
    assert result.findings == []
    assert result.skipped_reason is not None
    assert "1 of 4" in result.skipped_reason


def test_a_member_missing_from_the_session_is_named_not_dropped():
    result = measure(
        [
            member("A", [*QUIET, 9500]),
            member("B", [*QUIET, 9500]),
            member("C", [*QUIET, 9500]),
            member("LATE", QUIET[:-1]),
        ]
    )

    (finding,) = result.findings
    assert (finding.evidence["members"], finding.evidence["members_moved"]) == (4, 3)
    assert finding.evidence["not_priced_on_session"] == ["LATE"]


def test_a_member_whose_last_price_changed_currency_does_not_count_for_the_session():
    # Its last *return* is a day old, and counting it would misdate the move.
    redenominated = TopicMember(
        symbol="SAP",
        points=[*series(QUIET), PricePoint(MONDAY_CLOSE + timedelta(days=11), 9000, "EUR")],
    )
    result = measure([member("A", [*QUIET, 9500]), member("B", [*QUIET, 9500]), redenominated])

    (finding,) = result.findings
    assert finding.evidence["not_priced_on_session"] == ["SAP"]


def test_too_short_a_history_is_a_reason_not_a_guess():
    short = [10000, 10050, 10000, 10050, 10000]
    result = measure([member("A", [*short, 9000]), member("B", [*short, 9000])])

    assert result.findings == []
    assert result.skipped_reason is not None
    assert str(THRESHOLDS.sigma_min_observations) in result.skipped_reason


def test_a_near_flat_basket_is_capped_when_the_deviation_floor_binds():
    result = measure([member("A", [*BARELY_MOVING, 9800]), member("B", [*BARELY_MOVING, 9800])])

    (finding,) = result.findings
    assert finding.evidence["return_stdev_floor_applied"] is True
    assert finding.severity == FLOORED_SEVERITY_CEILING


# -- the words ------------------------------------------------------------------


def test_the_template_names_the_topic_and_every_figure_is_sourced():
    (finding,) = measure(
        [
            member("CCJ", [*QUIET, 9400]),
            member("NXE", [*QUIET, 9500]),
            member("UEC", [*QUIET, 9600]),
            member("LATE", QUIET[:-1]),
        ]
    ).findings

    headline = headline_for(finding)
    explanation = explanation_for(finding)

    assert headline.startswith("uranium moved -5.0% on average")
    assert TOPIC_ID not in headline and TOPIC_ID not in explanation
    assert "Not priced that day: LATE." in explanation
    assert unsourced_figures(headline, finding.evidence) == []
    assert unsourced_figures(explanation, finding.evidence) == []
    assert concepts_for(finding)
