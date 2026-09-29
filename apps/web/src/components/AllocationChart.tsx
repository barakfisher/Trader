import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

import { formatMoney, minorToNumber } from '@traders/shared';

import { baseCurrencyOf } from '../lib/portfolioView.ts';
import { usePortfolioQuery } from '../queries/portfolio.ts';
import { Card } from './ui.tsx';

/** Categorical palette: distinguishable, and never reusing the gain/loss colours. */
const PALETTE = ['#6d8bff', '#59c2e8', '#9a7bf0', '#4fb9a5', '#e5a13c', '#e2736f', '#7f8bb0', '#c2d24b'];

export const AllocationChart = observer(function AllocationChart() {
  const { data: portfolio } = usePortfolioQuery();
  const [groupBy, setGroupBy] = useState<'assetClass' | 'instrument'>('assetClass');

  const slices =
    groupBy === 'assetClass'
      ? portfolio?.allocationByAssetClass
      : portfolio?.allocationByInstrument;
  const currency = baseCurrencyOf(portfolio);

  if (!slices || slices.length === 0) return null;

  const data = slices.map((slice) => ({
    name: slice.label,
    value: minorToNumber(slice.valueMinor, currency),
    valueMinor: slice.valueMinor,
    weightPct: slice.weightPct,
  }));

  return (
    <Card
      title="Allocation"
      action={
        <div className="flex gap-1 rounded-lg border border-border-subtle p-0.5 text-xs">
          {(['assetClass', 'instrument'] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setGroupBy(option)}
              className={`rounded px-2 py-1 transition ${
                groupBy === option ? 'bg-surface-hover text-text-primary' : 'text-text-muted'
              }`}
            >
              {option === 'assetClass' ? 'By class' : 'By holding'}
            </button>
          ))}
        </div>
      }
    >
      {/* No entry animation: when the dashboard is remounted with the portfolio
          already loaded - coming back from any other view - the animated Pie
          drew zero sectors and the card stayed blank until a full reload. */}
      <div className="h-64">
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
              contentStyle={{
                background: '#131a2e',
                border: '1px solid #253052',
                borderRadius: 8,
                fontSize: 12,
              }}
              formatter={(_value, _name, item) => {
                const payload = item.payload as { valueMinor: number; weightPct: number };
                return [`${formatMoney(payload.valueMinor, currency)} (${payload.weightPct.toFixed(1)}%)`, ''];
              }}
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
              {entry.name}
            </span>
            <span className="text-text-muted">{entry.weightPct.toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </Card>
  );
});
