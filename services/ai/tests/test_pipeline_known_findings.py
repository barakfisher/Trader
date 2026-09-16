"""A repeat must cost a hash, not a completion.

The rules are deterministic and the scan runs every half hour, so most of what a
scan finds is what the last scan found. Narrating those and discarding them on
insert was roughly two hundred throwaway model calls a day.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.analysis.pipeline import ScanSubject, run_portfolio_scan
from app.analysis.price_series import PricePoint
from app.analysis.thresholds import AnalysisThresholds

NOW = datetime(2026, 9, 16, 14, 0, tzinfo=UTC)


class CountingLLM:
    """Records how many times it was asked to write something."""

    name = "counting"
    model = "counting-model"
    charges_per_token = True

    def __init__(self) -> None:
        self.calls = 0

    async def complete(self, *, system, user, max_output_tokens=None, temperature=None):
        self.calls += 1
        raise RuntimeError("narration should not have been attempted")


class StubConnection:
    """Serves one instrument's history, so the pipeline needs no database."""

    def __init__(self, points: list[PricePoint]) -> None:
        self._points = points

    def execute(self, _statement, _parameters):
        return [
            type(
                "Row",
                (),
                {"as_of": p.as_of, "price_minor": p.price_minor, "currency": p.currency},
            )
            for p in self._points
        ]


@pytest.fixture
def falling_series() -> list[PricePoint]:
    # A steady series with a sharp drop at the end: enough to trigger a finding.
    closes = [10_000] * 30 + [9_000]
    start = NOW - timedelta(days=len(closes))
    return [
        PricePoint(as_of=start + timedelta(days=index), price_minor=close, currency="USD")
        for index, close in enumerate(closes)
    ]


SUBJECT = ScanSubject(instrument_id="i1", symbol="TEST", value_minor=100_000, currency="USD")


async def test_a_known_finding_is_never_narrated(falling_series):
    llm = CountingLLM()
    connection = StubConnection(falling_series)

    first, first_stats = await run_portfolio_scan(
        connection,
        [SUBJECT],
        {},
        base_currency="USD",
        thresholds=AnalysisThresholds(),
        llm=None,
        now=NOW,
    )
    assert first, "the fixture series must produce at least one finding"

    # Second scan, same data, with the keys the first produced.
    second, second_stats = await run_portfolio_scan(
        connection,
        [SUBJECT],
        {},
        base_currency="USD",
        thresholds=AnalysisThresholds(),
        llm=llm,
        now=NOW,
        known_dedupe_keys=[item.dedupe_key for item in first],
    )

    assert second == [], "a repeat must produce nothing to store"
    assert second_stats.already_known == first_stats.findings
    assert llm.calls == 0, "the model must not be asked about a finding the caller has"


async def test_findings_are_still_counted_when_skipped(falling_series):
    first, _ = await run_portfolio_scan(
        StubConnection(falling_series),
        [SUBJECT],
        {},
        base_currency="USD",
        thresholds=AnalysisThresholds(),
        llm=None,
        now=NOW,
    )
    _, stats = await run_portfolio_scan(
        StubConnection(falling_series),
        [SUBJECT],
        {},
        base_currency="USD",
        thresholds=AnalysisThresholds(),
        llm=None,
        now=NOW,
        known_dedupe_keys=[item.dedupe_key for item in first],
    )
    # The scan still looked and still found them: reporting zero findings would
    # make a working scan indistinguishable from a broken one.
    assert stats.findings == len(first)
    assert stats.already_known == len(first)


async def test_an_unknown_key_does_not_suppress_anything(falling_series):
    observations, stats = await run_portfolio_scan(
        StubConnection(falling_series),
        [SUBJECT],
        {},
        base_currency="USD",
        thresholds=AnalysisThresholds(),
        llm=None,
        now=NOW,
        known_dedupe_keys=["price_move:some-other-finding"],
    )
    assert observations
    assert stats.already_known == 0
