import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ChevronDown, ChevronRight } from 'lucide-react';

import type {
  AgentView,
  ConsolidatedHoldingsResponse,
  ConsolidatedPendingTrade,
  ConsolidatedPosition,
  ConsolidatedRow,
  SimulatedAgentStanding,
} from '@traders/shared';

import { useTranslation } from '../i18n/index.ts';
import { formatMoney, formatNumber, formatPercent } from '../i18n/format.ts';
import { agentName, agentStateWord } from '../lib/agentPresentation.ts';
import { assetClassName } from '../lib/assetClass.ts';
import type { HoldingsScope } from '../lib/holdingsScope.ts';
import { isUrgent, timeLeft } from '../lib/proposalCountdown.ts';
import { formatExactTime } from '../lib/relativeTime.ts';
import { MIRROR_IN_RTL } from '../lib/textDirection.ts';
import { Card, Delta } from './ui.tsx';

/**
 * The consolidated holdings view (multi-agent Stage 3, PR 6; spec §4.3,
 * D32-D35). Real and simulated are shown side by side and never added into
 * one figure: a total that silently mixed real shares with paper ones would
 * tell the reader something false. Simulated holdings are read-only here; an
 * agent's shares change only by a trade, on its own page (D35).
 */

/** The `All / Real only / <agent>` choice. Shown only when there is a simulated agent to choose. */
export function HoldingsScopePicker({
  scope,
  agents,
  onChange,
}: {
  scope: HoldingsScope;
  agents: AgentView[];
  onChange: (scope: HoldingsScope) => void;
}) {
  const { t } = useTranslation();
  const value = scope.kind === 'agent' ? scope.agentId : scope.kind;
  return (
    <label className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-text-muted">{t('consolidated.showing')}</span>
      <select
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next === 'real' ? { kind: 'real' } : next === 'all' ? { kind: 'all' } : { kind: 'agent', agentId: next });
        }}
        className="rounded-lg border border-border-subtle bg-surface px-3 py-1.5 text-sm"
      >
        <option value="real">{t('consolidated.scopes.real')}</option>
        <option value="all">{t('consolidated.scopes.all')}</option>
        {agents.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.state === 'paused'
              ? t('consolidated.scopes.agentPaused', { name: agent.name })
              : t('consolidated.scopes.agent', { name: agent.name })}
          </option>
        ))}
      </select>
    </label>
  );
}

function Figure({ label, children, hint }: { label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="text-lg font-semibold">{children}</dd>
      {hint && <dd className="text-xs text-text-muted">{hint}</dd>}
    </div>
  );
}

/**
 * The headline under `All` (D34): the real portfolio's value and every agent's
 * net worth together, as two figures. Each keeps its own rule for a missing
 * price - the real one is partial and says so, as the dashboard always has; the
 * simulated one is not shown at all (decision 111) and names what is unpriced.
 */
export function ConsolidatedHeadline({ data }: { data: ConsolidatedHoldingsResponse }) {
  const { t } = useTranslation();
  const money = (minor: number | null) => <bdi>{formatMoney(minor, data.currency)}</bdi>;
  const { real, simulated } = data;
  return (
    <Card>
      <dl className="grid gap-4 sm:grid-cols-2">
        <Figure
          label={t('consolidated.realValue')}
          hint={
            real.unpricedSymbols.length > 0
              ? t('consolidated.realPartial', { symbols: real.unpricedSymbols.join(t('common.listSeparator')) })
              : t('consolidated.realHint', { count: real.holdingsCount })
          }
        >
          {money(real.totalValueMinor)}
        </Figure>
        <Figure
          label={t('consolidated.simulatedNetWorth')}
          hint={
            simulated.netWorthMinor === null ? (
              <span className="text-loss">
                {t('consolidated.simulatedUnpriced', {
                  symbols: simulated.unpricedSymbols.join(t('common.listSeparator')),
                })}
              </span>
            ) : (
              t('consolidated.simulatedHint', {
                count: simulated.agentCount,
                cash: formatMoney(simulated.cashMinor, data.currency),
              })
            )
          }
        >
          {money(simulated.netWorthMinor)}
        </Figure>
      </dl>
      <p className="mt-3 text-xs text-text-muted">
        {t('consolidated.neverSummed')} {t('consolidated.belowIsReal')}
      </p>
    </Card>
  );
}

