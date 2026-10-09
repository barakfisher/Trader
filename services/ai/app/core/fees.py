"""What a simulated trade costs (decisions D6, D76).

IBI's published rate for US shares and ETFs, on buys and sells alike:
`fee_minor = max(MIN_FEE_MINOR, shares × FEE_PER_SHARE_MINOR)` - one cent a
share, at least $7.50 a trade, the foreign broker's fee included. The fee
depends on the share count, not on the price. Other third parties' costs (the
SEC and FINRA fees on a sale) are not in the published rate and are not charged:
a figure the source does not state would be invented (guideline 7).

Source: IBI SMART terms of use, clause 2.2.3, read 2026-10-09,
https://www.ibi.co.il/en/about/terms-and-conditions-of-use-ibi-smart/
The same clause prices Israeli shares at 0.08% of the value, at least ₪2.35;
that rule is not charged because agents trade USD-listed instruments only (D7).
IBI may change the rate; an increase takes effect 7 days after notice (2.4.1).

`packages/shared/src/fees.ts` is the same formula in TypeScript, the one the
orchestrator charges and the trade form previews; `test_fees.py` and
`fees.test.ts` pin both to the same cases.
"""

from __future__ import annotations

from decimal import Decimal

#: One cent a share.
FEE_PER_SHARE_MINOR = 1
#: $7.50, the least any trade costs.
MIN_FEE_MINOR = 750


def _whole_shares(quantity: Decimal) -> int:
    if quantity <= 0 or quantity != quantity.to_integral_value():
        raise ValueError(f"a fill is a positive whole number of shares, not {quantity}")
    return int(quantity)


def notional_minor(quantity: Decimal, price_minor: int) -> int:
    """`quantity × price` for whole shares (D9); a fractional quantity is refused."""
    shares = _whole_shares(quantity)
    if price_minor <= 0:
        raise ValueError(f"a price must be positive, not {price_minor}")
    return shares * price_minor


def fee_minor(quantity: Decimal) -> int:
    """The fee on a trade of `quantity` whole shares, in minor units."""
    return max(MIN_FEE_MINOR, _whole_shares(quantity) * FEE_PER_SHARE_MINOR)
