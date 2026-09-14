"""Money helpers.

Money is stored and transported as integer minor units (cents for USD) plus an
explicit currency code. Floats are never used to represent money: all arithmetic
goes through Decimal and rounds exactly once, at the boundary.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal

# Currencies whose minor unit is not 1/100. Extend as needed.
_EXPONENTS = {"JPY": 0, "KRW": 0, "CLP": 0, "ISK": 0}


def minor_unit_exponent(currency: str) -> int:
    return _EXPONENTS.get(currency.upper(), 2)


def to_minor(amount: Decimal | str | int, currency: str) -> int:
    """Convert a decimal amount to integer minor units, rounding half up."""
    scale = Decimal(10) ** minor_unit_exponent(currency)
    quantum = Decimal(1).scaleb(-minor_unit_exponent(currency))
    value = Decimal(str(amount)).quantize(quantum, rounding=ROUND_HALF_UP)
    return int((value * scale).to_integral_value(rounding=ROUND_HALF_UP))


def from_minor(minor: int, currency: str) -> Decimal:
    """Convert integer minor units back to a Decimal amount."""
    scale = Decimal(10) ** minor_unit_exponent(currency)
    return (Decimal(minor) / scale).normalize()
