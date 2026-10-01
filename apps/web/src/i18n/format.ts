/**
 * Numbers, money, percents and dates in the active language's locale.
 *
 * Every figure the interface prints goes through here, so the language decides
 * how it reads: a sign, a currency symbol and a date order are part of the
 * language, not of the string around them. Hebrew's `Intl` output also carries
 * the direction marks that keep "-1.23%" in one piece on a right-to-left page -
 * the reason a hand-built "+" or "%" is not used anywhere.
 *
 * English keeps exactly what the app printed before this module existed: US
 * number formatting ("$1,234.50") with day-first dates ("28 Sept 2026") - the
 * date order chosen in M6 PR 13, where US month-first order was rejected.
 */

import { formatMoney as formatMoneyIn } from '@traders/shared';

import { currentLanguage, type Language } from './index.ts';

/** The `Intl` locale each language formats numbers and dates in. */
export const FORMAT_LOCALES: Record<Language, { number: string; date: string }> = {
  en: { number: 'en-US', date: 'en-GB' },
};

export function numberLocale(): string {
  return FORMAT_LOCALES[currentLanguage()].number;
}

export function dateLocale(): string {
  return FORMAT_LOCALES[currentLanguage()].date;
}

/** Integer minor units as money in its own currency; null is "—", never zero (guideline 7). */
export function formatMoney(
  minor: number | null | undefined,
  currency: string,
  options: { compact?: boolean } = {},
): string {
  return formatMoneyIn(minor, currency, { ...options, locale: numberLocale() });
}

/** A major-unit amount for an axis tick - "$100K": the tooltip and table carry the exact figure. */
export function formatCompactMoney(value: number, currency: string): string {
  return new Intl.NumberFormat(numberLocale(), {
    style: 'currency',
    currency,
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

/**
 * A signed change in percent - "+1.23%", "-0.40%" - from a value already in
 * percent (1.23, not 0.0123). Zero is "+0.00%", as it always was.
 */
export function formatPercent(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return percent(value === 0 ? 0 : value, digits, 'always');
}

/** An unsigned share in percent - "35.4%" - from a value already in percent. */
export function formatShare(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return percent(value, digits, 'auto');
}

/** A plain number - a count, a quantity shown as such - grouped as the locale groups it. */
export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(numberLocale(), options).format(value);
}

/** A number to exactly `digits` places - "0.24" - as a score or a threshold is shown. */
export function formatFixed(value: number, digits: number): string {
  return formatNumber(value, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false });
}

/** A date or time in the date locale; the caller passes the zone. */
export function formatDate(when: Date, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(dateLocale(), options).format(when);
}

function percent(value: number, digits: number, signDisplay: 'always' | 'auto'): string {
  return new Intl.NumberFormat(numberLocale(), {
    style: 'percent',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    signDisplay,
  }).format(value / 100);
}
