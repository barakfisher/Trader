import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Check, Clock, Pencil, Trash2 } from 'lucide-react';

import type {
  ConsolidatedHoldingsResponse,
  ConsolidatedPendingTrade,
  ConsolidatedPosition,
  HoldingView,
  ResearchHolding,
} from '@traders/shared';

import { errorMessage } from '../api/client.ts';
import { formatMoney, formatPercent, formatShare } from '../i18n/format.ts';
import { useTranslation } from '../i18n/index.ts';
import { agentName, agentStateWord } from '../lib/agentPresentation.ts';
import { assetClassName } from '../lib/assetClass.ts';
import { combinedHoldings, type CombinedHolding } from '../lib/combinedHoldings.ts';
import type { HoldingsScope } from '../lib/holdingsScope.ts';
import { isUrgent, timeLeft } from '../lib/proposalCountdown.ts';
import { formatAge, formatExactTime } from '../lib/relativeTime.ts';
import { useNarrowViewport } from '../lib/viewport.ts';
import { usePortfolioQuery, useRemoveHolding, useUpdateHolding } from '../queries/portfolio.ts';
import {
  CostWarning,
  trimQuantity,
  useHoldingEditor,
  type RemoveHolding,
  type UpdateHolding,
} from './HoldingsTable.tsx';
import { sentimentRank, sortHoldings, type SortFields, type SortKey } from '../lib/holdingsSort.ts';
import { ApproveProposalButton } from './ProposalApproval.tsx';
import { SortControl, SortableTh, useSortColumns, type SortProps } from './SortableHeader.tsx';
import { SentimentCell, useSentiments } from './SentimentBadge.tsx';
import { Card, Delta } from './ui.tsx';

/**
 * The dashboard's one holdings table under *All*, *Simulated* and a single
 * agent (D229): the real table's columns - price, quantity, value, weight,
 * cost, P&L, actions - plus who holds each row.
 *
 * A row adds its holders' positions together, and never hides whose they are:
 * the *Holders* column badges each one, and the quantity and the value open
 * the split by holder - on hover, on focus, or on a tap. The real holding keeps
 * its edit and remove; a simulated position changes only by a trade, on its
 * agent's page (D35). An agent's pending trade on the ticker is approved from
 * the row, through the proposal's own card (D232).
 */
