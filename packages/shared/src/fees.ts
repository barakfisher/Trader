/**
 * What a simulated trade costs (decision D6).
 *
 * `fee = max(MIN_FEE_MINOR, ceil(notional × FEE_BPS / 10 000))`, on buys and
 * sells alike, in integer minor units as `bigint` - never a float (guideline 3).
 * Rounded up, so the cash check that uses it is conservative.
 *
 * `services/ai/app/core/fees.py` is the same formula in Python; the two test
 * files pin both to the same cases. Shared here because the orchestrator
 * charges it and the trade form previews it, and a preview that disagreed with
 * the charge would be a figure invented by the interface.
 */

/** 0.1% of the notional. */
export const FEE_BPS = 10n;
/** $1.50, the least any trade costs. */
export const MIN_FEE_MINOR = 150n;
export const BPS_DENOMINATOR = 10_000n;

const WHOLE_QUANTITY = /^\d+(\.0+)?$/;

/** `quantity × price` for whole shares (D9). `quantity` is the wire's decimal string. */
export function notionalMinor(quantity: string, priceMinor: bigint): bigint {
  if (!WHOLE_QUANTITY.test(quantity)) {
    throw new RangeError(`a fill is a whole number of shares, not ${quantity}`);
  }
  const shares = BigInt(quantity.split('.')[0]!);
  if (shares <= 0n) throw new RangeError(`a fill is a positive number of shares, not ${quantity}`);
  if (priceMinor <= 0n) throw new RangeError(`a price must be positive, not ${priceMinor}`);
  return shares * priceMinor;
}

/** The fee on a trade of `notional` minor units, rounded up to the minor unit. */
export function feeMinor(notional: bigint): bigint {
  if (notional <= 0n) throw new RangeError(`a notional must be positive, not ${notional}`);
  const proportional = (notional * FEE_BPS + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
  return proportional > MIN_FEE_MINOR ? proportional : MIN_FEE_MINOR;
}
