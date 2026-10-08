import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { minorToNumber, type AgentPerformanceResponse, type PerformancePoint } from '@traders/shared';

import { errorMessage } from '../api/client.ts';
import { formatCompactMoney, formatMoney, formatNumber, formatPercent, formatShare } from '../i18n/format.ts';
import { useTranslation } from '../i18n/index.ts';
import { CHART_DIRECTION } from '../lib/textDirection.ts';
import { useAgentPerformanceQuery } from '../queries/agents.ts';
import { COST_COLOUR, VALUE_COLOUR, formatDay } from './EquityCurve.tsx';
import { ChartTooltip } from './ChartTooltip.tsx';
import { Card, Delta, ErrorNote, Spinner } from './ui.tsx';

/**
 * How a simulated agent has done (Stage 3, PR 7; D24, D36-D42): its net worth
 * at each close beside what the same deposits would be worth in SPY, the two
 * returns over those deposits, and the 30/60/90-day score of the agent's own
 * decisions. A figure that needed a missing price is not shown (§5.4).
 */
export function AgentPerformance({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const performance = useAgentPerformanceQuery(agentId);
  return (
    <Card title={t('agents.performance.title')}>
      {performance.isPending && <Spinner label={t('agents.performance.loading')} />}
      {performance.error && (
        <ErrorNote
          message={errorMessage(performance.error, t('agents.performance.loadFailed'))}
          onRetry={() => void performance.refetch()}
        />
      )}
      {performance.data && <PerformanceBody data={performance.data} />}
    </Card>
  );
}

function PerformanceBody({ data }: { data: AgentPerformanceResponse }) {
  const { t } = useTranslation();
  const money = (minor: number | null) => <bdi>{formatMoney(minor, data.currency)}</bdi>;
  const comparison = data.comparison;
  return (
    <div className="space-y-4">
      {comparison === null ? (
        <p className="text-sm text-text-muted">{t('agents.performance.noCloseYet')}</p>
      ) : (
        <>
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-text-muted">{t('agents.performance.agent')}</dt>
              <dd className="font-medium">
                <Delta value={comparison.pnlMinor}>
                  {money(comparison.pnlMinor)} <bdi>{formatPercent(comparison.returnPct)}</bdi>
                </Delta>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">
                {t('agents.performance.benchmark', { symbol: data.benchmarkSymbol })}
              </dt>
              <dd className="font-medium">
                <Delta value={comparison.benchmarkPnlMinor}>
                  {money(comparison.benchmarkPnlMinor)} <bdi>{formatPercent(comparison.benchmarkReturnPct)}</bdi>
                </Delta>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">{t('agents.performance.difference', { symbol: data.benchmarkSymbol })}</dt>
              <dd className="font-medium">
                <Delta value={comparison.differencePts}>
                  {comparison.differencePts === null
                    ? '—'
                    : t('agents.performance.points', {
                        points: formatNumber(comparison.differencePts, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                          signDisplay: 'exceptZero',
                        }),
                      })}
                </Delta>
              </dd>
            </div>
          </dl>
          <p className="text-xs text-text-muted">
            {t('agents.performance.hint', {
              day: formatDay(comparison.day),
              deposits: formatMoney(comparison.depositsMinor, data.currency),
              symbol: data.benchmarkSymbol,
            })}
            {data.pendingDepositsMinor > 0 &&
              ` ${t('agents.performance.pending', { amount: formatMoney(data.pendingDepositsMinor, data.currency) })}`}
          </p>
          {data.series.length > 0 && <PerformanceChart data={data} />}
        </>
      )}
      <ScoreTable data={data} />
    </div>
  );
}

