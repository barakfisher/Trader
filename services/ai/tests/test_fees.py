"""The fee formula (decision D6). Cases are shared with packages/shared/test/fees.test.ts."""

from decimal import Decimal

import pytest

from app.core.fees import BPS_DENOMINATOR, FEE_BPS, MIN_FEE_MINOR, fee_minor, notional_minor


def test_a_small_trade_pays_the_minimum():
    assert fee_minor(1) == MIN_FEE_MINOR


def test_the_proportional_fee_is_rounded_up():
    # One minor unit past an exact multiple rounds up to the next unit.
    exact = (MIN_FEE_MINOR + 10) * BPS_DENOMINATOR // FEE_BPS
    assert fee_minor(exact) == MIN_FEE_MINOR + 10
    assert fee_minor(exact + 1) == MIN_FEE_MINOR + 11


def test_the_minimum_and_the_proportional_fee_meet_where_expected():
    crossover = MIN_FEE_MINOR * BPS_DENOMINATOR // FEE_BPS
    assert fee_minor(crossover) == MIN_FEE_MINOR
    assert fee_minor(crossover + 1) == MIN_FEE_MINOR + 1


def test_notional_is_whole_shares_times_price():
    assert notional_minor(Decimal("3"), 12_345) == 37_035
    assert notional_minor(Decimal("3.000"), 12_345) == 37_035


@pytest.mark.parametrize("quantity", [Decimal("0"), Decimal("-1"), Decimal("1.5")])
def test_notional_refuses_what_is_not_a_whole_positive_quantity(quantity):
    with pytest.raises(ValueError):
        notional_minor(quantity, 100)


def test_fee_refuses_a_non_positive_notional():
    with pytest.raises(ValueError):
        fee_minor(0)
