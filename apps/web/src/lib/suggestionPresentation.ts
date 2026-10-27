/**
 * How an agent review's suggestion reads (D340-D343): each value of the one
 * setting it changes, in the reader's language. Every figure is the
 * suggestion's own evidence or change; nothing here computes a new one.
 */

import type { MarketCap, SuggestionSetting, SuggestionValue } from '@traders/shared';

import { t } from '../i18n/index.ts';
import { formatNumber, formatShare } from '../i18n/format.ts';

/** Basis points as a share: 2,000 is "20%", 1,250 is "12.50%". */
export function bpsShare(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return formatShare(null);
  // Whole percents as such ("20%"); anything finer to the basis point the evidence holds.
  return formatShare(bps / 100, bps % 100 === 0 ? 0 : 2);
}

/** One value of a setting, as the agent's Settings tab would name it. */
export function settingValue(setting: SuggestionSetting, value: SuggestionValue): string {
  switch (setting) {
    case 'cash_buffer_bps':
    case 'max_position_bps':
      return value === null ? t('agents.mandate.noLimit') : bpsShare(value as number);
    case 'market_caps': {
      const caps = (value as MarketCap[] | null) ?? [];
      if (caps.length === 0) return t('agents.review.values.anySize');
      return caps.map((cap) => t(`agents.mandate.caps.${cap}`)).join(t('agents.review.values.listSeparator'));
    }
    case 'risk_level':
      return value === null ? t('agents.mandate.notSet') : t('agents.review.values.risk', { level: formatNumber(value as number) });
    case 'max_decisions':
      return formatNumber(value as number);
    case 'scan_every_hours':
      return value === null
        ? t('agents.review.values.noMarketScans')
        : t('agents.review.values.everyHours', { count: value as number });
    case 'allow_etfs':
      return value ? t('agents.review.values.allowed') : t('agents.review.values.notAllowed');
  }
}
