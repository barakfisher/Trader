"""The severity ladder: the one place where a number becomes a word."""

from datetime import UTC, datetime

import pytest

from app.analysis.findings import (
    SEVERITY_ORDER,
    Finding,
    SeverityBands,
    cap_severity,
    severity_for,
)

BANDS = SeverityBands(info=0.03, notable=0.05, high=0.08)


# -- band validation ----------------------------------------------------------


def test_bands_must_ascend():
    with pytest.raises(ValueError, match="ascending"):
        SeverityBands(info=0.05, notable=0.03, high=0.08)


def test_bands_must_be_positive():
    # A zero floor would make every observation a finding, including a price that
    # did not move at all.
    with pytest.raises(ValueError, match="positive"):
        SeverityBands(info=0.0, notable=0.05, high=0.08)


def test_equal_bands_are_allowed():
    # An operator who only wants "high" collapses the ladder onto one number.
    bands = SeverityBands(info=0.05, notable=0.05, high=0.05)
    assert severity_for(0.05, bands) == "high"


# -- the ladder ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("magnitude", "expected"),
    [
        (0.0299, None),  # below the floor: no finding at all
        (0.03, "info"),  # the floor itself emits
        (0.0499, "info"),
        (0.05, "notable"),  # each band is inclusive at its lower edge
        (0.0799, "notable"),
        (0.08, "high"),
        (0.42, "high"),
    ],
)
def test_boundaries_are_inclusive_at_the_lower_edge(magnitude, expected):
    assert severity_for(magnitude, BANDS) == expected


def test_direction_does_not_change_severity():
    # A 6% fall and a 6% rise are equally worth reporting; the sign lives in the
    # evidence, not in the severity.
    assert severity_for(-0.06, BANDS) == severity_for(0.06, BANDS) == "notable"


def test_bands_are_reported_as_evidence():
    # The narration is allowed to say "beyond the 3% threshold" only because the
    # threshold it quotes is sourced here.
    assert BANDS.as_evidence() == {"info": 0.03, "notable": 0.05, "high": 0.08}


# -- capping ------------------------------------------------------------------


def test_capping_lowers_but_never_raises():
    assert cap_severity("high", "notable") == "notable"
    assert cap_severity("info", "notable") == "info"
    assert cap_severity("notable", "notable") == "notable"


def test_severity_order_is_ascending():
    assert SEVERITY_ORDER == ("info", "notable", "high")


# -- the finding itself -------------------------------------------------------


def test_findings_compare_by_value_so_a_rerun_deduplicates():
    # Step 8 of the pipeline deduplicates identical findings, which only works
    # because a finding is a value with no identity of its own.
    moment = datetime(2026, 3, 3, 20, 0, tzinfo=UTC)
    first = Finding("price_move", "info", "instrument:AAPL", moment, {"change_pct": 0.04})
    second = Finding("price_move", "info", "instrument:AAPL", moment, {"change_pct": 0.04})
    assert first == second


def test_findings_are_frozen():
    moment = datetime(2026, 3, 3, 20, 0, tzinfo=UTC)
    finding = Finding("price_move", "info", "instrument:AAPL", moment)
    with pytest.raises(AttributeError):
        finding.severity = "high"