/** One agent's standing, as its own page shows it (D6). */
export function AgentHeadline({ standing }: { standing: SimulatedAgentStanding }) {
  const { t } = useTranslation();
  const money = (minor: number | null) => <bdi>{formatMoney(minor, standing.currency)}</bdi>;
  return (
    <Card>
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Figure label={t('agents.account.cash')}>{money(standing.cashMinor)}</Figure>
        <Figure label={t('agents.account.holdingsValue')}>{money(standing.holdingsValueMinor)}</Figure>
        <Figure label={t('agents.account.netWorth')}>{money(standing.netWorthMinor)}</Figure>
        <Figure label={t('agents.account.pnl')}>
          <Delta value={standing.pnlMinor}>
            {money(standing.pnlMinor)} <bdi>{formatPercent(standing.pnlPct)}</bdi>
          </Delta>
        </Figure>
      </dl>
      {standing.unpricedSymbols.length > 0 && (
        <p className="mt-3 text-xs text-loss">
          {t('agents.account.unpriced', { symbols: standing.unpricedSymbols.join(', ') })}
        </p>
      )}
      {/* The chart, allocation and findings below stay the real portfolio's (D32). */}
      <p className="mt-3 text-xs text-text-muted">{t('consolidated.belowIsReal')}</p>
    </Card>
  );
}

function quantityText(quantity: string): string {
  return formatNumber(Number(quantity), { maximumFractionDigits: 8 });
}

/** Where a position is managed: the real holding's page, or the agent's. */
function PositionLink({ position, children }: { position: ConsolidatedPosition; children: React.ReactNode }) {
  return position.isPrimary ? (
    <Link to="/holdings/$holdingId" params={{ holdingId: position.holdingId }} className="hover:underline">
      {children}
    </Link>
  ) : (
    <Link to="/agents/$agentId" params={{ agentId: position.agentId }} className="hover:underline">
      {children}
    </Link>
  );
}

function PositionLine({ position, currency }: { position: ConsolidatedPosition; currency: string }) {
  const { t } = useTranslation();
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-xs">
      <span className="flex flex-wrap items-center gap-2">
        <PositionLink position={position}>
          <bdi className="font-medium text-text-primary">{agentName({ isPrimary: position.isPrimary, name: position.agentName })}</bdi>
        </PositionLink>
        <span
          className={
            position.isPrimary
              ? 'rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent'
              : 'rounded-full border border-border-subtle px-2 py-0.5 text-[10px] text-text-muted'
          }
        >
          {position.isPrimary ? t('agents.real') : t('agents.simulated')}
        </span>
        {position.state === 'paused' && (
          <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[10px] text-warn">{agentStateWord('paused')}</span>
        )}
      </span>
      <span className="text-text-muted">
        {t('consolidated.positionLine', {
          quantity: quantityText(position.quantity),
          value: formatMoney(position.valueMinor, currency),
        })}{' '}
        <Delta value={position.pnlMinor}>
          {position.pnlMinor === null
            ? ''
            : t('holdings.pnl', { money: formatMoney(position.pnlMinor, currency), percent: formatPercent(position.pnlPct) })}
        </Delta>
      </span>
    </li>
  );
}

/**
 * Pending trade proposals by ticker (D35, D63): what the agents want to do,
 * beside what they hold. A buy is often of something nobody holds yet; those
 * have no row to sit beside and are listed above the table instead.
 */
function pendingBySymbol(trades: ConsolidatedPendingTrade[]): Map<string, ConsolidatedPendingTrade[]> {
  const bySymbol = new Map<string, ConsolidatedPendingTrade[]>();
  for (const trade of trades) bySymbol.set(trade.symbol, [...(bySymbol.get(trade.symbol) ?? []), trade]);
  return bySymbol;
}

