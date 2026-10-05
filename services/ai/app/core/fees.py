"""What a simulated trade costs (decision D6).

`fee_minor = max(MIN_FEE_MINOR, ceil(notional_minor × FEE_BPS / 10 000))`, on
buys and sells alike, in integer minor units. Rounded **up**, so the cash check
that uses it is conservative: a fee one cent too high refuses a trade that
would have fit; one cent too low lets cash go negative, which the ledger
refuses anyway.

`packages/shared/src/fees.ts` is the same formula in TypeScript, the one the
orchestrator charges and the trade form previews; `test_fees.py` and
`fees.test.ts` pin both to the same cases.
"""

from __future__ import annotations

from decimal import Decimal

#: 0.1% of the notional.
FEE_BPS = 10
#: $1.50, the least any trade costs.
MIN_FEE_MINOR = 150
BPS_DENOMINATOR = 10_000


def notional_minor(quantity: Decimal, price_minor: int) -> int:
    """`quantity × price` for whole shares (D9); a fractional quantity is refused."""
    if quantity <= 0 or quantity != quantity.to_integral_value():
        raise ValueError(f"a fill is a positive whole number of shares, not {quantity}")
    if price_minor <= 0:
        raise ValueError(f"a price must be positive, not {price_minor}")
    return int(quantity) * price_minor


def fee_minor(notional: int) -> int:
    """The fee on a trade of `notional` minor units, rounded up to the minor unit."""
    if notional <= 0:
        raise ValueError(f"a notional must be positive, not {notional}")
    proportional = -(-notional * FEE_BPS // BPS_DENOMINATOR)  # ceiling division
    return max(MIN_FEE_MINOR, proportional)
