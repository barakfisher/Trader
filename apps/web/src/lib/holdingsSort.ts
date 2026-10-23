/**
 * The holdings tables' order (M10 decision 21, D267 PR 7): any column, up or
 * down, in the browser, and kept in the address as `?sort=<column>&dir=asc|desc`
 * beside `?holdings=`, so a sorted view survives a reload and can be sent.
 *
 * **A row with no figure sorts last in both directions** - an unpriced
 * holding's value, a holding with no cost basis's P&L (D230). Sorting them as
 * zero would put "we do not know" between the gains and the losses, which is a
 * figure invented by its position (guideline 7).
 *
 * Ties, and the rows with no figure, keep the symbol's alphabetical order, so a
 * sort never shuffles rows between renders. With no `sort` in the address the
 * server's order stands.
 *
 * Quantities are decimal strings (guideline 4) and are compared as decimals,
 * digit by digit, never through a float. A price is compared within its
 * currency: prices in two currencies are not one scale, so the currency code
 * orders first.
 */

export const SORT_KEYS = ['symbol', 'quantity', 'price', 'day', 'value', 'cost', 'pnl', 'pnlPct', 'weight'] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDirection = 'asc' | 'desc';

export interface HoldingsSort {
  key: SortKey;
  direction: SortDirection;
}

/** What a row is sorted by. Null is "no figure", and sorts last whatever the direction. */
export interface SortFields {
  symbol: string;
  quantity: string;
  price: { minor: number; currency: string } | null;
  day: number | null;
  value: number | null;
  cost: number | null;
  pnl: number | null;
  pnlPct: number | null;
  weight: number | null;
}

function isSortKey(value: unknown): value is SortKey {
  return (SORT_KEYS as readonly unknown[]).includes(value);
}

/** The order the address asks for, or null for the server's. Anything unrecognised is ignored. */
export function holdingsSortFrom(search: unknown): HoldingsSort | null {
  const params = (search ?? {}) as Record<string, unknown>;
  if (!isSortKey(params.sort)) return null;
  return { key: params.sort, direction: params.dir === 'asc' ? 'asc' : 'desc' };
}

/** The address's values for an order; undefined for the server's, so the plain address means it. */
export function holdingsSortSearch(sort: HoldingsSort | null): { sort?: SortKey; dir?: SortDirection } {
  return sort === null ? { sort: undefined, dir: undefined } : { sort: sort.key, dir: sort.direction };
}

/** A column's first direction: names A to Z, figures largest first. */
export function firstDirection(key: SortKey): SortDirection {
  return key === 'symbol' ? 'asc' : 'desc';
}

/** The order after a click on `key`'s header: the other direction on the same column, else its first. */
export function nextSort(current: HoldingsSort | null, key: SortKey): HoldingsSort {
  if (current?.key === key) return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  return { key, direction: firstDirection(key) };
}

/** Two digit strings of equal length, compared as numbers: plain code-unit order, never the locale's. */
function digits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** -1, 0 or 1 for two decimal strings, signed or not, exactly. */
export function compareDecimal(a: string, b: string): number {
  const parse = (text: string) => {
    const trimmed = text.trim();
    const negative = trimmed.startsWith('-');
    const [whole = '0', fraction = ''] = trimmed.replace(/^[-+]/, '').split('.');
    return { negative, whole: whole.replace(/^0+(?=\d)/, ''), fraction: fraction.replace(/0+$/, '') };
  };
  const x = parse(a);
  const y = parse(b);
  const zero = (n: { whole: string; fraction: string }) => /^0*$/.test(n.whole) && n.fraction === '';
  const xNeg = x.negative && !zero(x);
  const yNeg = y.negative && !zero(y);
  if (xNeg !== yNeg) return xNeg ? -1 : 1;
  let magnitude =
    x.whole.length !== y.whole.length ? Math.sign(x.whole.length - y.whole.length) : digits(x.whole, y.whole);
  if (magnitude === 0) {
    const width = Math.max(x.fraction.length, y.fraction.length);
    magnitude = digits(x.fraction.padEnd(width, '0'), y.fraction.padEnd(width, '0'));
  }
  return Math.sign(magnitude) * (xNeg ? -1 : 1);
}

function compareKnown(key: SortKey, a: SortFields, b: SortFields): number | null {
  switch (key) {
    case 'symbol':
      return a.symbol.localeCompare(b.symbol);
    case 'quantity':
      return compareDecimal(a.quantity, b.quantity);
    case 'price':
      if (a.price === null || b.price === null) return null;
      return a.price.currency.localeCompare(b.price.currency) || Math.sign(a.price.minor - b.price.minor);
    default: {
      const x = a[key];
      const y = b[key];
      if (x === null || y === null) return null;
      return Math.sign(x - y);
    }
  }
}

function missing(key: SortKey, fields: SortFields): boolean {
  if (key === 'symbol' || key === 'quantity') return false;
  return fields[key] === null;
}

/** `rows` in the order asked for; a new array, the input untouched. */
export function sortHoldings<T>(rows: readonly T[], fieldsOf: (row: T) => SortFields, sort: HoldingsSort | null): T[] {
  if (sort === null) return [...rows];
  const sign = sort.direction === 'asc' ? 1 : -1;
  const keyed = rows.map((row) => ({ row, fields: fieldsOf(row) }));
  keyed.sort((a, b) => {
    const aMissing = missing(sort.key, a.fields);
    const bMissing = missing(sort.key, b.fields);
    if (aMissing !== bMissing) return aMissing ? 1 : -1;
    const compared = aMissing ? 0 : (compareKnown(sort.key, a.fields, b.fields) ?? 0) * sign;
    return compared || a.fields.symbol.localeCompare(b.fields.symbol);
  });
  return keyed.map(({ row }) => row);
}
