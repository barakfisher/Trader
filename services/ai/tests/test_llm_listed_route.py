"""The list a user chooses from, as the route words it (D282)."""

from __future__ import annotations

from decimal import Decimal

from app.routers.llm import decimal_text


def test_a_price_is_a_plain_decimal_never_an_exponent():
    assert decimal_text(Decimal("0.00001") * Decimal(1_000_000)) == "10"
    assert decimal_text(Decimal("0.0000003") * Decimal(1_000_000)) == "0.3"
    assert decimal_text(Decimal("0.00000003") * Decimal(1_000_000)) == "0.03"
