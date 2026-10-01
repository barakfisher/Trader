/**
 * Money helpers.
 *
 * Money crosses the wire as integer minor units plus a currency code (see
 * DESIGN.md section 2). Nothing in the UI or orchestrator should ever hold a
 * monetary value as a fractional number, so conversion to a human-readable
 * string happens here and only here.
 */

const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'CLP', 'ISK']);

export function minorUnitExponent(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
}

/** Integer minor units -> number, for display and charting only. */
export function minorToNumber(minor: number, currency: string): number {
  return minor / 10 ** minorUnitExponent(currency);
}

/**
 * Integer minor units -> the plain decimal a person would type: `12345` USD is
 * `"123.45"`, `1500` JPY is `"1500"`. Exact (integer arithmetic on the digits),
 * so `parseToMinor` reads it back to the same integer - which is what lets an
 * edit field start from the stored value without moving it.
 */
export function minorToDecimalString(minor: number, currency: string): string {
  const exponent = minorUnitExponent(currency);
  const digits = String(Math.abs(Math.trunc(minor))).padStart(exponent + 1, '0');
  const sign = minor < 0 ? '-' : '';
  if (exponent === 0) return `${sign}${digits}`;
  return `${sign}${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}

/** Parse a user-entered decimal amount into integer minor units (half up). */
export function parseToMinor(input: string | number, currency: string): number | null {
  const text = String(input).trim().replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const exponent = minorUnitExponent(currency);
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace('-', '').split('.');
  const padded = (fraction + '0'.repeat(exponent + 1)).slice(0, exponent + 1);
  const base = Number(whole) * 10 ** exponent + Number(padded.slice(0, exponent) || '0');
  const rounded = Number(padded.slice(exponent, exponent + 1)) >= 5 ? base + 1 : base;
  return negative ? -rounded : rounded;
}

export function formatMoney(
  minor: number | null | undefined,
  currency: string,
  options: { locale?: string; compact?: boolean } = {},
): string {
  if (minor === null || minor === undefined) return '—';
  const exponent = minorUnitExponent(currency);
  return new Intl.NumberFormat(options.locale ?? 'en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: options.compact ? 0 : exponent,
    maximumFractionDigits: options.compact ? 0 : exponent,
    notation: options.compact ? 'compact' : 'standard',
  }).format(minorToNumber(minor, currency));
}

export function formatPercent(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

/** Multiply integer minor units by a decimal quantity, rounding once at the end. */
export function scaleMinor(minor: number, quantity: string | number): number {
  const parsed = typeof quantity === 'number' ? quantity : Number(quantity);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(minor * parsed);
}

/** Convert an amount between currencies using a decimal rate string. */
export function convertMinor(
  minor: number,
  fromCurrency: string,
  toCurrency: string,
  rate: string | number,
): number {
  if (fromCurrency.toUpperCase() === toCurrency.toUpperCase()) return minor;
  const parsed = typeof rate === 'number' ? rate : Number(rate);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  const fromExp = minorUnitExponent(fromCurrency);
  const toExp = minorUnitExponent(toCurrency);
  return Math.round(minor * parsed * 10 ** (toExp - fromExp));
}
