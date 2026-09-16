"""Rule 4: actual portfolio weight against `target_weights`.

The other three rules are about one instrument's price. This one is about the
portfolio's shape, which makes currency the first thing to get right. A weight is
a share of the whole portfolio, so every position has to be measured in one
currency before any comparison is possible. This rule therefore takes positions
that are *already valued in the base currency* and refuses anything else: FX
conversion belongs to the valuation step, which owns the rates and the single
rounding boundary, and doing it here would mean two places in the codebase
deciding what a EUR holding is worth in USD.

Weights are `Decimal`, not float. They are not statistics: they come from exact
integer minor units, `target_weights.weight` is `numeric(6, 4)`, and a drift of
"5.00 percentage points" is a figure a user will compare against a number they
typed. Returns and z-scores elsewhere in this package are floats because they are
ratios of measurements; a weight is a division of two exact quantities, and
keeping it exact costs nothing.

**An incompletely priced portfolio produces no drift findings at all.** If any
holding is unpriced, the denominator is smaller than the portfolio, so every
weight computed from it is overstated - a 25% position looks like 31% and the rule
invents a drift that does not exist. Reporting those weights with a "degraded"
flag was the alternative, and it was rejected: this rule's whole output is
comparisons against a number the user chose, and a systematically wrong
comparison is worse than silence. The run records the unpriced holdings itself
(`portfolio_snapshots.degraded`, DESIGN.md section 3), so nothing is hidden by
this refusal.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from app.analysis.findings import Finding, severity_for
from app.analysis.thresholds import AnalysisThresholds

#: Weights and drifts are reported to six decimal places - four would be enough
#: for the stored target, and the extra two keep a small position's weight from
#: rounding to something that looks like a stored value.
_WEIGHT_QUANTUM = Decimal("0.000001")


@dataclass(frozen=True, slots=True)
class PositionValue:
    """One holding's market value, already converted to the portfolio's base currency.

    `value_minor` is None when the holding could not be priced. That is a first
    class state, not an error and certainly not a zero (project guideline 7).

    `as_of` is the observation time of the price behind the value.
    """

    symbol: str
    value_minor: int | None
    currency: str
    as_of: datetime | None = None


def allocation_drift_findings(
    positions: Iterable[PositionValue],
    target_weights: Mapping[str, Decimal | str | int],
    thresholds: AnalysisThresholds,
    *,
    base_currency: str,
) -> list[Finding]:
    """One finding per instrument whose weight has drifted beyond the threshold.

    Pure: `positions` and `target_weights` are the whole world this function sees.
    Raises `ValueError` if a priced position is not in `base_currency`, because
    that is a wiring mistake in the caller rather than a data condition - silently
    treating a EUR value as USD would misstate every weight in the portfolio.
    """
    held = list(positions)
    for position in held:
        if position.value_minor is not None and position.currency.upper() != base_currency.upper():
            raise ValueError(
                f"{position.symbol} is valued in {position.currency}, expected {base_currency}; "
                "convert to the base currency before computing weights"
            )

    # See the module docstring: a partial denominator overstates every weight.
    if any(position.value_minor is None for position in held):
        return []

    total_minor = sum(position.value_minor or 0 for position in held)
    if total_minor <= 0:
        return []

    # A weight is only as current as the stalest price behind it, so the finding
    # is dated by the oldest contributing observation rather than the newest.
    observation_times = [position.as_of for position in held if position.as_of is not None]
    as_of = min(observation_times) if observation_times else None
    if as_of is None:
        return []

    values = {position.symbol: position.value_minor or 0 for position in held}
    targets = {symbol: Decimal(str(weight)) for symbol, weight in target_weights.items()}
    target_sum = sum(targets.values(), Decimal(0))

    findings: list[Finding] = []
    # Sorted so a run's output order is a property of the data, not of dict order.
    for symbol in sorted(targets):
        target = targets[symbol]
        # A targeted instrument that is not held has an exact actual weight of
        # zero, and "you hold none of the 10% you asked for" is a real drift.
        value_minor = values.get(symbol, 0)
        actual = Decimal(value_minor) / Decimal(total_minor)
        drift = actual - target

        severity = severity_for(float(drift), thresholds.allocation_drift)
        if severity is None:
            continue

        findings.append(
            Finding(
                kind="allocation_drift",
                severity=severity,
                subject_ref=f"portfolio:allocation:{symbol}",
                as_of=as_of,
                evidence={
                    "symbol": symbol,
                    "base_currency": base_currency.upper(),
                    "value_minor": value_minor,
                    "portfolio_total_minor": total_minor,
                    "actual_weight": str(actual.quantize(_WEIGHT_QUANTUM)),
                    "target_weight": str(target.quantize(_WEIGHT_QUANTUM)),
                    "drift": str(drift.quantize(_WEIGHT_QUANTUM)),
                    # Targets need not sum to 1 - a user may set them for three of
                    # eight holdings - so the sum is reported rather than assumed,
                    # and no weight is renormalised against it.
                    "target_weight_sum": str(target_sum.quantize(_WEIGHT_QUANTUM)),
                    "held": symbol in values,
                    "positions_valued": len(held),
                    "as_of": as_of.isoformat(),
                    "thresholds_weight": thresholds.allocation_drift.as_evidence(),
                },
            )
        )
    return findings
