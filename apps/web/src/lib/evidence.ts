/**
 * Turning an observation's `evidence` mapping into something a person can read.
 *
 * The product's central promise is that every claim is checkable (PRD stance
 * P3): the sentence is only allowed to quote figures that the rule recorded, so
 * the reader must be able to see those figures. Printing the mapping as JSON
 * satisfies the letter of that and none of its purpose - `price_minor: 11845`
 * is not a price to anybody who has not read the money conventions, and a
 * `change_pct` of `-0.085` looks like a tenth of the move it is.
 *
 * So the unit suffix in each key is read and the value is rendered in it:
 *
 *   `*_minor`                        integer minor units of the currency the
 *                                    same mapping records
 *   `*_pct`, `*_ratio`               a fraction, where 1 is 100%, signed (a change)
 *   `*_weight`, `*_weight_sum`       a share of the portfolio, unsigned
 *   `drift`                          a fraction (a weight difference)
 *   `as_of`, `*_as_of`               an ISO 8601 UTC timestamp
 *
 * Every other key falls through to its raw value. That is the important half of
 * the design: a rule added next month will record keys this module has never
 * seen, and showing `4` under a plain label is honest, while guessing that some
 * unknown number is a percentage would put a figure on screen that no rule ever
 * computed - the exact failure the evidence validator exists to prevent.
 */

import { formatMoney, formatPercent } from '@traders/shared';

import { formatExactTime } from './relativeTime.ts';

export interface EvidenceEntry {
  /** The raw evidence key, kept so a figure on screen can be traced to its source. */
  key: string;
  label: string;
  value: string;
  /** False when the key carried no unit we know, so `value` is the raw figure. */
  interpreted: boolean;
}

export interface EvidenceSection {
  /** Null for the finding's own figures; set for a nested mapping such as thresholds. */
  label: string | null;
  entries: EvidenceEntry[];
}

/** What a key's suffix says its value is. */
type Unit = 'money' | 'fraction' | 'share' | 'timestamp' | 'unknown';

/**
 * Labels where the generic "underscores to words" rule reads badly enough to be
 * worth an exception. Kept short on purpose: an entry here is a phrase this
 * module has to keep in step with the rule that emits the key.
 */
const LABELS: Record<string, string> = {
  as_of: 'Observed at',
  previous_as_of: 'Previous observation',
  high_as_of: 'High observed at',
  change_pct: 'Change',
  drawdown_pct: 'Decline from high',
  drift: 'Drift from target',
  z_score: 'Z-score',
  held: 'Currently held',
  return_stdev: 'Daily return volatility',
  return_stdev_used: 'Volatility used',
  return_stdev_floor: 'Volatility floor',
  return_stdev_floor_applied: 'Volatility floor applied',
  thresholds_pct: 'Thresholds',
  thresholds_sigma: 'Thresholds, in standard deviations',
  thresholds_weight: 'Thresholds',
  // Without it the suffix rule makes this "Target", beside `target_weight`'s.
  target_weight_sum: 'All targets together',
};

const UNIT_SUFFIXES: { suffix: string; unit: Unit }[] = [
  { suffix: '_minor', unit: 'money' },
  { suffix: '_pct', unit: 'fraction' },
  { suffix: '_ratio', unit: 'fraction' },
  // A weight is a share of the portfolio, not a change: unsigned. "Actual
  // +35.16%" read as a move. `_weight_sum` is a sum of weights, so a share too.
  { suffix: '_weight', unit: 'share' },
  { suffix: '_weight_sum', unit: 'share' },
  { suffix: '_as_of', unit: 'timestamp' },
];

export function unitFor(key: string): Unit {
  if (key === 'as_of') return 'timestamp';
  if (key === 'drift') return 'fraction';
  // `/ask`'s position answers record a bare `weight`: a share of the portfolio.
  if (key === 'weight') return 'share';
  const match = UNIT_SUFFIXES.find((candidate) => key.endsWith(candidate.suffix));
  return match ? match.unit : 'unknown';
}

