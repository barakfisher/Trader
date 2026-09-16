"""Deterministic narration, built from evidence alone.

Every observation needs a headline: the column is NOT NULL, and a finding with
no sentence attached is not something a person can act on. An LLM cannot be a
prerequisite for that. It may be absent by configuration, refused by the daily
budget, unreachable, or - the case this module exists to make safe - it may
return something the evidence validator rejects.

So the templates are the floor, not the fallback of last resort. They say less
than a good narration, and everything they say is arithmetic on the evidence.
The product degrades to plainer language, never to silence and never to a
figure nobody can trace.

`concept_refs` name the ideas a reader may not know. They are attached here
rather than by the model for the same reason as everything else in this package:
a link to an explanation of "drawdown" is a claim about what the finding
involves, and that is knowable from the finding's kind.
"""

from __future__ import annotations

from decimal import Decimal

from app.analysis.findings import Finding

#: Concepts each rule invokes, for the educational layer that lands in M3.
CONCEPTS: dict[str, tuple[str, ...]] = {
    "price_move": ("daily-return",),
    "sigma_move": ("standard-deviation", "z-score", "volatility"),
    "drawdown": ("drawdown", "peak-to-trough"),
    "allocation_drift": ("asset-allocation", "rebalancing", "portfolio-weight"),
}


def _symbol(finding: Finding) -> str:
    """The subject as a reader would name it: `instrument:NVDA` is "NVDA"."""
    return finding.subject_ref.rsplit(":", 1)[-1]


def _pct(value: object, places: int = 1) -> str:
    """Render a ratio as a signed percentage, rounding rather than truncating."""
    number = Decimal(str(value)) * 100
    quantum = Decimal(1).scaleb(-places)
    return f"{number.quantize(quantum):+}%"


def _money(minor: object, currency: str) -> str:
    amount = Decimal(str(minor)) / 100
    return f"{amount.quantize(Decimal('0.01'))} {currency}"


def headline_for(finding: Finding) -> str:
    """One line, derived entirely from evidence."""
    evidence = finding.evidence
    symbol = _symbol(finding)
    currency = str(evidence.get("currency", ""))

    if finding.kind == "price_move":
        price = _money(evidence["price_minor"], currency)
        return f"{symbol} moved {_pct(evidence['change_pct'])} to {price}"

    if finding.kind == "sigma_move":
        sigma = Decimal(str(evidence["z_score"])).quantize(Decimal("0.1"))
        return (
            f"{symbol} moved {_pct(evidence['change_pct'])}, "
            f"{abs(sigma)} standard deviations from its recent average"
        )

    if finding.kind == "drawdown":
        window = evidence.get("window_days")
        span = f"{window}-day high" if window else "recent high"
        return f"{symbol} is {_pct(evidence['drawdown_pct'])} from its {span}"

    if finding.kind == "allocation_drift":
        # Percentage POINTS, not percent. A weight of 12.7% against a target of
        # 25% differs by 12.3 points, not by 12.3 percent - and in a product whose
        # argument is precision about numbers, writing "-12.3% away from 25.0%"
        # invites exactly the misreading it cannot afford.
        drift = Decimal(str(evidence["drift"])) * 100
        direction = "below" if drift < 0 else "above"
        points = abs(drift).quantize(Decimal("0.1"))
        target = _pct(evidence["target_weight"], 1).lstrip("+")
        return f"{symbol} is {points} percentage points {direction} its {target} target"

    # A new rule without a template should be obvious, not silently blank.
    return f"{symbol}: {finding.kind.replace('_', ' ')}"


def explanation_for(finding: Finding) -> str:
    """Two or three sentences of plain arithmetic, with no interpretation.

    Deliberately says what happened and not what it means. Meaning is what the
    LLM narration adds when it is available and its figures check out; inventing
    a cause here would be the same failure by a different author.
    """
    evidence = finding.evidence
    symbol = _symbol(finding)
    currency = str(evidence.get("currency", ""))

    if finding.kind in ("price_move", "sigma_move"):
        parts = [
            f"{symbol} went from {_money(evidence['previous_price_minor'], currency)} "
            f"to {_money(evidence['price_minor'], currency)}, a change of "
            f"{_pct(evidence['change_pct'])}."
        ]
        if finding.kind == "sigma_move":
            sigma = Decimal(str(evidence["z_score"])).quantize(Decimal("0.1"))
            parts.append(
                f"Measured against the {evidence['sample_size']} most recent daily moves, "
                f"that is {abs(sigma)} standard deviations from average."
            )
            if evidence.get("return_stdev_floor_applied"):
                parts.append(
                    "The instrument has been unusually quiet, so a floor was applied to the "
                    "volatility estimate and this figure is a bound rather than a measurement."
                )
        return " ".join(parts)

    if finding.kind == "drawdown":
        return (
            f"{symbol} last traded at {_money(evidence['price_minor'], currency)}, "
            f"{_pct(evidence['drawdown_pct'])} below its recent high of "
            f"{_money(evidence['high_price_minor'], currency)}."
        )

    if finding.kind == "allocation_drift":
        # Weights arrive as decimal strings, because a portfolio weight is money
        # arithmetic and must not round through a float on its way here.
        return (
            f"{symbol} is {_pct(evidence['actual_weight'], 1).lstrip('+')} of the portfolio "
            f"against a target of {_pct(evidence['target_weight'], 1).lstrip('+')}."
        )

    return headline_for(finding)


def concepts_for(finding: Finding) -> tuple[str, ...]:
    return CONCEPTS.get(finding.kind, ())