function PendingBadge({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent">
      {t('consolidated.pending.badge', { count })}
    </span>
  );
}

/** One proposal: whose, what, at the agent's price, and how long it stays answerable. */
function PendingTradeLine({ trade }: { trade: ConsolidatedPendingTrade }) {
  const { t } = useTranslation();
  const remaining = timeLeft(trade.expiresAt);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-xs">
      <span>
        {t('consolidated.pending.line', {
          agent: trade.agentName,
          side: t(`consolidated.pending.sides.${trade.side}`),
          quantity: quantityText(trade.quantity),
          symbol: trade.symbol,
          price: formatMoney(trade.agentPriceMinor, trade.currency),
        })}
      </span>
      <span className="flex items-center gap-2">
        <span className={isUrgent(trade.expiresAt) ? 'text-loss' : 'text-text-muted'} title={formatExactTime(trade.expiresAt)}>
          {remaining ?? t('countdown.expired')}
        </span>
        <Link to="/proposals/$proposalId" params={{ proposalId: trade.proposalId }} className="font-medium text-accent hover:underline">
          {t('consolidated.pending.open')}
        </Link>
      </span>
    </li>
  );
}

/** The trades on tickers the list below does not show; nothing when there are none. */
export function PendingTradesStrip({ trades }: { trades: ConsolidatedPendingTrade[] }) {
  const { t } = useTranslation();
  if (trades.length === 0) return null;
  return (
    <Card title={t('consolidated.pending.title', { count: trades.length })}>
      <p className="text-xs text-text-muted">{t('consolidated.pending.hint')}</p>
      <ul className="mt-2 divide-y divide-border-subtle/50">
        {trades.map((trade) => (
          <PendingTradeLine key={trade.proposalId} trade={trade} />
        ))}
      </ul>
    </Card>
  );
}

function Side({ label, side, currency }: { label: string; side: ConsolidatedRow['real']; currency: string }) {
  const { t } = useTranslation();
  return (
    <div className="min-w-28 text-end">
      <p className="text-[11px] uppercase tracking-wide text-text-muted">{label}</p>
      {side === null ? (
        <p className="text-text-muted">—</p>
      ) : (
        <>
          <p className="font-medium">
            <bdi>{side.valueMinor === null ? t('holdings.unpriced') : formatMoney(side.valueMinor, currency)}</bdi>
          </p>
          <p className="text-xs text-text-muted">{t('consolidated.shares', { quantity: quantityText(side.quantity) })}</p>
        </>
      )}
    </div>
  );
}