export function CombinedHoldingsTable({
  data,
  scope,
  actions,
  sort = null,
  onSort = () => {},
}: {
  data: ConsolidatedHoldingsResponse;
  scope: HoldingsScope;
  actions?: ReactNode;
} & Partial<SortProps>) {
  const { t } = useTranslation();
  const sentiments = useSentiments();
  const combined = combinedHoldings(data, scope);
  const rows = sortHoldings(
    combined.rows,
    (row) => combinedSortFields(row, sentiments.byInstrument.get(row.instrument.id)),
    sort,
  );
  const unheldPending = combined.unheldPending;
  const columns = useSortColumns(sentiments.shown);
  const header = (key: SortKey) => {
    const column = columns.find((candidate) => candidate.key === key)!;
    return (
      <SortableTh
        key={key}
        column={key}
        label={column.label}
        end={key !== 'symbol' && key !== 'sentiment'}
        sort={sort}
        onSort={onSort}
      />
    );
  };
  const realHoldings = new Map((usePortfolioQuery().data?.holdings ?? []).map((holding) => [holding.id, holding]));
  const updateHolding = useUpdateHolding();
  const removeHolding = useRemoveHolding();
  const narrow = useNarrowViewport();
  const failure =
    (updateHolding.error && errorMessage(updateHolding.error, t('holdings.updateFailed'))) ||
    (removeHolding.error && errorMessage(removeHolding.error, t('holdings.removeFailed')));
  const realOf = (row: CombinedHolding) => {
    const position = row.positions.find((entry) => entry.isPrimary);
    return position ? (realHoldings.get(position.holdingId) ?? null) : null;
  };
  const shared = { currency: data.currency, updateHolding, removeHolding };

  return (
    <Card title={t('holdings.title', { count: rows.length })} action={actions} className="overflow-hidden">
      {rows.length === 0 ? (
        <p className="text-sm text-text-muted">{t('consolidated.empty')}</p>
      ) : narrow ? (
        <>
        <SortControl sort={sort} onSort={onSort} columns={columns} />
        <ul className="divide-y divide-border-subtle/60">
          {rows.map((row) => (
            <li key={row.instrument.id} className="py-3 first:pt-0 last:pb-0">
              <CombinedCard row={row} real={realOf(row)} {...shared} />
            </li>
          ))}
        </ul>
        </>
      ) : (
        <div className="-mx-4 overflow-x-auto px-4">
          <table className="w-full min-w-[1080px] text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-start text-xs uppercase tracking-wide text-text-muted">
                {header('symbol')}
                <th className="pb-2 pe-3 font-medium">{t('combined.holders')}</th>
                {(['quantity', 'price', 'day', 'value', 'cost', 'pnl', 'pnlPct', 'weight'] as const).map(header)}
                {sentiments.shown && header('sentiment')}
                <th className="pb-2 text-end font-medium">{t('holdings.columns.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <CombinedRow key={row.instrument.id} row={row} real={realOf(row)} {...shared} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {failure && <p className="mt-3 text-xs text-loss">{failure}</p>}
      <UnheldTrades trades={unheldPending} />
    </Card>
  );
}

/** A combined row's figures as the table sorts by them (M10 decision 21), with its latest rating's. */
export function combinedSortFields(row: CombinedHolding, research?: ResearchHolding): SortFields {
  return {
    symbol: row.instrument.symbol,
    quantity: row.quantity,
    price: row.quote ? { minor: row.quote.priceMinor, currency: row.quote.currency } : null,
    day: row.quote?.dayChangePct ?? null,
    value: row.valueMinor,
    cost: row.costMinor,
    pnl: row.pnlMinor,
    pnlPct: row.pnlPct,
    weight: row.weightPct,
    sentiment: sentimentRank(research?.latest?.rating),
  };
}

interface RowProps {
  row: CombinedHolding;
  /** The real portfolio's holding in this row, when it has one: the part that can be edited. */
  real: HoldingView | null;
  currency: string;
  updateHolding: UpdateHolding;
  removeHolding: RemoveHolding;
}

function CombinedRow({ row, real, currency, updateHolding, removeHolding }: RowProps) {
  const { t } = useTranslation();
  const sentiments = useSentiments();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const symbol = row.instrument.symbol;

  return (
    <>
      <tr className="border-b border-border-subtle/50 align-top last:border-0 hover:bg-surface-hover/40">
        <td className="py-2 pe-3">
          <SymbolCell row={row} real={real} />
        </td>
        <td className="py-2 pe-3">
          <Holders positions={row.positions} />
        </td>
        <td className="py-2 pe-3 text-end">
          <PositionsBreakdown row={row} currency={currency}>
            {trimQuantity(row.quantity)}
          </PositionsBreakdown>
        </td>
        <td className="py-2 pe-3 text-end">
          {row.quote ? (
            <>
              <div>{formatMoney(row.quote.priceMinor, row.quote.currency)}</div>
              <div className="text-[11px] text-text-muted" title={formatExactTime(row.quote.asOf)}>
                {formatAge(row.quote.asOf)}
              </div>
            </>
          ) : (
            '—'
          )}
        </td>
        <td className="py-2 pe-3 text-end">
          <Delta value={row.quote?.dayChangePct ?? null}>{formatPercent(row.quote?.dayChangePct ?? null)}</Delta>
        </td>
        <td className="py-2 pe-3 text-end">
          <PositionsBreakdown row={row} currency={currency}>
            {row.valueMinor === null ? t('holdings.unpriced') : formatMoney(row.valueMinor, currency)}
          </PositionsBreakdown>
        </td>
        <td className="py-2 pe-3 text-end text-text-muted">
          <CostCell row={row} currency={currency} onSet={real?.costBasisMinor === null ? () => setEditing(true) : undefined} />
        </td>
        <td className="py-2 pe-3 text-end">
          <Delta value={row.pnlMinor}>{row.pnlMinor === null ? '—' : formatMoney(row.pnlMinor, currency)}</Delta>
        </td>
        <td className="py-2 pe-3 text-end">
          <Delta value={row.pnlPct}>{row.pnlPct === null ? '—' : formatPercent(row.pnlPct)}</Delta>
        </td>
        <td className="py-2 pe-3 text-end text-text-muted">{formatShare(row.weightPct)}</td>
        {sentiments.shown && (
          <td className="py-2 pe-3">
            <SentimentCell holding={sentiments.byInstrument.get(row.instrument.id)} />
          </td>
        )}
        <td className="py-2 text-end">
          <span className="flex flex-wrap items-center justify-end gap-2">
            {row.pending.map((trade) => (
              <ApproveProposalButton key={trade.proposalId} trade={trade} />
            ))}
            {real &&
              (confirmingDelete ? (
                <span className="flex items-center gap-2 text-xs">
                  <button type="button" onClick={() => removeHolding.mutate(real.id)} className="text-loss underline">
                    {t('common.remove')}
                  </button>
                  <button type="button" onClick={() => setConfirmingDelete(false)} className="text-text-muted">
                    {t('common.cancel')}
                  </button>
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    aria-label={t('combined.editReal', { symbol })}
                    className="text-text-muted hover:text-text-primary"
                  >
                    <Pencil className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(true)}
                    aria-label={t('combined.removeReal', { symbol })}
                    className="text-text-muted hover:text-loss"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </>
              ))}
          </span>
        </td>
      </tr>
      {editing && real && (
        <tr className="border-b border-border-subtle/50">
          <td colSpan={12} className="pb-3">
            <RealHoldingEditor holding={real} updateHolding={updateHolding} onDone={() => setEditing(false)} />
          </td>
        </tr>
      )}
    </>
  );
}

/** One instrument on a phone: what it is worth and how it has done, who holds it, then what can be done. */
function CombinedCard({ row, real, currency, updateHolding, removeHolding }: RowProps) {
  const { t } = useTranslation();
  const sentiments = useSentiments();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const symbol = row.instrument.symbol;
  const button = 'flex h-10 items-center gap-1.5 rounded-lg border border-border-subtle px-3 text-xs text-text-muted';

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <SymbolCell row={row} real={real} />
        </div>
        <div className="shrink-0 text-end">
          <p className="text-sm font-semibold">
            {row.valueMinor === null ? t('holdings.unpriced') : formatMoney(row.valueMinor, currency)}
          </p>
          <p className="text-xs">
            <PnlText row={row} currency={currency} />
          </p>
        </div>
      </div>
      <Holders positions={row.positions} />
      {sentiments.shown && <SentimentCell holding={sentiments.byInstrument.get(row.instrument.id)} />}
      <p className="text-xs text-text-muted">
        {trimQuantity(row.quantity)} ×{' '}
        {row.quote ? formatMoney(row.quote.priceMinor, row.quote.currency) : t('holdings.noPrice')}
        {row.weightPct !== null && t('holdings.ofPortfolio', { share: formatShare(row.weightPct) })}
      </p>
      {row.positions.length > 1 && <BreakdownList row={row} currency={currency} />}
      {row.uncosted && <CostWarning symbol={symbol} onSet={real?.costBasisMinor === null ? () => setEditing(true) : undefined} />}
      {editing && real ? (
        <RealHoldingEditor holding={real} updateHolding={updateHolding} onDone={() => setEditing(false)} />
      ) : confirmingDelete && real ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-text-muted">{t('holdings.removeConfirm', { symbol })}</span>
          <button type="button" onClick={() => removeHolding.mutate(real.id)} className={`${button} border-loss/40 text-loss`}>
            {t('common.remove')}
          </button>
          <button type="button" onClick={() => setConfirmingDelete(false)} className={button}>
            {t('common.cancel')}
          </button>
        </div>
      ) : (
        (real || row.pending.length > 0) && (
          <div className="flex flex-wrap gap-2">
            {row.pending.map((trade) => (
              <ApproveProposalButton key={trade.proposalId} trade={trade} />
            ))}
            {real && (
              <>
                <button type="button" onClick={() => setEditing(true)} aria-label={t('combined.editReal', { symbol })} className={button}>
                  <Pencil className="size-4" aria-hidden /> {t('common.edit')}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  aria-label={t('combined.removeReal', { symbol })}
                  className={button}
                >
                  <Trash2 className="size-4" aria-hidden /> {t('common.remove')}
                </button>
              </>
            )}
          </div>
        )
      )}
    </div>
  );
}

/** The symbol, linked to the real holding's page when there is one, with its warnings and pending count. */
function SymbolCell({ row, real }: { row: CombinedHolding; real: HoldingView | null }) {
  const { t } = useTranslation();
  const symbol = <bdi>{row.instrument.symbol}</bdi>;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {real ? (
          <Link to="/holdings/$holdingId" params={{ holdingId: real.id }} className="font-medium text-accent hover:underline">
            {symbol}
          </Link>
        ) : (
          <span className="font-medium">{symbol}</span>
        )}
        {row.quote?.stale && (
          <span
            title={t('holdings.staleTitle', { when: formatExactTime(row.quote.asOf) })}
            className="flex items-center gap-1 rounded bg-warn/15 px-1.5 py-0.5 text-[10px] text-warn"
          >
            <Clock className="size-3" aria-hidden /> {t('holdings.stale')}
          </span>
        )}
        {row.pending.length > 0 && (
          <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent">
            {t('consolidated.pending.badge', { count: row.pending.length })}
          </span>
        )}
      </div>
      <p className="truncate text-xs text-text-muted">
        <bdi>{row.instrument.name ?? assetClassName(row.instrument.assetClass)}</bdi>
      </p>
    </>
  );
}

