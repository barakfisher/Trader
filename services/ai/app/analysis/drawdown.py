"""Rule 3: the decline from a trailing high inside a window.

Drawdown answers a different question from the daily-move rules: not "what
happened today" but "where is this holding relative to its recent best". A
position can drift down 18% over six weeks without ever having a 3% day, and
nothing else in the rule layer would say a word about it.

The window is a *local* high (FR-6: "drawdown from local high"), not an all-time
high, so the finding stays about the current episode rather than about a peak two
years ago that no longer describes anything.

Three refusals:

  * fewer than `drawdown_min_observations` points inside the window - with three
    prices the "high" is usually just whichever one we happen to hold first, and
    a drawdown measured from it is an artefact of our own coverage;
  * a window whose prices are not all in one currency, because the maximum of a
    EUR price and a USD price is not a price;
  * a high that *is* the latest point, which is a zero drawdown and no news.

The size of the drawdown is a ratio, so it is a float; the prices in the evidence
stay integer minor units in the instrument's own currency.

A single spuriously high print inside the window raises the apparent high and so
inflates the drawdown - the mirror image of the daily-move glitch. The same
decision applies (see sigma_move.py): no smoothing, because a real peak followed
by a real slide is the thing we exist to report, and the evidence names the high
price and the date it was observed so a wrong one is recognisable rather than
buried in a percentage.
"""

from __future__ import annotations

from collections.abc import Iterable

from app.analysis.findings import Finding, severity_for
from app.analysis.price_series import PricePoint, normalise, trailing_high, window
from app.analysis.thresholds import AnalysisThresholds


def drawdown_findings(
    symbol: str,
    points: Iterable[PricePoint],
    thresholds: AnalysisThresholds,
) -> list[Finding]:
    """Zero or one finding for the decline from the trailing high in `points`.

    Pure: `points` is the whole world this function sees.
    """
    series = window(normalise(points), days=thresholds.drawdown_window_days)
    if len(series) < thresholds.drawdown_min_observations:
        return []

    latest = series[-1]
    if any(point.currency != latest.currency for point in series):
        return []

    high = trailing_high(series)
    if high is None or high.as_of >= latest.as_of:
        return []

    # Negative by construction: `high` is the maximum and is not the last point.
    decline = (latest.price_minor - high.price_minor) / high.price_minor
    severity = severity_for(decline, thresholds.drawdown)
    if severity is None:
        return []

    return [
        Finding(
            kind="drawdown",
            severity=severity,
            subject_ref=f"instrument:{symbol}",
            as_of=latest.as_of,
            evidence={
                "symbol": symbol,
                "currency": latest.currency,
                "price_minor": latest.price_minor,
                "as_of": latest.as_of.isoformat(),
                "high_price_minor": high.price_minor,
                "high_as_of": high.as_of.isoformat(),
                "drawdown_pct": decline,
                "window_days": thresholds.drawdown_window_days,
                "observations_used": len(series),
                "thresholds_pct": thresholds.drawdown.as_evidence(),
            },
        )
    ]
