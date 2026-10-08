import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

import { minorToNumber } from '@traders/shared';

import { formatMoney, formatShare } from '../i18n/format.ts';
import { useTranslation } from '../i18n/index.ts';
import {
  readAllocationGrouping,
  rememberAllocationGrouping,
  type AllocationGrouping,
} from '../lib/allocationGrouping.ts';
import { assetClassGroup } from '../lib/assetClass.ts';
import { baseCurrencyOf } from '../lib/portfolioView.ts';
import { CHART_DIRECTION } from '../lib/textDirection.ts';
import { usePortfolioQuery } from '../queries/portfolio.ts';
import { ChartTooltip } from './ChartTooltip.tsx';
import { Card } from './ui.tsx';

/** Categorical palette: distinguishable, and never reusing the gain/loss colours. */
const PALETTE = ['#6d8bff', '#59c2e8', '#9a7bf0', '#4fb9a5', '#e5a13c', '#e2736f', '#7f8bb0', '#c2d24b'];

export const AllocationChart = observer(function AllocationChart() {
  const { data: portfolio } = usePortfolioQuery();
  const { t } = useTranslation();
  const [groupBy, setGroupBy] = useState<AllocationGrouping>(readAllocationGrouping);
  const choose = (grouping: AllocationGrouping) => {
    setGroupBy(grouping);
    rememberAllocationGrouping(grouping);
  };

  const slices =
    groupBy === 'assetClass'
      ? portfolio?.allocationByAssetClass
      : portfolio?.allocationByInstrument;
  const currency = baseCurrencyOf(portfolio);

  if (!slices || slices.length === 0) return null;

  const data: Slice[] = slices.map((slice) => ({
    name: groupBy === 'assetClass' ? assetClassGroup(slice.key, slice.label) : slice.label,
    value: minorToNumber(slice.valueMinor, currency),
    valueMinor: slice.valueMinor,
    weightPct: slice.weightPct,
  }));

  return (
    <Card
      title={t('allocation.title')}
      action={
        <div className="flex gap-1 rounded-lg border border-border-subtle p-0.5 text-xs">
          {(['instrument', 'assetClass'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={groupBy === option}
              onClick={() => choose(option)}
              className={`rounded px-2 py-1 transition ${
                groupBy === option ? 'bg-surface-hover text-text-primary' : 'text-text-muted'
              }`}
            >
              {option === 'assetClass' ? t('allocation.byClass') : t('allocation.byHolding')}
            </button>
          ))}
        </div>
      }
    >
      {/* No entry animation: when the dashboard is remounted with the portfolio
          already loaded - coming back from any other view - the animated Pie
          drew zero sectors and the card stayed blank until a full reload. */}
      <div className="h-64" dir={CHART_DIRECTION}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius="55%"
              outerRadius="85%"
              paddingAngle={2}
              isAnimationActive={false}
            >
              {data.map((entry, index) => (
                <Cell key={entry.name} fill={PALETTE[index % PALETTE.length]} stroke="transparent" />
              ))}
            </Pie>
            <Tooltip
              content={({ active, payload }) =>
                active && payload?.[0] ? <SliceTooltip slice={payload[0].payload as Slice} currency={currency} /> : null
              }
            />
          </PieChart>
        </ResponsiveContainer>
      </div>

      <ul className="mt-2 space-y-1 text-xs">
        {data.map((entry, index) => (
          <li key={entry.name} className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <span
                className="size-2 rounded-full"
                style={{ background: PALETTE[index % PALETTE.length] }}
                aria-hidden
              />
              <bdi>{entry.name}</bdi>
            </span>
            <span className="text-text-muted">{formatShare(entry.weightPct)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
});

type Slice = { name: string; value: number; valueMinor: number; weightPct: number };

function SliceTooltip({ slice, currency }: { slice: Slice; currency: string }) {
  const { t } = useTranslation();
  return (
    <ChartTooltip title={<bdi>{slice.name}</bdi>}>
      <p className="text-text-primary">
        {t('allocation.tooltip', {
          value: formatMoney(slice.valueMinor, currency),
          share: formatShare(slice.weightPct),
        })}
      </p>
    </ChartTooltip>
  );
}
