/**
 * Exact arithmetic on quantities, which cross the wire as decimal strings
 * (guideline 4) and are stored as `numeric(38, 18)`.
 */

/** `numeric(38, 18)`: the scale every stored quantity has. */
const QUANTITY_SCALE = 18;
const QUANTITY_UNIT = 10n ** BigInt(QUANTITY_SCALE);

function scaledQuantity(text: string): bigint {
  const [whole = '0', fraction = ''] = text.trim().split('.');
  return BigInt(whole) * QUANTITY_UNIT + BigInt(fraction.padEnd(QUANTITY_SCALE, '0').slice(0, QUANTITY_SCALE));
}

/**
 * Exact sum of decimal-string quantities, in the shape Postgres returns them.
 * Never through a float: 0.1 + 0.2 shares is 0.3 shares.
 */
export function addQuantities(quantities: string[]): string {
  const total = quantities.reduce((sum, quantity) => sum + scaledQuantity(quantity), 0n);
  const whole = total / QUANTITY_UNIT;
  const fraction = (total % QUANTITY_UNIT).toString().padStart(QUANTITY_SCALE, '0');
  return `${whole}.${fraction}`;
}
