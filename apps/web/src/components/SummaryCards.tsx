import { observer } from 'mobx-react-lite';
import { AlertTriangle } from 'lucide-react';

import { formatMoney, formatPercent } from '@traders/shared';

import { usePortfolioQuery } from '../queries/portfolio.ts';
import { Delta } from './ui.tsx';

export const SummaryCards = observer(function SummaryCards() {
  const summary = usePortfolioQuery().data?.summary;
  if (!summary) return null;
  const currency = summary.baseCurrency;

  return (
    <div className="space-y-3">
      {/* Two by two on a phone: stacked one per row they took 390 px, half a
          screen, before anything else. The percentage goes on its own line so a
          160 px card never has to wrap a figure. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Total value" value={formatMoney(summary.totalValueMinor, currency)} />
        <Metric
          label="Total cost"
          value={formatMoney(summary.totalCostMinor, currency)}
          hint={`${summary.pricedCount} of ${summary.holdingsCount} priced`}
        />
        <Metric
          label="Unrealised P&L"
          value={<Delta value={summary.pnlMinor}>{formatMoney(summary.pnlMinor, currency)}</Delta>}
          detail={<Delta value={summary.pnlMinor}>{formatPercent(summary.pnlPct)}</Delta>}
        />
        <Metric
          label="Today"
          value={
            <Delta value={summary.dayChangeMinor}>
              {summary.dayChangeMinor === null ? '—' : formatMoney(summary.dayChangeMinor, currency)}
            </Delta>
          }
          detail={
            summary.dayChangeMinor === null ? undefined : (
              <Delta value={summary.dayChangeMinor}>{formatPercent(summary.dayChangePct)}</Delta>
            )
          }
        />
      </div>

      {summary.degraded && (
        <div className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            This view is incomplete.
            {summary.unpricedSymbols.length > 0 && (
              <>
                {' '}
                No provider could price{' '}
                <strong className="font-semibold">{summary.unpricedSymbols.join(', ')}</strong>, so
                those positions are excluded from the totals rather than valued at zero.
              </>
            )}{' '}
            Some quotes may be served from the last known price.
          </p>
        </div>
      )}
    </div>
  );
});

function Metric({
  label,
  value,
  detail,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  /** A second figure under the first, the same weight as a hint: a percentage. */
  detail?: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-border-subtle bg-surface-raised px-3 py-3 sm:px-4">
      <p className="text-xs uppercase tracking-wide text-text-muted">{label}</p>
      <p className="mt-1 text-base font-semibold tabular-nums sm:text-lg">{value}</p>
      {detail && <p className="text-sm font-medium tabular-nums">{detail}</p>}
      {hint && <p className="mt-1 text-xs text-text-muted">{hint}</p>}
    </div>
  );
}
