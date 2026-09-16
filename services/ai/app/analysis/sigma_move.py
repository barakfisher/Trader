"""Rule 2: today's return as a z-score against the instrument's own volatility.

This is the rule that earns the product its keep. A 3% day in a regulated utility
is an event; a 3% day in a junior miner is Tuesday. A threshold in percent cannot
tell those apart, so this rule divides the move by the standard deviation of the
instrument's recent daily returns and reports how many sigmas it is.

Five deliberate guards, each of which exists because the naive version produces
a confident wrong answer:

1. **Today's return is excluded from the sample.** A 6σ move included in its own
   denominator inflates that denominator and reports itself as 2σ - the statistic
   would suppress precisely the events it exists to find. The sample is the
   *prior* returns in the window.
2. **A flat sample emits nothing.** A zero standard deviation is not a small
   number to divide by, it is an absence of information: the series says the
   instrument has never moved, so it cannot say how unusual a move is. This also
   removes the division by zero, but the reason is the first sentence, not the
   second.
3. **A minimum absolute move.** A z-score says how unusual a move is, not how
   much it matters. Without a floor in percent, a near-flat instrument produces
   "4σ" findings from a 0.3% wiggle: true arithmetic, worthless observation.
4. **A minimum sample size.** Below `sigma_min_observations` returns the
   deviation is an anecdote. A newly added holding therefore produces no σ
   findings for its first couple of weeks, which is correct and not a bug.
5. **A floor under the denominator, and a severity cap when it binds.** A series
   that moves 0.05% a day turns a 1% move into 20σ. That is arithmetic, not
   information, so the denominator is floored; and because the floor means the
   z-score is no longer measuring what it claims to, the severity is capped at
   "notable". The finding still goes out - the move happened - it just does not
   get to shout.

**What one bad price can do here, and what we decided.** Guard 1 means a single
glitched print is not diluted by itself, so a garbage price *can* produce a very
large z-score and, if it also clears the minimum move of guard 3, a "high"
severity finding. We accept that. The alternatives are worse: a median filter or
a winsorised sample would also flatten real gap-downs, which is the exact failure
this project cannot have - a tool that stays quiet during a crash because the
crash looked like an outlier. A rare false "high" costs one notification and is
visible immediately, because the evidence carries both prices and both
observation times, and because the glitch's correction the next day produces an
equal and opposite finding. When volume data arrives (FR-6 lists a volume
anomaly rule) corroboration becomes possible and this decision should be revisited
with a second source rather than with a smoother.

Returns, deviations and z-scores are floats throughout: all three are ratios, and
none of them is money.
"""

from __future__ import annotations

from collections.abc import Iterable

from app.analysis.findings import Finding, Severity, cap_severity, severity_for
from app.analysis.price_series import PricePoint, normalise, sample_stdev, steps, window
from app.analysis.thresholds import AnalysisThresholds

#: Severity ceiling applied when the standard-deviation floor had to be used. See
#: guard 5 above: the z-score is then a bound, not a measurement.
FLOORED_SEVERITY_CEILING: Severity = "notable"


def sigma_move_findings(
    symbol: str,
    points: Iterable[PricePoint],
    thresholds: AnalysisThresholds,
) -> list[Finding]:
    """Zero or one finding for the latest move in `points`, expressed in sigmas.

    Pure: `points` is the whole world this function sees.
    """
    series = normalise(points)
    all_steps = steps(series)
    if not all_steps:
        return []

    latest = all_steps[-1]
    # Same two refusals as the price-move rule: a step that is not the most
    # recent pair, or one spanning a gap too wide to be a daily move, would be a
    # misdated statement about today.
    if latest.current is not series[-1] or not latest.within_gap(thresholds.max_gap_days):
        return []
    if abs(latest.return_ratio) < thresholds.sigma_min_move:
        return []

    sample = [
        step.return_ratio
        for step in steps(window(series, days=thresholds.sigma_window_days))
        if step.within_gap(thresholds.max_gap_days) and step.current.as_of != latest.current.as_of
    ]
    if len(sample) < thresholds.sigma_min_observations:
        return []

    stdev = sample_stdev(sample)
    if stdev is None or stdev == 0.0:
        return []

    stdev_used = max(stdev, thresholds.sigma_stdev_floor)
    floor_applied = stdev_used > stdev
    z_score = latest.return_ratio / stdev_used

    severity = severity_for(z_score, thresholds.sigma_move)
    if severity is None:
        return []
    if floor_applied:
        severity = cap_severity(severity, FLOORED_SEVERITY_CEILING)

    return [
        Finding(
            kind="sigma_move",
            severity=severity,
            subject_ref=f"instrument:{symbol}",
            as_of=latest.current.as_of,
            evidence={
                "symbol": symbol,
                "currency": latest.current.currency,
                "price_minor": latest.current.price_minor,
                "as_of": latest.current.as_of.isoformat(),
                "previous_price_minor": latest.previous.price_minor,
                "previous_as_of": latest.previous.as_of.isoformat(),
                "change_pct": latest.return_ratio,
                "z_score": z_score,
                "return_stdev": stdev,
                "return_stdev_used": stdev_used,
                "return_stdev_floor": thresholds.sigma_stdev_floor,
                "return_stdev_floor_applied": floor_applied,
                "sample_size": len(sample),
                "window_days": thresholds.sigma_window_days,
                "min_move_pct": thresholds.sigma_min_move,
                "thresholds_sigma": thresholds.sigma_move.as_evidence(),
            },
        )
    ]
