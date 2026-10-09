/**
 * What a simulated trade costs (decisions D6, D76).
 *
 * IBI's published rate for US shares and ETFs, on buys and sells alike:
 * `fee = max(MIN_FEE_MINOR, shares × FEE_PER_SHARE_MINOR)` - one cent a share,
 * at least $7.50 a trade, the foreign broker's fee included - in integer minor
 * units as `bigint`, never a float (guideline 3). The fee depends on the share
 * count, not on the price. Other third parties' costs (the SEC and FINRA fees on
 * a sale) are not in the published rate and are not charged (guideline 7).
 *
 * Source: IBI SMART terms of use, clause 2.2.3, read 2026-10-09,
 * https://www.ibi.co.il/en/about/terms-and-conditions-of-use-ibi-smart/
 * The same clause prices Israeli shares at 0.08% of the value, at least ₪2.35;
 * that rule is not charged because agents trade USD-listed instruments only (D7).
 *
 * `services/ai/app/core/fees.py` is the same formula in Python; the two test
 * files pin both to the same cases. Shared here because the orchestrator
 * charges it and the trade form previews it, and a preview that disagreed with
 * the charge would be a figure invented by the interface.
 */

/** One cent a share. */
export const FEE_PER_SHARE_MINOR = 1n;
/** $7.50, the least any trade costs. */
export const MIN_FEE_MINOR = 750n;

const WHOLE_QUANTITY = /^\d+(\.0+)?$/;

/** The whole, positive share count in the wire's decimal string (D9). */
function wholeShares(quantity: string): bigint {
  if (!WHOLE_QUANTITY.test(quantity)) {
    throw new RangeError(`a fill is a whole number of shares, not ${quantity}`);
  }
  const shares = BigInt(quantity.split('.')[0]!);
  if (shares <= 0n) throw new RangeError(`a fill is a positive number of shares, not ${quantity}`);
  return shares;
}

/** `quantity × price` for whole shares (D9). `quantity` is the wire's decimal string. */
export function notionalMinor(quantity: string, priceMinor: bigint): bigint {
  const shares = wholeShares(quantity);
  if (priceMinor <= 0n) throw new RangeError(`a price must be positive, not ${priceMinor}`);
  return shares * priceMinor;
}

/** The fee on a trade of `quantity` whole shares, in minor units. */
export function feeMinor(quantity: string): bigint {
  const perShare = wholeShares(quantity) * FEE_PER_SHARE_MINOR;
  return perShare > MIN_FEE_MINOR ? perShare : MIN_FEE_MINOR;
}
