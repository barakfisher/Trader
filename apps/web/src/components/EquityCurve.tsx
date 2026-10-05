import { useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type DotProps,
} from 'recharts';

import { minorToNumber } from '@traders/shared';

import { errorMessage } from '../api/client.ts';
import { formatCompactMoney, formatDate, formatMoney } from '../i18n/format.ts';
import { useTranslation } from '../i18n/index.ts';
import { coverageText, curvePoints, type CurvePoint } from '../lib/equityCurve.ts';
import { baseCurrencyOf } from '../lib/portfolioView.ts';
import { CHART_DIRECTION } from '../lib/textDirection.ts';
import { usePortfolioQuery } from '../queries/portfolio.ts';
import { useSnapshotsQuery } from '../queries/snapshots.ts';
import { Card, ErrorNote, Spinner } from './ui.tsx';

/**
 * Two series on one money axis, coloured by their job: the accent for value,
 * and an olive for cost basis, drawn dashed as well so it never rests on colour
 * alone. The pair was checked with the dataviz palette validator against the
 * card surface (#131a2e): lightness, chroma, colour-blind and normal-vision
 * separation and contrast all pass. The app's grey would have read as "no
 * data", and its green and red are gain and loss.
 */
export const VALUE_COLOUR = '#6d8bff';
export const COST_COLOUR = '#8f9b2f';

/** Dates are calendar dates, so they are formatted as such: in UTC, where no offset moves them. */
export const formatDay = (date: string) =>
  formatDate(new Date(`${date}T00:00:00Z`), { day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * The portfolio's value per day, from the daily snapshots only.
 *
 * A day without a snapshot is a gap in the line, and a snapshot that
 * understated the total is drawn hollow and says why - see `equityCurve.ts`.
 * Every point has a dot, because a day measured between two gaps is otherwise
 * a line of zero length, and invisible.
 */
export function EquityCurve() {
  const snapshots = useSnapshotsQuery();
  const { t } = useTranslation();
  const currency = baseCurrencyOf(usePortfolioQuery().data);
  const [asTable, setAsTable] = useState(false);

  const points = curvePoints(snapshots.data ?? []);
  const data = points.map((point) => ({
    ...point,
    value: point.totalMinor === null ? null : minorToNumber(point.totalMinor, currency),
    cost: point.costMinor === null ? null : minorToNumber(point.costMinor, currency),
  }));

  return (
    <Card
      title={t('equity.title')}
      action={
        points.length > 0 && (
          <button
            type="button"
            className="text-xs text-text-muted underline hover:text-text-primary"
            onClick={() => setAsTable(!asTable)}
          >
            {asTable ? t('equity.showChart') : t('equity.showTable')}
          </button>
        )
      }
    >
      {snapshots.isPending && <Spinner label={t('equity.loading')} />}
      {snapshots.error && (
        <ErrorNote
          message={errorMessage(snapshots.error, t('equity.loadFailed'))}
          onRetry={() => void snapshots.refetch()}
        />
      )}

      {snapshots.data !== undefined && (
        <p className="mb-3 text-xs text-text-muted">{coverageText(points)}</p>
      )}

      {points.length > 0 && !asTable && (
        <>
          <ul className="mb-2 flex gap-4 text-xs text-text-muted" aria-hidden>
            <li className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 rounded" style={{ background: VALUE_COLOUR }} />
              {t('equity.value')}
            </li>
            <li className="flex items-center gap-1.5">
              <span className="h-0 w-4 border-t-2 border-dashed" style={{ borderColor: COST_COLOUR }} />
              {t('equity.costBasis')}
            </li>
          </ul>
          <div className="h-56" dir={CHART_DIRECTION} role="img" aria-label={t('equity.chartLabel', { coverage: coverageText(points) })}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#253052" strokeDasharray="2 4" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={formatDay}
                  tick={{ fill: '#94a0c0', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={24}
                />
                <YAxis
                  tickFormatter={(value: number) => formatCompactMoney(value, currency)}
                  tick={{ fill: '#94a0c0', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={56}
                  domain={['auto', 'auto']}
                />
                <Tooltip
                  cursor={{ stroke: '#94a0c0', strokeWidth: 1 }}
                  content={({ active, payload }) =>
                    active && payload?.[0] ? (
                      <DayTooltip point={payload[0].payload as CurvePoint} currency={currency} />
                    ) : null
                  }
                />
                {/* No entry animation: an animated series remounted with its data
                    already present draws nothing - the allocation donut's bug. */}
                <Line
                  type="linear"
                  dataKey="cost"
                  stroke={COST_COLOUR}
                  strokeWidth={2}
                  strokeDasharray="5 4"
                  dot={{ r: 4, fill: COST_COLOUR, strokeWidth: 0 }}
                  isAnimationActive={false}
                />
                <Line
                  type="linear"
                  dataKey="value"
                  stroke={VALUE_COLOUR}
                  strokeWidth={2}
                  dot={<ValueDot />}
                  activeDot={{ r: 5, fill: VALUE_COLOUR, stroke: '#131a2e', strokeWidth: 2 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}

      {points.length > 0 && asTable && <CurveTable points={points} currency={currency} />}
    </Card>
  );
}

/** A measured day: filled. An understated one: hollow, so it reads as "not the whole total". */
function ValueDot({ cx, cy, payload }: DotProps & { payload?: CurvePoint }) {
  if (cx === undefined || cy === undefined || payload?.totalMinor == null) return <g />;
  return payload.degraded ? (
    <circle cx={cx} cy={cy} r={4} fill="#131a2e" stroke={VALUE_COLOUR} strokeWidth={2} />
  ) : (
    <circle cx={cx} cy={cy} r={4} fill={VALUE_COLOUR} />
  );
}

function DayTooltip({ point, currency }: { point: CurvePoint; currency: string }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-raised px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-medium text-text-primary">{formatDay(point.date)}</p>
      {point.totalMinor === null ? (
        <p className="text-text-muted">{t('equity.noSnapshotThisDay')}</p>
      ) : (
        <>
          <p className="text-text-primary">
            {t('equity.tooltipValue', { value: formatMoney(point.totalMinor, currency) })}
          </p>
          {point.costMinor !== null && (
            <p className="text-text-muted">
              {t('equity.tooltipCost', { value: formatMoney(point.costMinor, currency) })}
            </p>
          )}
          {point.degraded && (
            <p className="mt-1 text-text-muted">
              {t('equity.understatedDetail', { priced: point.pricedCount, holdings: point.holdingsCount })}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** The same figures as rows: for a screen reader, or anyone who wants the numbers. */
function CurveTable({ points, currency }: { points: CurvePoint[]; currency: string }) {
  const { t } = useTranslation();
  const measured = points.filter((point) => point.totalMinor !== null).reverse();
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border-subtle text-start text-xs uppercase tracking-wide text-text-muted">
          <th className="pb-2 font-medium">{t('equity.day')}</th>
          <th className="pb-2 text-end font-medium">{t('equity.value')}</th>
          <th className="pb-2 text-end font-medium">{t('equity.costBasis')}</th>
        </tr>
      </thead>
      <tbody>
        {measured.map((point) => (
          <tr key={point.date} className="border-b border-border-subtle/50 last:border-0">
            <td className="py-1.5">
              {formatDay(point.date)}
              {point.degraded && <span className="ms-1 text-xs text-text-muted">{t('equity.understated')}</span>}
            </td>
            <td className="py-1.5 text-end">{formatMoney(point.totalMinor!, currency)}</td>
            <td className="py-1.5 text-end text-text-muted">
              {point.costMinor === null ? '—' : formatMoney(point.costMinor, currency)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
