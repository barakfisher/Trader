from decimal import Decimal

import pytest

from app.core.money import from_minor, minor_unit_exponent, to_minor


@pytest.mark.parametrize(
    ("amount", "currency", "expected"),
    [
        ("232.14", "USD", 23214),
        ("0.005", "USD", 1),  # half up, not banker's rounding
        ("0.004", "USD", 0),
        ("1000", "JPY", 1000),  # zero-decimal currency
        ("41250.00", "USD", 4125000),
        (Decimal("58412.335"), "USD", 5841234),  # 5841233.5 -> half up
    ],
)
def test_to_minor(amount, currency, expected):
    assert to_minor(amount, currency) == expected


def test_round_trip_is_lossless_at_minor_precision():
    assert from_minor(to_minor("123.45", "USD"), "USD") == Decimal("123.45")


def test_zero_decimal_currencies_are_known():
    assert minor_unit_exponent("JPY") == 0
    assert minor_unit_exponent("usd") == 2
