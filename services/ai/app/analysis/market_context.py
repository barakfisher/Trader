"""What the market did on the day a holding moved (decision 149).

The move rules judge each holding alone, so on a day the whole market falls every
high-beta holding alerts and none of the alerts says so. This module adds that
fact to a move finding's evidence. It does not change whether the finding is
made, or its severity: a 9.5% fall is a 9.5% fall whatever the index did, and a
mute keyed on the market would have silenced exactly the falls a user most needs
to hear about (the measurement behind decision 149 found that a beta-adjusted
mute would have hidden OUST's 9.51% fall on 2026-10-14).

**Which benchmark.** The one that has moved most like the holding: the candidate
whose daily returns best explain the holding's over the fit window (highest R²).
A tech name gets the Nasdaq-100, a small cap the Russell 2000, and nothing is
read from a sector label that may be wrong. Equities choose among the listed
benchmarks; a crypto pair chooses among the crypto ones, because an equity index
says little about a coin. A benchmark is never its own benchmark.

**When it is said.** Only when that benchmark moved at least `market_frame_min_move`
the same way, on the same pair of days as the holding's move. A benchmark priced
on different days than the holding would compare two different moves, so the
step is matched by date and nothing is said when there is no match - a stale
market figure is an invented one (guideline 7).

Pure: the series are the whole world these functions see.
"""

from __future__ import annotations

import math
import statistics
from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import date

from app.analysis.findings import Finding
from app.analysis.price_series import PricePoint, Step, normalise, steps, window
from app.analysis.thresholds import AnalysisThresholds

#: The findings a market line is attached to. A drawdown is a fact about the
#: position since its high, and stays unframed (decision 149).
FRAMED_KINDS = frozenset({"price_move", "sigma_move"})


@dataclass(frozen=True, slots=True)
class Benchmark:
    """A candidate benchmark and its price history."""

    instrument_id: str
    symbol: str
    points: Sequence[PricePoint]
    #: Trades around the clock. Crypto holdings choose among these; others never do.
    continuous: bool


@dataclass(frozen=True, slots=True)
class Fit:
    symbol: str
    r_squared: float
    observations: int


def _by_days(series: Sequence[PricePoint], max_gap_days: float) -> dict[tuple[date, date], Step]:
    """Each usable step, keyed by the UTC days it runs between."""
    return {
        (step.previous.as_of.date(), step.current.as_of.date()): step
        for step in steps(series)
        if step.within_gap(max_gap_days)
    }


def fit(
    holding: Sequence[PricePoint],
    benchmark: Sequence[PricePoint],
    thresholds: AnalysisThresholds,
) -> tuple[float, int] | None:
    """R² of the holding's daily returns on the benchmark's, and how many pairs it rests on.

    `holding` must already exclude the day being explained: a fit that includes
    the move it is about to describe would be pulled toward explaining it.
    """
    span = window(normalise(holding), days=thresholds.market_fit_window_days)
    own = _by_days(span, thresholds.max_gap_days)
    other = _by_days(normalise(benchmark), thresholds.max_gap_days)
    pairs = [
        (other[days].return_ratio, step.return_ratio) for days, step in own.items() if days in other
    ]
    if len(pairs) < thresholds.market_fit_min_observations:
        return None
    xs, ys = zip(*pairs, strict=True)
    try:
        correlation = statistics.correlation(xs, ys)
    except statistics.StatisticsError:
        # A flat series has no variance to correlate - no information, not a zero.
        return None
    if not math.isfinite(correlation):
        return None
    return correlation * correlation, len(pairs)


def with_market_context(
    finding: Finding,
    instrument_id: str,
    points: Sequence[PricePoint],
    benchmarks: Sequence[Benchmark],
    thresholds: AnalysisThresholds,
    *,
    continuous: bool,
) -> Finding:
    """`finding`, with a `market` block in its evidence when the market moved with it."""
    if finding.kind not in FRAMED_KINDS or not benchmarks:
        return finding
    series = normalise(points)
    usable = steps(series)
    if not usable or usable[-1].current is not series[-1]:
        return finding
    today = usable[-1]
    days = (today.previous.as_of.date(), today.current.as_of.date())
    prior = series[:-1]

    best: tuple[Fit, Step] | None = None
    for benchmark in benchmarks:
        if benchmark.continuous != continuous or benchmark.instrument_id == instrument_id:
            continue
        same_day = _by_days(normalise(benchmark.points), thresholds.max_gap_days).get(days)
        if same_day is None:
            continue
        measured = fit(prior, [p for p in benchmark.points if p.as_of.date() < days[1]], thresholds)
        if measured is None:
            continue
        candidate = Fit(benchmark.symbol, measured[0], measured[1])
        # The first listed wins a tie, so the choice does not depend on dict order.
        if best is None or candidate.r_squared > best[0].r_squared:
            best = (candidate, same_day)

    if best is None:
        return finding
    chosen, move = best
    if abs(move.return_ratio) < thresholds.market_frame_min_move:
        return finding
    if (move.return_ratio > 0) != (today.return_ratio > 0):
        return finding

    market = {
        "symbol": chosen.symbol,
        "change_pct": move.return_ratio,
        "as_of": move.current.as_of.isoformat(),
        "previous_as_of": move.previous.as_of.isoformat(),
        "r_squared": chosen.r_squared,
        "fit_observations": chosen.observations,
        "fit_window_days": thresholds.market_fit_window_days,
        "min_move_pct": thresholds.market_frame_min_move,
    }
    return replace(finding, evidence={**finding.evidence, "market": market})
