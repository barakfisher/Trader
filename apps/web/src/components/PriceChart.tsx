import { useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { formatMoney, formatPercent, minorToNumber, type DailyClose } from '@traders/shared';

import { errorMessage } from '../api/client.ts';
import {
  RANGES,
  chartPoints,
  coverageText,
  dayName,
  formatDay,
  levelPosition,
  inRange,
  isOpenDay,
  rangeChange,
  type ChartPoint,
  type RangeKey,
} from '../lib/priceChart.ts';
import { formatExactTime } from '../lib/relativeTime.ts';
import { CHART_DIRECTION } from '../lib/textDirection.ts';
import { useHoldingHistoryQuery } from '../queries/holding.ts';
import { Card, Delta, ErrorNote, Spinner } from './ui.tsx';

/**
 * The equity curve's pair (decision 66), with the same jobs: the accent for the
 * measured series, and olive, dashed as well, for cost. The pair passed the
 * dataviz palette validator against the card surface; the app's green and red
 * stay reserved for gain and loss.
 */
const PRICE_COLOUR = '#6d8bff';
const COST_COLOUR = '#8f9b2f';

const tickDay = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * A holding's daily closes, from stored prices only, with the price it cost as
 * a dashed line - so "above or below what I paid" is visible without arithmetic.
 */
export function PriceChart({
  holdingId,
  costPerUnitMinor,
  costCurrency,
}: {
  holdingId: string;
  /** Cost basis per unit, when one was recorded. */
  costPerUnitMinor: number | null;
  costCurrency: string;
}) {
  const history = useHoldingHistoryQuery(holdingId, true);
  const [range, setRange] = useState<RangeKey>('3m');
  const [asTable, setAsTable] = useState(false);

  const closes = inRange(history.data?.closes ?? [], range);
  const currency = closes[0]?.currency ?? costCurrency;
  // A cost in another currency than the price is not comparable on one axis.
  const cost = costPerUnitMinor !== null && costCurrency === currency ? costPerUnitMinor : null;
  const points = chartPoints(closes);
  const data = points.map((point) => ({
    ...point,
    price: point.priceMinor === null ? null : minorToNumber(point.priceMinor, currency),
  }));
  const change = rangeChange(closes);
  // Drawn only when the price came near it: an axis stretched to a cost far
  // below (NVDA's $98.75 under a $200 price) flattens every move on the chart.
  const costPosition = cost === null ? null : levelPosition(cost, closes);

  return (
    <Card
      title="Price"
      action={
        closes.length > 0 && (
          <div className="flex items-center gap-3">
            <div className="flex gap-1" role="group" aria-label="Range">
              {RANGES.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  aria-pressed={range === option.key}
                  onClick={() => setRange(option.key)}
                  className={`rounded px-2 py-0.5 text-xs ${
                    range === option.key
                      ? 'bg-surface-hover text-text-primary'
                      : 'text-text-muted hover:text-text-primary'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="text-xs text-text-muted underline hover:text-text-primary"
              onClick={() => setAsTable(!asTable)}
            >
              {asTable ? 'Chart' : 'Table'}
            </button>
          </div>
        )
      }
    >
      {history.isPending && <Spinner label="Loading the stored closes…" />}
      {history.error && (
        <ErrorNote
          message={errorMessage(history.error, 'Could not load the price history.')}
          onRetry={() => void history.refetch()}
        />
      )}

      {history.data !== undefined && (
        <p className="mb-2 text-xs text-text-muted">{coverageText(closes)}</p>
      )}

      {change && (
        <p className="mb-3 text-sm">
          {formatMoney(change.from.priceMinor, currency)} on {formatDay(change.from.day)} to{' '}
          {formatMoney(change.to.priceMinor, currency)} on {dayName(change.to.day)}:{' '}
          <Delta value={change.changeMinor}>
            {formatMoney(change.changeMinor, currency)} ({formatPercent(change.changePct)})
          </Delta>
        </p>
      )}

      {closes.length > 0 && !asTable && (
        <>
          <ul className="mb-2 flex gap-4 text-xs text-text-muted" aria-hidden>
            <li className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 rounded" style={{ background: PRICE_COLOUR }} />
              Daily close
            </li>
            {cost !== null && (
              <li className="flex items-center gap-1.5">
                <span className="h-0 w-4 border-t-2 border-dashed" style={{ borderColor: COST_COLOUR }} />
                Your cost per unit {formatMoney(cost, currency)}
                {costPosition === 'below' && ' (below this range)'}
                {costPosition === 'above' && ' (above this range)'}
              </li>
            )}
          </ul>
          <div className="h-56" dir={CHART_DIRECTION} role="img" aria-label={`Daily closing price. ${coverageText(closes)}`}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#253052" strokeDasharray="2 4" vertical={false} />
                <XAxis
                  dataKey="day"
                  tickFormatter={(day: string) => tickDay.format(new Date(`${day}T00:00:00Z`))}
                  tick={{ fill: '#94a0c0', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={32}
                />
                <YAxis
                  tickFormatter={(value: number) => compactMoney(value, currency)}
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
                      <CloseTooltip point={payload[0].payload as ChartPoint} currency={currency} />
                    ) : null
                  }
                />
                {cost !== null && costPosition === 'within' && (
                  <ReferenceLine
                    y={minorToNumber(cost, currency)}
                    stroke={COST_COLOUR}
                    strokeWidth={2}
                    strokeDasharray="5 4"
                  />
                )}
                {/* No dots: a year of closes is ~250 points. No entry animation:
                    an animated series remounted with its data present draws nothing. */}
                <Line
                  type="linear"
                  dataKey="price"
                  stroke={PRICE_COLOUR}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, fill: PRICE_COLOUR, stroke: '#131a2e', strokeWidth: 2 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}

      {closes.length > 0 && asTable && <ClosesTable closes={closes} currency={currency} />}
    </Card>
  );
}

function CloseTooltip({ point, currency }: { point: ChartPoint; currency: string }) {
  if (point.priceMinor === null) return null;
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-raised px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-medium text-text-primary">{dayName(point.day)}</p>
      <p className="text-text-primary">
        {isOpenDay(point.day) ? 'Latest' : 'Close'} {formatMoney(point.priceMinor, currency)}
      </p>
      {point.asOf && <p className="text-text-muted">Observed {formatExactTime(point.asOf)}</p>}
    </div>
  );
}

/** The same closes as rows, newest first: for a screen reader, or anyone who wants the numbers. */
function ClosesTable({ closes, currency }: { closes: DailyClose[]; currency: string }) {
  return (
    <div className="max-h-80 overflow-y-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border-subtle text-start text-xs uppercase tracking-wide text-text-muted">
            <th className="pb-2 font-medium">Day</th>
            <th className="pb-2 text-end font-medium">Close</th>
          </tr>
        </thead>
        <tbody>
          {[...closes].reverse().map((close) => (
            <tr key={close.day} className="border-b border-border-subtle/50 last:border-0">
              <td className="py-1.5">{dayName(close.day)}</td>
              <td className="py-1.5 text-end" title={`Observed ${formatExactTime(close.asOf)}`}>
                {formatMoney(close.priceMinor, currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** "$230" or "$84K" for an axis tick: the tooltip and table carry the exact figure. */
function compactMoney(value: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}
