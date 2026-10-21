import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { AlertTriangle, ChevronDown } from 'lucide-react';

import type { ConsolidatedPendingTrade, PortfolioSummary } from '@traders/shared';

import { formatMoney, formatNumber, formatPercent } from '../i18n/format.ts';
import { Trans, useTranslation } from '../i18n/index.ts';
import { agentName } from '../lib/agentPresentation.ts';
import type { SummarySource } from '../lib/combinedHoldings.ts';
import { isUrgent, timeLeft } from '../lib/proposalCountdown.ts';
import { formatExactTime } from '../lib/relativeTime.ts';
import { Drawer } from './Drawer.tsx';
import { ProposalApprovalDrawer } from './ProposalApproval.tsx';
import { Delta } from './ui.tsx';

/**
 * The dashboard's four cards - total value, total cost, unrealised P&L, today
 * - for whatever the holdings scope shows (D231): the real portfolio, an agent,
 * or several of them added together.
 *
 * A figure that adds sources never stands alone: when there is more than one
 * source, or an agent's trade is waiting, each card is a button that opens
 * the split by source and the waiting trades. A click, not a hover, because a
 * phone has no hover.
 */
export const SummaryCards = observer(function SummaryCards({
  summary,
  sources = [],
  pendingTrades = [],
}: {
  summary: PortfolioSummary | undefined;
  /** What the figures add up; more than one makes the cards open their breakdown. */
  sources?: SummarySource[];
  pendingTrades?: ConsolidatedPendingTrade[];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [approving, setApproving] = useState<string | null>(null);
  if (!summary) return null;
  const currency = summary.baseCurrency;
  const explained = sources.length > 1 || pendingTrades.length > 0;

  const onOpen = explained ? () => setOpen(true) : undefined;
  const cards = (
    <>
      <Metric onOpen={onOpen} label={t('summary.totalValue')} value={formatMoney(summary.totalValueMinor, currency)} />
      <Metric
        onOpen={onOpen}
        label={t('summary.totalCost')}
        value={formatMoney(summary.totalCostMinor, currency)}
        hint={t('summary.priced', { priced: summary.pricedCount, holdings: summary.holdingsCount })}
      />
      <Metric
        onOpen={onOpen}
        label={t('summary.unrealisedPnl')}
        value={
          <Delta value={summary.pnlMinor}>{summary.pnlMinor === null ? '—' : formatMoney(summary.pnlMinor, currency)}</Delta>
        }
        detail={summary.pnlMinor === null ? undefined : <Delta value={summary.pnlMinor}>{formatPercent(summary.pnlPct)}</Delta>}
        warning={
          summary.uncostedSymbols.length > 0
            ? t('summary.uncosted', { count: summary.uncostedSymbols.length })
            : undefined
        }
      />
      <Metric
        onOpen={onOpen}
        label={t('summary.today')}
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
    </>
  );

  return (
    <div className="space-y-3">
      {/* Two by two on a phone: stacked one per row they took 390 px, half a
          screen, before anything else. The percentage goes on its own line so a
          160 px card never has to wrap a figure. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{cards}</div>
      {explained && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          className="flex items-center gap-1 text-xs text-accent hover:underline"
        >
          <ChevronDown className="size-3.5" aria-hidden />
          {pendingTrades.length > 0
            ? t('combined.breakdown.openWithTrades', { count: pendingTrades.length })
            : t('combined.breakdown.open')}
        </button>
      )}

      {summary.uncostedSymbols.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            <Trans
              i18nKey="summary.uncostedNote"
              values={{ symbols: summary.uncostedSymbols.join(t('common.listSeparator')) }}
              components={{ strong: <strong className="font-semibold" /> }}
            />
          </p>
        </div>
      )}

      {summary.degraded && (
        <div className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            {t('summary.incomplete')}
            {summary.unpricedSymbols.length > 0 && (
              <Trans
                i18nKey="summary.unpriced"
                values={{ symbols: summary.unpricedSymbols.join(t('common.listSeparator')) }}
                components={{ strong: <strong className="font-semibold" /> }}
              />
            )}
            {t('summary.lastKnown')}
          </p>
        </div>
      )}

      {open && (
        <Drawer title={t('combined.breakdown.title')} closeLabel={t('holdings.actions.close')} onClose={() => setOpen(false)}>
          <Breakdown
            summary={summary}
            sources={sources}
            pendingTrades={pendingTrades}
            onApprove={(proposalId) => {
              setOpen(false);
              setApproving(proposalId);
            }}
          />
        </Drawer>
      )}
      {approving !== null && <ProposalApprovalDrawer proposalId={approving} onClose={() => setApproving(null)} />}
    </div>
  );
});

function Metric({
  label,
  value,
  detail,
  hint,
  warning,
  onOpen,
}: {
  label: string;
  value: React.ReactNode;
  /** A second figure under the first, the same weight as a hint: a percentage. */
  detail?: React.ReactNode;
  hint?: string;
  /** Said with a warning sign: the figure leaves something out. */
  warning?: string;
  /** Opens the breakdown; the card is then a button. */
  onOpen?: () => void;
}) {
  const body = (
    <>
      <span className="block text-xs uppercase tracking-wide text-text-muted">{label}</span>
      <span className="mt-1 block text-base font-semibold tabular-nums sm:text-lg">{value}</span>
      {detail && <span className="block text-sm font-medium tabular-nums">{detail}</span>}
      {hint && <span className="mt-1 block text-xs text-text-muted">{hint}</span>}
      {warning && (
        <span className="mt-1 flex items-center gap-1 text-xs text-warn">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
          {warning}
        </span>
      )}
    </>
  );
  const frame = 'min-w-0 rounded-xl border border-border-subtle bg-surface-raised px-3 py-3 sm:px-4';
  return onOpen ? (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      className={`${frame} text-start transition hover:border-accent/50`}
    >
      {body}
    </button>
  ) : (
    <div className={frame}>{body}</div>
  );
}

/** Each source's four figures, then their total, then the trades waiting. */
function Breakdown({
  summary,
  sources,
  pendingTrades,
  onApprove,
}: {
  summary: PortfolioSummary;
  sources: SummarySource[];
  pendingTrades: ConsolidatedPendingTrade[];
  onApprove: (proposalId: string) => void;
}) {
  const { t } = useTranslation();
  const currency = summary.baseCurrency;
  return (
    <div className="space-y-4 text-sm">
      {sources.length > 1 && <p className="text-xs text-text-muted">{t('combined.breakdown.hint')}</p>}
      <ul className="space-y-3">
        {sources.map((source) => (
          <li key={source.key} className="rounded-lg border border-border-subtle p-3">
            <p className="mb-2 flex items-center gap-2 font-medium">
              <bdi>{agentName({ isPrimary: source.isPrimary, name: source.name })}</bdi>
              <SourceBadge isPrimary={source.isPrimary} />
            </p>
            <Figures summary={source.summary} currency={currency} />
            {source.cashMinor !== null && (
              <p className="mt-2 text-xs text-text-muted">
                {t('combined.breakdown.cash', { cash: formatMoney(source.cashMinor, currency) })}
              </p>
            )}
          </li>
        ))}
        {sources.length > 1 && (
          <li className="rounded-lg border border-accent/40 bg-accent/5 p-3">
            <p className="mb-2 font-medium">{t('combined.breakdown.total')}</p>
            <Figures summary={summary} currency={currency} />
          </li>
        )}
      </ul>

      {pendingTrades.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            {t('consolidated.pending.title', { count: pendingTrades.length })}
          </h3>
          <ul className="divide-y divide-border-subtle/50">
            {pendingTrades.map((trade) => (
              <li key={trade.proposalId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
                <span>
                  {t('consolidated.pending.line', {
                    agent: trade.agentName,
                    side: t(`consolidated.pending.sides.${trade.side}`),
                    quantity: formatNumber(Number(trade.quantity), { maximumFractionDigits: 8 }),
                    symbol: trade.symbol,
                    price: formatMoney(trade.agentPriceMinor, trade.currency),
                  })}
                  <span
                    className={`ms-2 ${isUrgent(trade.expiresAt) ? 'text-loss' : 'text-text-muted'}`}
                    title={formatExactTime(trade.expiresAt)}
                  >
                    {timeLeft(trade.expiresAt) ?? t('countdown.expired')}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => onApprove(trade.proposalId)}
                  className="rounded-lg border border-accent/40 px-2 py-1 font-medium text-accent hover:bg-accent/10"
                >
                  {t('combined.approve.button')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Figures({ summary, currency }: { summary: PortfolioSummary; currency: string }) {
  const { t } = useTranslation();
  const money = (minor: number | null) => (minor === null ? '—' : formatMoney(minor, currency));
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
      <div>
        <dt className="text-xs text-text-muted">{t('summary.totalValue')}</dt>
        <dd className="font-medium tabular-nums">
          <bdi>{money(summary.totalValueMinor)}</bdi>
        </dd>
      </div>
      <div>
        <dt className="text-xs text-text-muted">{t('summary.totalCost')}</dt>
        <dd className="font-medium tabular-nums">
          <bdi>{money(summary.totalCostMinor)}</bdi>
        </dd>
      </div>
      <div>
        <dt className="text-xs text-text-muted">{t('summary.unrealisedPnl')}</dt>
        <dd className="font-medium tabular-nums">
          <Delta value={summary.pnlMinor}>
            <bdi>{money(summary.pnlMinor)}</bdi>
            {summary.pnlMinor !== null && <> ({formatPercent(summary.pnlPct)})</>}
          </Delta>
        </dd>
      </div>
      <div>
        <dt className="text-xs text-text-muted">{t('summary.today')}</dt>
        <dd className="font-medium tabular-nums">
          <Delta value={summary.dayChangeMinor}>
            <bdi>{money(summary.dayChangeMinor)}</bdi>
          </Delta>
        </dd>
      </div>
    </dl>
  );
}

/** *Real* or *Simulated*, as every holder is badged on the dashboard. */
export function SourceBadge({ isPrimary }: { isPrimary: boolean }) {
  const { t } = useTranslation();
  return (
    <span
      className={
        isPrimary
          ? 'rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent'
          : 'rounded-full border border-border-subtle px-2 py-0.5 text-[10px] text-text-muted'
      }
    >
      {isPrimary ? t('agents.real') : t('agents.simulated')}
    </span>
  );
}