function PerformanceChart({ data }: { data: AgentPerformanceResponse }) {
  const { t } = useTranslation();
  const rows = data.series.map((point) => ({
    ...point,
    agent: point.netWorthMinor === null ? null : minorToNumber(point.netWorthMinor, data.currency),
    benchmark: point.benchmarkMinor === null ? null : minorToNumber(point.benchmarkMinor, data.currency),
  }));
  return (
    <>
      <ul className="flex gap-4 text-xs text-text-muted" aria-hidden>
        <li className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded" style={{ background: VALUE_COLOUR }} />
          {t('agents.performance.agentLine')}
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-0 w-4 border-t-2 border-dashed" style={{ borderColor: COST_COLOUR }} />
          {t('agents.performance.benchmarkLine', { symbol: data.benchmarkSymbol })}
        </li>
      </ul>
      <div
        className="h-48"
        dir={CHART_DIRECTION}
        role="img"
        aria-label={t('agents.performance.chartLabel', { count: data.series.length, symbol: data.benchmarkSymbol })}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#253052" strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="day"
              tickFormatter={formatDay}
              tick={{ fill: '#94a0c0', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              minTickGap={24}
            />
            <YAxis
              tickFormatter={(value: number) => formatCompactMoney(value, data.currency)}
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
                  <PointTooltip point={payload[0].payload as PerformancePoint} data={data} />
                ) : null
              }
            />
            {/* No entry animation: an animated series remounted with its data already present draws nothing. */}
            <Line
              type="linear"
              dataKey="benchmark"
              stroke={COST_COLOUR}
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={{ r: 3, fill: COST_COLOUR, strokeWidth: 0 }}
              isAnimationActive={false}
            />
            <Line
              type="linear"
              dataKey="agent"
              stroke={VALUE_COLOUR}
              strokeWidth={2}
              dot={{ r: 3, fill: VALUE_COLOUR, strokeWidth: 0 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

function PointTooltip({ point, data }: { point: PerformancePoint; data: AgentPerformanceResponse }) {
  const { t } = useTranslation();
  const value = (minor: number | null) => (minor === null ? t('agents.performance.unavailable') : formatMoney(minor, data.currency));
  return (
    <ChartTooltip title={formatDay(point.day)}>
      <p className="text-text-primary">{t('agents.performance.tooltipAgent', { value: value(point.netWorthMinor) })}</p>
      <p className="text-text-muted">
        {t('agents.performance.tooltipBenchmark', { symbol: data.benchmarkSymbol, value: value(point.benchmarkMinor) })}
      </p>
      <p className="text-text-muted">
        {t('agents.performance.tooltipDeposits', { value: formatMoney(point.depositsMinor, data.currency) })}
      </p>
    </ChartTooltip>
  );
}

/** The 30/60/90-day score (D39-D41): until the agent decides, it says so rather than showing zeros. */
function ScoreTable({ data }: { data: AgentPerformanceResponse }) {
  const { t } = useTranslation();
  const { score } = data;
  return (
    <div>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
        {t('agents.performance.scoreTitle')}
      </h3>
      {score.agentDecisions === 0 ? (
        <p className="text-sm text-text-muted">{t('agents.performance.noDecisions')}</p>
      ) : (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-start text-xs text-text-muted">
                <th className="pb-2 font-medium">{t('agents.performance.window')}</th>
                <th className="pb-2 text-end font-medium">{t('agents.performance.decisions')}</th>
                <th className="pb-2 text-end font-medium">{t('agents.performance.winRate')}</th>
                <th className="pb-2 text-end font-medium">{t('agents.performance.realised')}</th>
              </tr>
            </thead>
            <tbody>
              {score.windows.map((window) => (
                <tr key={window.days} className="border-b border-border-subtle/50 last:border-0">
                  <td className="py-1.5">{t('agents.performance.days', { count: window.days })}</td>
                  <td className="py-1.5 text-end">{formatNumber(window.decisions)}</td>
                  <td className="py-1.5 text-end">
                    {window.winRatePct === null
                      ? '—'
                      : t('agents.performance.winRateValue', {
                          rate: formatShare(window.winRatePct, 0),
                          wins: window.wins,
                          sells: window.sells,
                        })}
                  </td>
                  <td className="py-1.5 text-end">
                    <Delta value={window.realisedPnlMinor}>
                      <bdi>{formatMoney(window.realisedPnlMinor, data.currency)}</bdi>
                    </Delta>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-text-muted">
            {t('agents.performance.unrealised', {
              value:
                score.unrealisedPnlMinor === null
                  ? t('agents.performance.unavailable')
                  : formatMoney(score.unrealisedPnlMinor, data.currency),
            })}
          </p>
        </>
      )}
    </div>
  );
}
