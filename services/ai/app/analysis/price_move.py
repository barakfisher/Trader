"""Rule 1: a one-day price move beyond a configured threshold.

The simplest rule in the package, and the one most often wrong for boring
reasons. It compares the last two observations and refuses to speak in three
cases: too little history, a gap too wide to call the difference a daily move,
and a change of denomination between the two prices.

The move is reported in the instrument's own currency. Nothing here is converted
to the portfolio's base currency - a 2.4% move in a EUR-listed share is a fact
about that share, and multiplying it by an FX rate would produce a number that is
neither the share's move nor the portfolio's.
"""

from __future__ import annotations

from collections.abc import Iterable

from app.analysis.findings import Finding, severity_for
from app.analysis.price_series import PricePoint, normalise, steps
from app.analysis.thresholds import AnalysisThresholds


def price_move_findings(
    symbol: str,
    points: Iterable[PricePoint],
    thresholds: AnalysisThresholds,
) -> list[Finding]:
    """Zero or one finding for the latest one-day move in `points`.

    Pure: `points` is the whole world this function sees.
    """
    series = normalise(points)
    usable = steps(series)
    if not usable:
        return []

    step = usable[-1]
    # `steps` skips pairs that change currency, so the last *step* is not
    # necessarily the last *pair*. Reporting an older step as today's move would
    # be a misdated finding, which is worse than no finding.
    if step.current is not series[-1]:
        return []
    if not step.within_gap(thresholds.max_gap_days):
        return []

    severity = severity_for(step.return_ratio, thresholds.price_move)
    if severity is None:
        return []

    # A single bad print from a provider will trip this rule, and we let it: we
    # cannot tell a glitch from a real gap-down from one series, and suppressing
    # a genuine 12% fall to avoid an occasional false alarm is the wrong trade for
    # a tool whose job is to notice. What we do instead is put both prices and
    # both observation times in the evidence, so the print itself is visible to
    # the reader rather than hidden behind a percentage. The sigma rule, which is
    # far more sensitive to one outlier, guards itself further - see sigma_move.py.
    change_minor = step.current.price_minor - step.previous.price_minor
    return [
        Finding(
            kind="price_move",
            severity=severity,
            subject_ref=f"instrument:{symbol}",
            as_of=step.current.as_of,
            evidence={
                "symbol": symbol,
                "currency": step.current.currency,
                "price_minor": step.current.price_minor,
                "as_of": step.current.as_of.isoformat(),
                "previous_price_minor": step.previous.price_minor,
                "previous_as_of": step.previous.as_of.isoformat(),
                "change_minor": change_minor,
                "change_pct": step.return_ratio,
                "gap_days": step.gap_days,
                "thresholds_pct": thresholds.price_move.as_evidence(),
            },
        )
    ]
