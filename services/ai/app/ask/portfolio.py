"""Answering a question about the reader's own holdings, from arithmetic only.

Every sentence this module produces is built from figures the caller supplied and
figures computed here, and each one is returned alongside the evidence it rests
on so `narration.evidence_validator` can check it. Nothing is generated. A model
is never asked what a portfolio contains, because a plausible wrong number about
someone's money is the worst output this product could produce (guideline 7).

**The set of answerable questions is deliberately short and explicitly listed.**
It is the same argument `PROPOSABLE_KINDS` makes in the orchestrator: one map,
short enough to read, and the place to argue before adding to it. A general
natural-language query engine over a portfolio is a different product, and an
approximate one would answer questions about money confidently and sometimes
wrongly. What is not on the list is **refused by name**, so the reader learns the
boundary rather than receiving something adjacent to what they asked.

**Unpriced holdings are carried, never dropped.** A position the orchestrator
could not value arrives with `value_minor = None`, and every answer below counts
how many there were and says so. Summing what happens to be priced and calling it
a portfolio total is the exact failure guideline 14 exists to prevent: the number
looks like a fact, and it is a fact about a subset nobody chose. A total computed
over an incomplete portfolio is reported as incomplete or not at all.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal

from app.core.money import from_minor

#: How many decimal places a weight is reported to. Two, because weights are
#: shown as percentages with one decimal and the extra digit keeps the rounding
#: honest rather than compounding it.
_WEIGHT_PLACES = Decimal("0.0001")


@dataclass(frozen=True, slots=True)
class Position:
    """One holding, as `/ask` needs it. Mirrors `ScanHolding` deliberately.

    The same shape the scan already receives, so the orchestrator sends what it
    already builds rather than assembling a second portfolio representation that
    can disagree with the first.
    """

    symbol: str
    value_minor: int | None = None
    currency: str = "USD"


@dataclass(frozen=True, slots=True)
class PortfolioAnswer:
    """A sentence, the figures under it, and what it could not see."""

    text: str
    evidence: dict[str, object] = field(default_factory=dict)
    #: Concept slugs this answer touches, so the UI can offer the same chips the
    #: observation feed does. Retrieval is not involved; these are named by the
    #: handler that produced the sentence.
    concept_refs: tuple[str, ...] = ()


def _money(minor: int, currency: str) -> str:
    """Format minor units for display, honouring the currency's exponent.

    Uses `core.money.from_minor` rather than dividing by 100: JPY has no minor
    unit, so a hundredth-of-a-yen figure would be wrong by two orders of
    magnitude. (`narration/templates.py` still divides by 100 directly and has
    the same latent bug for those currencies; it is not this change's to fix.)
    """
    return f"{from_minor(minor, currency).quantize(Decimal('0.01'))} {currency}"


def _priced(positions: list[Position]) -> list[Position]:
    return [p for p in positions if p.value_minor is not None]


def _total_minor(positions: list[Position]) -> int:
    return sum(p.value_minor or 0 for p in positions)


def _unpriced_count(positions: list[Position]) -> int:
    return len(positions) - len(_priced(positions))


def _unpriced_note(positions: list[Position]) -> str:
    """The sentence fragment that stops a partial total reading as a whole one.

    The count it states is a *derived* figure - holdings minus priced - so every
    answer that uses this note must also carry `unpriced_count` in its evidence.
    The evidence validator catches the omission, which is how this was found:
    "1 unpriced holding" is a number about someone's portfolio, and a number the
    reader cannot trace is exactly what the validator exists to reject, whether
    a model wrote it or a template did.
    """
    missing = _unpriced_count(positions)
    if missing == 0:
        return ""
    holding = "holding" if missing == 1 else "holdings"
    return f" This excludes {missing} unpriced {holding}, so it is not the whole portfolio."


def _weights(positions: list[Position]) -> dict[str, Decimal]:
    """Weight per symbol over the *priced* subset, which is the only honest base.

    Dividing by a total that silently omits unpriced holdings would overstate
    every weight. The caller states the omission; this function assumes it has
    been stated.
    """
    priced = _priced(positions)
    total = _total_minor(priced)
    if total <= 0:
        return {}
    return {
        p.symbol: (Decimal(p.value_minor or 0) / Decimal(total)).quantize(_WEIGHT_PLACES)
        for p in priced
    }


def total_value(positions: list[Position], currency: str) -> PortfolioAnswer | None:
    priced = _priced(positions)
    if not priced:
        return None

    total = _total_minor(priced)
    return PortfolioAnswer(
        text=(
            f"Your {len(priced)} priced holdings are worth {_money(total, currency)} "
            f"in total." + _unpriced_note(positions)
        ),
        evidence={
            "total_value_minor": total,
            "currency": currency,
            "priced_count": len(priced),
            "holdings_count": len(positions),
            "unpriced_count": _unpriced_count(positions),
        },
        concept_refs=("portfolio-weight",),
    )


def extreme_position(
    positions: list[Position], currency: str, *, largest: bool
) -> PortfolioAnswer | None:
    weights = _weights(positions)
    if not weights:
        return None

    symbol = (max if largest else min)(weights, key=lambda s: weights[s])
    position = next(p for p in _priced(positions) if p.symbol == symbol)
    weight = weights[symbol]
    word = "largest" if largest else "smallest"

    return PortfolioAnswer(
        text=(
            f"{symbol} is your {word} priced holding at "
            f"{_money(position.value_minor or 0, currency)}, which is "
            f"{weight * 100:.1f}% of the priced total." + _unpriced_note(positions)
        ),
        evidence={
            "symbol": symbol,
            "value_minor": position.value_minor,
            "currency": currency,
            "weight": str(weight),
            "priced_count": len(_weights(positions)),
            "holdings_count": len(positions),
            "unpriced_count": _unpriced_count(positions),
        },
        concept_refs=("portfolio-weight", "asset-allocation"),
    )


def position_weight(
    positions: list[Position], currency: str, *, symbol: str
) -> PortfolioAnswer | None:
    """What one named holding is worth and what share of the portfolio it is."""
    match = next((p for p in positions if p.symbol.lower() == symbol.lower()), None)
    if match is None:
        return None

    if match.value_minor is None:
        # A held-but-unpriced position is a real answer and a different one:
        # "you hold it, we could not value it" is information, and a zero or a
        # silence would both be lies about it.
        return PortfolioAnswer(
            text=(
                f"You hold {match.symbol}, but it could not be priced, so its value "
                f"and its share of your portfolio are unknown."
            ),
            evidence={"symbol": match.symbol, "value_minor": None},
            concept_refs=("portfolio-weight",),
        )

    weight = _weights(positions).get(match.symbol, Decimal(0))
    return PortfolioAnswer(
        text=(
            f"{match.symbol} is worth {_money(match.value_minor, currency)}, which is "
            f"{weight * 100:.1f}% of your priced total." + _unpriced_note(positions)
        ),
        evidence={
            "symbol": match.symbol,
            "value_minor": match.value_minor,
            "currency": currency,
            "weight": str(weight),
            "unpriced_count": _unpriced_count(positions),
        },
        concept_refs=("portfolio-weight",),
    )


def drift_against_targets(
    positions: list[Position], currency: str, *, targets: dict[str, str]
) -> PortfolioAnswer | None:
    """How far each target-bearing holding sits from the weight it was meant to."""
    weights = _weights(positions)
    if not weights or not targets:
        return None

    drifts: list[tuple[str, Decimal, Decimal, Decimal]] = []
    for symbol, target_text in targets.items():
        actual = weights.get(symbol)
        if actual is None:
            continue
        target = Decimal(target_text)
        drifts.append((symbol, actual, target, actual - target))
    if not drifts:
        return None

    symbol, actual, target, drift = max(drifts, key=lambda row: abs(row[3]))
    direction = "above" if drift > 0 else "below"

    return PortfolioAnswer(
        text=(
            f"{symbol} is furthest from its target: {actual * 100:.1f}% against a target of "
            f"{target * 100:.1f}%, which is {abs(drift) * 100:.1f} percentage points "
            f"{direction} it." + _unpriced_note(positions)
        ),
        evidence={
            "symbol": symbol,
            "weight": str(actual),
            "target_weight": str(target),
            "drift": str(drift),
            "compared_count": len(drifts),
            "unpriced_count": _unpriced_count(positions),
        },
        concept_refs=("rebalancing", "asset-allocation", "portfolio-weight"),
    )