/**
 * Read an observation's evidence into ordered, labelled sections.
 *
 * Key order is preserved: each rule writes its evidence in the order the
 * finding is reasoned about, which is a better reading order than anything this
 * module could impose. Nested mappings become their own sections at the end, so
 * the finding's own figures are never pushed below its configuration.
 */
export function readEvidence(
  evidence: unknown,
  options: { fallbackCurrency?: string } = {},
): EvidenceSection[] {
  if (!isMapping(evidence)) return [];

  // The currency belongs to the whole mapping, not to any one key: a rule
  // records it once and every `*_minor` figure in that finding is in it.
  const currency = resolveCurrency(evidence, options.fallbackCurrency);

  const primary: EvidenceEntry[] = [];
  const nested: EvidenceSection[] = [];

  for (const [key, value] of Object.entries(evidence)) {
    if (isMapping(value)) {
      // A nested mapping inherits its unit from the key that holds it:
      // `thresholds_pct` contains fractions, `thresholds_sigma` does not.
      const inherited = unitFor(key);
      nested.push({
        label: labelFor(key),
        entries: Object.entries(value).map(([childKey, childValue]) =>
          entryFor(
            childKey,
            childValue,
            inherited === 'unknown' ? unitFor(childKey) : inherited,
            currency,
          ),
        ),
      });
      continue;
    }
    primary.push(entryFor(key, value, unitFor(key), currency));
  }

  const sections: EvidenceSection[] = [];
  if (primary.length > 0) sections.push({ label: null, entries: primary });
  return [...sections, ...nested];
}

function entryFor(key: string, value: unknown, unit: Unit, currency: string): EvidenceEntry {
  const rendered = render(value, unit, currency);
  return {
    key,
    label: labelFor(key),
    value: rendered.value,
    interpreted: rendered.interpreted,
  };
}

function render(
  value: unknown,
  unit: Unit,
  currency: string,
): { value: string; interpreted: boolean } {
  if (value === null || value === undefined) return { value: '—', interpreted: true };

  if (unit === 'money') {
    const minor = toNumber(value);
    // A money key whose value is not a number is a contract violation, not a
    // rounding problem, so it is shown raw rather than coerced to zero.
    if (minor !== null) return { value: formatMoney(minor, currency), interpreted: true };
  }

  if (unit === 'fraction') {
    const fraction = toNumber(value);
    // Weights arrive as exact decimal strings and returns as floats; both are
    // fractions of one, and percent is how a reader compares them.
    if (fraction !== null) return { value: formatPercent(fraction * 100), interpreted: true };
  }

  if (unit === 'share') {
    const fraction = toNumber(value);
    if (fraction !== null) return { value: `${(fraction * 100).toFixed(2)}%`, interpreted: true };
  }

  if (unit === 'timestamp' && typeof value === 'string') {
    const exact = formatExactTime(value);
    if (exact !== 'unknown') return { value: exact, interpreted: true };
  }

  return { value: renderRaw(value), interpreted: false };
}

function renderRaw(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) return value.length === 0 ? '—' : value.map(renderRaw).join(', ');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    // Trimming trailing zeros is presentation; the digits themselves are the
    // rule's, and a z-score of 3.1041 is not improved by eleven more of them.
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
  }
  return String(value);
}

/** `previous_price_minor` -> `Previous price`. */
export function labelFor(key: string): string {
  const special = LABELS[key];
  if (special) return special;
  const suffix = UNIT_SUFFIXES.find((candidate) => key.endsWith(candidate.suffix));
  const stem = suffix ? key.slice(0, -suffix.suffix.length) : key;
  const words = (stem || key).replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function resolveCurrency(evidence: Record<string, unknown>, fallback = 'USD'): string {
  const declared = evidence.currency ?? evidence.base_currency;
  return typeof declared === 'string' && declared.length > 0 ? declared.toUpperCase() : fallback;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
