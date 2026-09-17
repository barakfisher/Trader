/**
 * A target weight as the user reads and types it, and how far the portfolio has
 * moved from one.
 *
 * Two units meet in this file and neither is a float.
 *
 *  - The **API** stores a weight as a decimal string in `numeric(6, 4)`:
 *    `'0.2500'` is a quarter of the portfolio, and four places is the finest
 *    distinction the column keeps.
 *  - The **user** thinks in percent, and writes `25` or `25.5`.
 *
 * Between them everything is an integer count of *ten-thousandths of a
 * portfolio* — `WEIGHT_UNITS_PER_PORTFOLIO` of them make the whole thing. That
 * unit is exactly the column's last decimal place and exactly one hundredth of
 * a percentage point, so percent-with-two-places converts both ways with
 * nothing lost, and every bound and sum is checked in integer arithmetic
 * (guideline 3). `Number('0.1') + Number('0.2')` deciding whether someone's
 * allocation is legal is precisely the bug that rule exists to prevent, and the
 * server already avoids it the same way — see `routes/targets.ts`.
 */

/** Ten-thousandths of a portfolio: the scale of `target_weights.weight`. */
export const WEIGHT_UNITS_PER_PORTFOLIO = 10_000;

/** Hundredths of a percentage point, which is the same unit read the other way. */
export const UNITS_PER_PERCENT = WEIGHT_UNITS_PER_PORTFOLIO / 100;

/** What the input accepts, and therefore what the server is ever asked to store. */
export const PERCENT_DECIMAL_PLACES = 2;

/**
 * The drift the analysis engine reports on, in the same integer units.
 *
 * Restated from `services/ai/app/analysis/thresholds.py` for the same reason
 * `severityScale.ts` restates the rest of the ladder: the thresholds are an
 * operator's to retune and no endpoint publishes them, so the page says these
 * are the defaults rather than presenting them as fixed. Percentage *points* of
 * weight, not percent of the target — a 10% position that should be 5% has
 * drifted five points, not one hundred percent.
 */
export const DRIFT_BANDS = {
  info: 5 * UNITS_PER_PERCENT,
  notable: 10 * UNITS_PER_PERCENT,
  high: 15 * UNITS_PER_PERCENT,
} as const;

/** `25`, `25.5`, `.5`, and the half-typed `25.` a user is still in the middle of. */
const PERCENT_PATTERN = new RegExp(`^(\\d{0,3})(\\.\\d{0,${PERCENT_DECIMAL_PLACES}})?$`);

/**
 * A typed percentage as integer units, or null when the text is not one.
 *
 * Empty text is null rather than zero, and the caller must keep the difference:
 * a blank box means *no target for this instrument*, while `0` means *I mean to
 * hold none of it*. The first can never produce a finding; the second produces
 * drift equal to whatever is still held. Collapsing them would silently delete
 * an intention the user stated.
 *
 * A trailing `.` parses as the whole number before it, so the error message does
 * not flash on screen between the two keystrokes of `25.5`.
 */
export function percentToUnits(text: string): number | null {
  const trimmed = text.trim().replace(/\.$/, '');
  if (trimmed === '') return null;
  const match = PERCENT_PATTERN.exec(trimmed);
  if (match === null) return null;
  const [, whole = '', fraction = ''] = match;
  if (whole === '' && fraction === '') return null;
  const hundredths = fraction.replace('.', '').padEnd(PERCENT_DECIMAL_PLACES, '0');
  return Number(whole || '0') * UNITS_PER_PERCENT + Number(hundredths || '0');
}

/**
 * Integer units as the shortest percentage that means the same thing: `2500` is
 * `'25'`, not `'25.00'`. Trailing zeros in a box the user is about to edit read
 * as precision they did not ask for.
 */
export function unitsToPercent(units: number): string {
  const whole = Math.trunc(units / UNITS_PER_PERCENT);
  const fraction = String(Math.abs(units) % UNITS_PER_PERCENT).padStart(
    PERCENT_DECIMAL_PLACES,
    '0',
  );
  const trimmed = fraction.replace(/0+$/, '');
  const sign = units < 0 && whole === 0 ? '-' : '';
  return trimmed === '' ? `${sign}${whole}` : `${sign}${whole}.${trimmed}`;
}

/** Integer units as the decimal string the API stores: `2500` -> `'0.2500'`. */
export function unitsToWeight(units: number): string {
  const whole = Math.floor(units / WEIGHT_UNITS_PER_PORTFOLIO);
  const fraction = String(units % WEIGHT_UNITS_PER_PORTFOLIO).padStart(4, '0');
  return `${whole}.${fraction}`;
}

/**
 * The API's decimal string as integer units: `'0.2500'` -> `2500`.
 *
 * Digits beyond the fourth place cannot come from the column, so a longer
 * fraction is a wire bug rather than extra precision, and truncating it here
 * would hide it. It is read as far as the column goes and no further.
 */
export function weightToUnits(weight: string): number {
  const [whole = '0', fraction = ''] = weight.trim().split('.');
  const padded = fraction.slice(0, 4).padEnd(4, '0');
  return Number(whole) * WEIGHT_UNITS_PER_PORTFOLIO + Number(padded || '0');
}

/** A drift, signed, in the percentage points the feed quotes: `+3.2pp`. */
export function formatDriftPoints(units: number): string {
  const sign = units > 0 ? '+' : units < 0 ? '−' : '';
  return `${sign}${unitsToPercent(Math.abs(units))}pp`;
}

/**
 * Which band a drift of this size would fall in, or null when it is below the
 * floor and would therefore produce no finding at all.
 *
 * Direction is discarded, as in the engine: being fifteen points under a target
 * is as far from it as being fifteen points over.
 */
export function driftSeverity(units: number): 'info' | 'notable' | 'high' | null {
  const size = Math.abs(units);
  if (size >= DRIFT_BANDS.high) return 'high';
  if (size >= DRIFT_BANDS.notable) return 'notable';
  if (size >= DRIFT_BANDS.info) return 'info';
  return null;
}

/**
 * A holding's current weight as integer units, from the percentage the
 * portfolio endpoint reports.
 *
 * This one *does* round, and it is the only place in the file that does. The
 * wire gives `weightPct` as a number with four decimal places of percent, which
 * is two more than a target can express, so the actual weight is snapped to the
 * finest distinction a target has. The result is only ever shown beside a
 * target or subtracted from one; the authoritative drift is computed by the
 * engine from exact minor units, and this is the page's preview of it.
 */
export function actualWeightUnits(weightPct: number): number {
  return Math.round(weightPct * UNITS_PER_PERCENT);
}