function ConsolidatedRowItem({
  row,
  currency,
  pending,
}: {
  row: ConsolidatedRow;
  currency: string;
  pending: ConsolidatedPendingTrade[];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center justify-between gap-3 text-start text-sm"
      >
        <span className="flex min-w-0 items-center gap-2">
          {open ? (
            <ChevronDown className="size-4 shrink-0 text-text-muted" aria-hidden />
          ) : (
            <ChevronRight className={`size-4 shrink-0 text-text-muted ${MIRROR_IN_RTL}`} aria-hidden />
          )}
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="font-medium text-accent">
                <bdi>{row.instrument.symbol}</bdi>
              </span>
              {pending.length > 0 && <PendingBadge count={pending.length} />}
            </span>
            <span className="block truncate text-xs text-text-muted">
              <bdi>{row.instrument.name ?? assetClassName(row.instrument.assetClass)}</bdi>
              {row.quote && (
                <>
                  {' · '}
                  <bdi>{formatMoney(row.quote.priceMinor, row.quote.currency)}</bdi>{' '}
                  <Delta value={row.quote.dayChangePct}>{formatPercent(row.quote.dayChangePct)}</Delta>
                </>
              )}
            </span>
          </span>
        </span>
        <span className="flex gap-4">
          <Side label={t('agents.real')} side={row.real} currency={currency} />
          <Side label={t('agents.simulated')} side={row.simulated} currency={currency} />
        </span>
      </button>
      {open && (
        <ul className="ms-6 mt-2 divide-y divide-border-subtle/50 border-s border-border-subtle ps-3">
          {row.positions.map((position) => (
            <PositionLine key={`${position.agentId}-${position.holdingId}`} position={position} currency={currency} />
          ))}
          {pending.map((trade) => (
            <PendingTradeLine key={trade.proposalId} trade={trade} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** One row per instrument, expanding to the agents that hold it (§4.3). */
export function ConsolidatedHoldings({ data }: { data: ConsolidatedHoldingsResponse }) {
  const { t } = useTranslation();
  const pending = pendingBySymbol(data.pendingTrades);
  const held = new Set(data.rows.map((row) => row.instrument.symbol));
  return (
    <>
      <PendingTradesStrip trades={data.pendingTrades.filter((trade) => !held.has(trade.symbol))} />
      <Card title={t('consolidated.title', { count: data.rows.length })}>
        {data.rows.length === 0 ? (
          <p className="text-sm text-text-muted">{t('consolidated.empty')}</p>
        ) : (
          <ul className="divide-y divide-border-subtle/60">
            {data.rows.map((row) => (
              <ConsolidatedRowItem
                key={row.instrument.id}
                row={row}
                currency={data.currency}
                pending={pending.get(row.instrument.symbol) ?? []}
              />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

/** One simulated agent's holdings, read-only; trading happens on its page (D35). */
export function AgentScopeHoldings({
  data,
  standing,
}: {
  data: ConsolidatedHoldingsResponse;
  standing: SimulatedAgentStanding;
}) {
  const { t } = useTranslation();
  const positions = data.rows.flatMap((row) =>
    row.positions
      .filter((position) => position.agentId === standing.agentId)
      .map((position) => ({ row, position })),
  );
  const trades = data.pendingTrades.filter((trade) => trade.agentId === standing.agentId);
  const pending = pendingBySymbol(trades);
  const held = new Set(positions.map(({ row }) => row.instrument.symbol));
  return (
    <>
    <PendingTradesStrip trades={trades.filter((trade) => !held.has(trade.symbol))} />
    <Card
      title={t('consolidated.agentTitle', { name: standing.name, count: positions.length })}
      action={
        <Link to="/agents/$agentId" params={{ agentId: standing.agentId }} className="text-xs text-accent hover:underline">
          {t('consolidated.openAgent')}
        </Link>
      }
    >
      {positions.length === 0 ? (
        <p className="text-sm text-text-muted">{t('agents.holdingsEmpty.body')}</p>
      ) : (
        <ul className="divide-y divide-border-subtle/60">
          {positions.map(({ row, position }) => (
            <li key={position.holdingId} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
              <span>
                <span className="flex items-center gap-2">
                  <span className="font-medium">
                    <bdi>{row.instrument.symbol}</bdi>
                  </span>
                  {pending.has(row.instrument.symbol) && (
                    <PendingBadge count={pending.get(row.instrument.symbol)!.length} />
                  )}
                </span>
                <span className="block text-xs text-text-muted">
                  {t('agents.holdings.line', {
                    quantity: quantityText(position.quantity),
                    cost: formatMoney(position.costBasisMinor, position.costCurrency),
                  })}
                </span>
              </span>
              <span className="text-end">
                <span className="block">
                  <bdi>{position.valueMinor === null ? t('holdings.unpriced') : formatMoney(position.valueMinor, data.currency)}</bdi>
                </span>
                <span className="block text-xs">
                  <Delta value={position.pnlMinor}>
                    {position.pnlMinor === null
                      ? ''
                      : t('holdings.pnl', {
                          money: formatMoney(position.pnlMinor, data.currency),
                          percent: formatPercent(position.pnlPct),
                        })}
                  </Delta>
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
    </>
  );
}