/** Who holds the row: *Real*, or each agent by name, linked to where its position is managed. */
function Holders({ positions }: { positions: ConsolidatedPosition[] }) {
  const { t } = useTranslation();
  return (
    <ul className="flex flex-wrap gap-1" aria-label={t('combined.holders')}>
      {positions.map((position) => (
        <li key={`${position.agentId}-${position.holdingId}`}>
          {position.isPrimary ? (
            <Link
              to="/holdings/$holdingId"
              params={{ holdingId: position.holdingId }}
              className="inline-block rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent hover:underline"
            >
              {t('agents.real')}
            </Link>
          ) : (
            <Link
              to="/agents/$agentId"
              params={{ agentId: position.agentId }}
              title={t('agents.simulated')}
              className="inline-flex items-center gap-1 rounded-full border border-border-subtle px-2 py-0.5 text-[11px] text-text-muted hover:text-text-primary hover:underline"
            >
              <bdi>{position.agentName}</bdi>
              {position.state === 'paused' && <span className="text-warn">· {agentStateWord('paused')}</span>}
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}

function CostCell({ row, currency, onSet }: { row: CombinedHolding; currency: string; onSet?: () => void }) {
  return (
    <span className="inline-flex flex-col items-end gap-1">
      {row.costMinor !== null && <span>{formatMoney(row.costMinor, currency)}</span>}
      {row.uncosted && <CostWarning symbol={row.instrument.symbol} onSet={onSet} />}
      {row.costMinor === null && !row.uncosted && '—'}
    </span>
  );
}

function PnlText({ row, currency }: { row: CombinedHolding; currency: string }) {
  const { t } = useTranslation();
  return (
    <Delta value={row.pnlMinor}>
      {row.pnlMinor === null
        ? '—'
        : t('holdings.pnl', { money: formatMoney(row.pnlMinor, currency), percent: formatPercent(row.pnlPct) })}
    </Delta>
  );
}

/** Each holder's value and quantity, then the row's total. */
function BreakdownList({ row, currency }: { row: CombinedHolding; currency: string }) {
  const { t } = useTranslation();
  const value = (minor: number | null) => (minor === null ? t('holdings.unpriced') : formatMoney(minor, currency));
  return (
    <ul className="space-y-1 text-xs">
      {row.positions.map((position) => (
        <li key={`${position.agentId}-${position.holdingId}`} className="flex justify-between gap-3">
          <span className="text-text-muted">
            {position.isPrimary
              ? t('combined.breakdown.real')
              : t('combined.breakdown.agent', { name: agentName({ isPrimary: false, name: position.agentName }) })}
          </span>
          <span className="tabular-nums">
            {t('combined.breakdown.line', { value: value(position.valueMinor), quantity: trimQuantity(position.quantity) })}
          </span>
        </li>
      ))}
      <li className="flex justify-between gap-3 border-t border-border-subtle pt-1 font-medium">
        <span>{t('combined.breakdown.combined')}</span>
        <span className="tabular-nums">
          {t('combined.breakdown.line', { value: value(row.valueMinor), quantity: trimQuantity(row.quantity) })}
        </span>
      </li>
    </ul>
  );
}

/**
 * A figure that opens the row's split by holder: on hover with a pointer, and
 * on a click, a tap or Enter - a phone has no hover. Escape, a tap elsewhere or
 * a scroll closes it. The panel
 * is fixed to the viewport, so the table's horizontal scroll cannot clip it.
 */
function PositionsBreakdown({ row, currency, children }: { row: CombinedHolding; currency: string; children: ReactNode }) {
  const { t } = useTranslation();
  const wrapper = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const PANEL_WIDTH = 288;

  const show = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.min(Math.max(rect.right - PANEL_WIDTH, 8), window.innerWidth - PANEL_WIDTH - 8);
    setAt({ top: rect.bottom + 4, left });
  };
  const hide = () => setAt(null);

  useEffect(() => {
    if (at === null) return;
    const close = () => setAt(null);
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && close();
    // A tap elsewhere closes it: a phone has no pointer to move away.
    const onPointer = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) close();
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [at]);

  return (
    <span ref={wrapper} className="relative inline-block" onMouseEnter={show} onMouseLeave={hide}>
      <button
        ref={trigger}
        type="button"
        onClick={show}
        aria-expanded={at !== null}
        aria-label={t('combined.breakdown.for', { symbol: row.instrument.symbol })}
        className="cursor-help border-b border-dotted border-text-muted/60 tabular-nums"
      >
        {children}
      </button>
      {at !== null && (
        <span
          role="tooltip"
          style={{ position: 'fixed', top: at.top, left: at.left, width: PANEL_WIDTH }}
          className="z-30 block rounded-lg border border-border-subtle bg-surface-raised p-3 text-start shadow-xl"
        >
          <BreakdownList row={row} currency={currency} />
        </span>
      )}
    </span>
  );
}

/** The real holding's quantity and cost per unit, edited in place under its row. */
function RealHoldingEditor({
  holding,
  updateHolding,
  onDone,
}: {
  holding: HoldingView;
  updateHolding: UpdateHolding;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { draft, setDraft, costDraft, setCostDraft, save } = useHoldingEditor(holding, updateHolding, onDone);
  const symbol = holding.instrument.symbol;
  const field = 'mt-1 block h-9 w-32 rounded-lg border border-border-subtle bg-surface px-3 text-end text-sm text-text-primary';
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg bg-surface-hover/40 p-3">
      <p className="w-full text-xs font-medium text-text-muted">{t('combined.editingReal', { symbol })}</p>
      <label className="text-xs text-text-muted">
        {t('holdings.columns.quantity')}
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className={field}
          inputMode="decimal"
          aria-label={t('holdings.quantityFor', { symbol })}
        />
      </label>
      <label className="text-xs text-text-muted">
        {t('holdings.costPerUnitIn', { currency: holding.costCurrency })}
        <input
          value={costDraft}
          onChange={(event) => setCostDraft(event.target.value)}
          className={field}
          inputMode="decimal"
          placeholder={t('common.none')}
          aria-label={t('holdings.costFor', { symbol, currency: holding.costCurrency })}
        />
      </label>
      <button
        type="button"
        onClick={save}
        className="flex h-9 items-center gap-1.5 rounded-lg border border-border-subtle px-3 text-xs text-gain"
      >
        <Check className="size-4" aria-hidden /> {t('common.save')}
      </button>
      <button
        type="button"
        onClick={onDone}
        className="flex h-9 items-center rounded-lg border border-border-subtle px-3 text-xs text-text-muted"
      >
        {t('common.cancel')}
      </button>
    </div>
  );
}

/** An agent's trades on tickers the table does not show - most often a buy of something new. */
function UnheldTrades({ trades }: { trades: ConsolidatedPendingTrade[] }) {
  const { t } = useTranslation();
  if (trades.length === 0) return null;
  return (
    <section className="mt-4 border-t border-border-subtle pt-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
        {t('consolidated.pending.title', { count: trades.length })}
      </h3>
      <p className="mt-1 text-xs text-text-muted">{t('consolidated.pending.hint')}</p>
      <ul className="mt-2 divide-y divide-border-subtle/50">
        {trades.map((trade) => (
          <li key={trade.proposalId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
            <span>
              {t('consolidated.pending.line', {
                agent: trade.agentName,
                side: t(`consolidated.pending.sides.${trade.side}`),
                quantity: trimQuantity(trade.quantity),
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
            <ApproveProposalButton trade={trade} />
          </li>
        ))}
      </ul>
    </section>
  );
}
