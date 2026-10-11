"""The fee formula (decisions D6, D76). Cases are shared with packages/shared/test/fees.test.ts."""

from decimal import Decimal

import pytest

from app.core.fees import FEE_PER_SHARE_MINOR, MIN_FEE_MINOR, fee_minor, notional_minor

#: The share count at which the per-share fee reaches the minimum.
CROSSOVER = MIN_FEE_MINOR // FEE_PER_SHARE_MINOR


def test_a_small_trade_pays_the_minimum():
    assert fee_minor(Decimal("1")) == MIN_FEE_MINOR


def test_the_minimum_and_the_per_share_fee_meet_where_expected():
    assert fee_minor(Decimal(CROSSOVER)) == MIN_FEE_MINOR
    assert fee_minor(Decimal(CROSSOVER + 1)) == MIN_FEE_MINOR + FEE_PER_SHARE_MINOR


def test_the_fee_is_per_share_above_the_minimum():
    shares = 4 * CROSSOVER
    assert fee_minor(Decimal(shares)) == shares * FEE_PER_SHARE_MINOR
    assert fee_minor(Decimal(f"{shares}.000")) == shares * FEE_PER_SHARE_MINOR


def test_notional_is_whole_shares_times_price():
    assert notional_minor(Decimal("3"), 12_345) == 37_035
    assert notional_minor(Decimal("3.000"), 12_345) == 37_035


@pytest.mark.parametrize("quantity", [Decimal("0"), Decimal("-1"), Decimal("1.5")])
def test_notional_refuses_what_is_not_a_whole_positive_quantity(quantity):
    with pytest.raises(ValueError):
        notional_minor(quantity, 100)


@pytest.mark.parametrize("quantity", [Decimal("0"), Decimal("-1"), Decimal("1.5")])
def test_fee_refuses_what_is_not_a_whole_positive_quantity(quantity):
    with pytest.raises(ValueError):
        fee_minor(quantity)
