import { Trans } from 'react-i18next';

import { formatPercent } from '../i18n/format.ts';
import { Delta } from './ui.tsx';

/**
 * How much a holding moved today, in percent, for a phone card (the user,
 * 2026-11-04: on a phone this is the figure looked for, more than the total
 * P&L). An instrument with no price has no change to state: a dash, never zero.
 */
export function DayChange({ pct }: { pct: number | null | undefined }) {
  return (
    <Trans
      i18nKey="holdings.todayChange"
      values={{ change: formatPercent(pct) }}
      components={{ delta: <Delta value={pct}>{null}</Delta> }}
    />
  );
}
