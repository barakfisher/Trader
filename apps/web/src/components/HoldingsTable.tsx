import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, Check, Clock, X } from 'lucide-react';

import { minorToDecimalString, minorToNumber, type HoldingView, type ResearchHolding } from '@traders/shared';

import { errorMessage } from '../api/client.ts';
import { formatMoney, formatPercent, formatShare } from '../i18n/format.ts';
import { Trans, useTranslation } from '../i18n/index.ts';
import { assetClassName } from '../lib/assetClass.ts';
import { formatAge, formatExactTime } from '../lib/relativeTime.ts';
import { baseCurrencyOf } from '../lib/portfolioView.ts';
import { useNarrowViewport } from '../lib/viewport.ts';
import { usePortfolioQuery, useRemoveHolding, useUpdateHolding } from '../queries/portfolio.ts';
import { HoldingRowMenu } from './HoldingRowMenu.tsx';
import { sentimentRank, sortHoldings, type SortFields } from '../lib/holdingsSort.ts';
import { SortControl, SortableTh, useSortColumns, type SortProps } from './SortableHeader.tsx';
import { CardDetail, ExpandMark, ExpandingCard } from './ExpandingCard.tsx';
import { DayChange } from './DayChange.tsx';
import { InstrumentName } from './InstrumentName.tsx';
import { SentimentCell, useSentiments } from './SentimentBadge.tsx';
import { Card, Delta, buttonClass } from './ui.tsx';

export type UpdateHolding = ReturnType<typeof useUpdateHolding>;
export type RemoveHolding = ReturnType<typeof useRemoveHolding>;

/** A real holding's figures as the table sorts by them (M10 decision 21), with its latest rating's. */
export function holdingSortFields(holding: HoldingView, research?: ResearchHolding): SortFields {
  return {
    symbol: holding.instrument.symbol,
    quantity: holding.quantity,
    price: holding.quote ? { minor: holding.quote.priceMinor, currency: holding.quote.currency } : null,
    day: holding.quote?.dayChangePct ?? null,
    value: holding.valueMinor,
    cost: holding.costBasisMinor === null ? null : holding.costMinor,
    pnl: holding.pnlMinor,
    pnlPct: holding.pnlPct,
    weight: holding.weightPct,
    sentiment: sentimentRank(research?.latest?.rating),
  };
}

/**
 * `actions`: the card's own controls - Add holding, Targets, the "⋯" menu (UX5).
 * `sort`: the order the address asks for (M10 decision 21); null is the server's.
 */
export function HoldingsTable({
  actions,
  sort = null,
  onSort = () => {},
}: { actions?: ReactNode } & Partial<SortProps> = {}) {
  const { data: portfolio } = usePortfolioQuery();
  const { t } = useTranslation();
  // Owned by the table, not each row, so a failure is reported once, under the
  // table, whichever row caused it - as it was before.
  const updateHolding = useUpdateHolding();
  const removeHolding = useRemoveHolding();
  const sentiments = useSentiments();
  const holdings = sortHoldings(
    portfolio?.holdings ?? [],
    (holding) => holdingSortFields(holding, sentiments.byInstrument.get(holding.instrument.id)),
    sort,
  );
  const columns = useSortColumns(sentiments.shown);
  const currency = baseCurrencyOf(portfolio);
  const failure =
    (updateHolding.error && errorMessage(updateHolding.error, t('holdings.updateFailed'))) ||
    (removeHolding.error && errorMessage(removeHolding.error, t('holdings.removeFailed')));

  // Below `sm` the table became an 880 px strip inside a 341 px box, showing
  // the symbol, the quantity and half a price: a phone gets one card per holding.
  const narrow = useNarrowViewport();
  // One open at a time, so a long list stays a list.
  const [openCard, setOpenCard] = useState<string | null>(null);

  if (holdings.length === 0) return null;

  if (narrow) {
    return (
      <Card title={t('holdings.title', { count: holdings.length })} action={actions}>
        <SortControl sort={sort} onSort={onSort} columns={columns} />
        <ul className="divide-y divide-border-subtle/60">
          {holdings.map((holding) => (
            <li key={holding.id} className="py-3 first:pt-0 last:pb-0">
              <HoldingCard
                holding={holding}
                baseCurrency={currency}
                updateHolding={updateHolding}
                removeHolding={removeHolding}
                open={openCard === holding.id}
                onToggle={() => setOpenCard(openCard === holding.id ? null : holding.id)}
              />
            </li>
          ))}
        </ul>
        {failure && <p className="mt-3 text-xs text-loss">{failure}</p>}
      </Card>
    );
  }

  return (
    <Card title={t('holdings.title', { count: holdings.length })} action={actions} className="overflow-hidden">
      <div className="-mx-4 overflow-x-auto px-4">
        <table className="w-full min-w-[960px] text-sm">
          <thead>
            <tr className="border-b border-border-subtle text-start text-xs uppercase tracking-wide text-text-muted">
              {columns.map((column) => (
                <SortableTh
                  key={column.key}
                  column={column.key}
                  label={column.label}
                  end={column.key !== 'symbol' && column.key !== 'sentiment'}
                  sort={sort}
                  onSort={onSort}
                />
              ))}
              <th className="pb-2 text-end font-medium">{t('holdings.columns.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {holdings.map((holding) => (
              <HoldingRow
                key={holding.id}
                holding={holding}
                baseCurrency={currency}
                updateHolding={updateHolding}
                removeHolding={removeHolding}
              />
            ))}
          </tbody>
        </table>
      </div>
      {failure && <p className="mt-3 text-xs text-loss">{failure}</p>}
    </Card>
  );
}

/** The stored cost per unit as the edit field shows it: exact, at its currency's exponent. */
function costDraftOf(holding: HoldingView): string {
  return holding.costBasisMinor === null
    ? ''
    : minorToDecimalString(holding.costBasisMinor, holding.costCurrency);
}

/**
 * One holding's edit and remove state, shared by its table row and its card so
 * the two cannot disagree about what Save or Remove does.
 *
 * Cost is per unit, in the holding's own currency (guideline 3: totals are
 * computed at read time). It is sent only when it was changed, and always with
 * its currency, so an untouched cost is never rewritten and a typed one is
 * never read at another currency's exponent.
 */
export function useHoldingEditor(holding: HoldingView, updateHolding: UpdateHolding, onSaved?: () => void) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(holding.quantity);
  const [costDraft, setCostDraft] = useState(() => costDraftOf(holding));
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  return {
    editing,
    draft,
    setDraft,
    costDraft,
    setCostDraft,
    confirmingDelete,
    setConfirmingDelete,
    startEditing: () => {
      setDraft(holding.quantity);
      setCostDraft(costDraftOf(holding));
      setEditing(true);
    },
    cancel: () => {
      setDraft(holding.quantity);
      setCostDraft(costDraftOf(holding));
      setEditing(false);
    },
    save: () => {
      const cost = costDraft.trim();
      const costChanged = cost !== costDraftOf(holding);
      updateHolding.mutate(
        {
          holdingId: holding.id,
          quantity: draft,
          ...(costChanged ? { costBasis: cost === '' ? null : cost, currency: holding.costCurrency } : {}),
        },
        {
          onSuccess: () => {
            setEditing(false);
            onSaved?.();
          },
        },
      );
    },
  };
}

function HoldingRow({
  holding,
  baseCurrency,
  updateHolding,
  removeHolding,
}: {
  holding: HoldingView;
  baseCurrency: string;
  updateHolding: UpdateHolding;
  removeHolding: RemoveHolding;
}) {
  const {
    editing,
    draft,
    setDraft,
    costDraft,
    setCostDraft,
    confirmingDelete,
    setConfirmingDelete,
    startEditing,
    cancel,
    save,
  } = useHoldingEditor(holding, updateHolding);
  const { t } = useTranslation();
  const sentiments = useSentiments();

  return (
    <tr className="border-b border-border-subtle/50 last:border-0 hover:bg-surface-hover/40">
      <td className="py-2 pe-3">
        <SymbolLabel holding={holding} />
        <p className="text-xs text-text-muted">
          <bdi>{holding.instrument.name ?? assetClassName(holding.instrument.assetClass)}</bdi>
        </p>
      </td>

      <td className="py-2 pe-3 text-end">
        {editing ? (
          <div className="flex items-center justify-end gap-1">
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="w-24 rounded border border-border-subtle bg-surface px-2 py-1 text-end text-sm"
              inputMode="decimal"
              aria-label={t('holdings.quantityFor', { symbol: holding.instrument.symbol })}
            />
            <button type="button" onClick={save} aria-label={t('common.save')} className="text-gain">
              <Check className="size-4" />
            </button>
            <button
              type="button"
              onClick={cancel}
              aria-label={t('common.cancel')}
              className="text-text-muted"
            >
              <X className="size-4" />
            </button>
          </div>
        ) : (
          trimQuantity(holding.quantity)
        )}
      </td>

      <td className="py-2 pe-3 text-end">
        {holding.quote ? (
          <>
            <div>{formatMoney(holding.quote.priceMinor, holding.quote.currency)}</div>
            {/* The price is only as fresh as its observation window, and the
                provider's delay is on top of that. Showing both stops the table
                implying every figure is live. */}
            <div
              className="text-2xs text-text-muted"
              title={
                holding.quote.delaySeconds > 0
                  ? t('holdings.observedViaDelayed', {
                      when: formatExactTime(holding.quote.asOf),
                      source: holding.quote.source,
                      minutes: Math.round(holding.quote.delaySeconds / 60),
                    })
                  : t('holdings.observedVia', {
                      when: formatExactTime(holding.quote.asOf),
                      source: holding.quote.source,
                    })
              }
            >
              {formatAge(holding.quote.asOf)}
              {holding.quote.delaySeconds > 0 &&
                t('holdings.delay', { minutes: Math.round(holding.quote.delaySeconds / 60) })}
            </div>
          </>
        ) : (
          '—'
        )}
      </td>
      <td className="py-2 pe-3 text-end">
        <Delta value={holding.quote?.dayChangePct ?? null}>
          {formatPercent(holding.quote?.dayChangePct ?? null)}
        </Delta>
      </td>
      <td className="py-2 pe-3 text-end">{formatMoney(holding.valueMinor, baseCurrency)}</td>
      <td className="py-2 pe-3 text-end text-text-muted">
        {editing ? (
          <label className="flex items-center justify-end gap-1 text-xs">
            <input
              value={costDraft}
              onChange={(event) => setCostDraft(event.target.value)}
              className="w-24 rounded border border-border-subtle bg-surface px-2 py-1 text-end text-sm text-text-primary"
              inputMode="decimal"
              placeholder={t('common.none')}
              aria-label={t('holdings.costFor', {
                symbol: holding.instrument.symbol,
                currency: holding.costCurrency,
              })}
            />
            <span>{t('holdings.perUnit', { currency: holding.costCurrency })}</span>
          </label>
        ) : holding.costBasisMinor === null ? (
          <CostWarning symbol={holding.instrument.symbol} onSet={startEditing} />
        ) : (
          formatMoney(holding.costMinor, baseCurrency)
        )}
      </td>
      <td className="py-2 pe-3 text-end">
        <Delta value={holding.pnlMinor}>
          {holding.pnlMinor === null ? '—' : formatMoney(holding.pnlMinor, baseCurrency)}
        </Delta>
      </td>
      <td className="py-2 pe-3 text-end">
        <Delta value={holding.pnlPct}>{holding.pnlPct === null ? '—' : formatPercent(holding.pnlPct)}</Delta>
      </td>
      <td className="py-2 pe-3 text-end text-text-muted">
        {formatShare(holding.weightPct)}
      </td>
      {sentiments.shown && (
        <td className="py-2 pe-3">
          <SentimentCell holding={sentiments.byInstrument.get(holding.instrument.id)} />
        </td>
      )}

      <td className="py-2 text-end">
        {confirmingDelete ? (
          <span className="flex items-center justify-end gap-2 text-xs">
            <span className="max-w-56 text-start text-2xs text-text-muted">{t('holdings.removeNote')}</span>
            <button
              type="button"
              onClick={() => removeHolding.mutate(holding.id)}
              className="tap-compact text-loss underline"
            >
              {t('common.remove')}
            </button>
            <button type="button" onClick={() => setConfirmingDelete(false)} className="text-text-muted">
              {t('common.cancel')}
            </button>
          </span>
        ) : (
          <span className="flex items-center justify-end">
            <HoldingRowMenu
              symbol={holding.instrument.symbol}
              instrumentId={holding.instrument.id}
              onEdit={startEditing}
              onRemove={() => setConfirmingDelete(true)}
            />
          </span>
        )}
      </td>
    </tr>
  );
}

/** The symbol with its warnings: a stale price and an unpriced holding are said beside it. */
function SymbolLabel({
  holding,
  linked = true,
  children,
}: {
  holding: HoldingView;
  /** A phone's card opens where it is tapped, so its symbol is not a second, different target. */
  linked?: boolean;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2">
      {linked ? (
        <Link
          to="/holdings/$holdingId"
          params={{ holdingId: holding.id }}
          className="font-medium text-accent hover:underline"
        >
          {holding.instrument.symbol}
        </Link>
      ) : (
        <span className="font-medium text-accent">{holding.instrument.symbol}</span>
      )}
      {holding.quote?.stale && (
        <span
          title={t('holdings.staleTitle', { when: formatExactTime(holding.quote.asOf) })}
          className="flex items-center gap-1 rounded bg-warn/15 px-1.5 py-0.5 text-3xs text-warn"
        >
          <Clock className="size-3" aria-hidden /> {t('holdings.stale')}
        </span>
      )}
      {holding.valueMinor === null && (
        <span className="rounded bg-loss/15 px-1.5 py-0.5 text-3xs text-loss">{t('holdings.unpriced')}</span>
      )}
      {children}
    </div>
  );
}

/** What an open card adds: the figures the three lines leave out, and the way to the holding's page. */
function HoldingDetails({ holding, baseCurrency }: { holding: HoldingView; baseCurrency: string }) {
  const { t } = useTranslation();
  return (
    <>
      <dl className="space-y-1">
        <CardDetail label={t('holdings.columns.pnl')}>
          <Delta value={holding.pnlMinor}>
            {holding.pnlMinor === null || holding.pnlPct === null
              ? '—'
              : t('holdings.pnl', {
                  money: formatMoney(holding.pnlMinor, baseCurrency),
                  percent: formatPercent(holding.pnlPct),
                })}
          </Delta>
        </CardDetail>
        <CardDetail label={t('holdings.columns.cost')}>
          {holding.costMinor === null ? '—' : formatMoney(holding.costMinor, baseCurrency)}
          {holding.costBasisMinor !== null && (
            <span className="block text-text-muted">
              {t('holdings.details.perUnit', { money: formatMoney(holding.costBasisMinor, holding.costCurrency) })}
            </span>
          )}
        </CardDetail>
        <CardDetail label={t('holdings.details.priceUpdated')}>{formatAge(holding.quote?.asOf)}</CardDetail>
      </dl>
      <Link
        to="/holdings/$holdingId"
        params={{ holdingId: holding.id }}
        aria-label={t('holdings.details.openPageFor', { symbol: holding.instrument.symbol })}
        className={buttonClass('secondary', 'w-full text-center')}
      >
        {t('holdings.details.openPage')}
      </Link>
    </>
  );
}

/** A 44 px tap target: the table's 16 px icons are a desktop pointer's size, not a thumb's. */
const CARD_BUTTON = 'flex h-11 items-center gap-1.5 rounded-lg border border-border-subtle px-3 text-xs';

/**
 * One holding on a phone: three lines, because a portfolio is read as a list -
 * what it is and is worth, its name and how it moved today, then the figures
 * behind them and its "⋮". Stacking the rating and the menu on lines of their own made
 * each card 208 px, and 22 of them buried everything under the list. A price's
 * age is not repeated per card: the page says it, and a stale one is marked here.
 */
function HoldingCard({
  holding,
  baseCurrency,
  updateHolding,
  removeHolding,
  open,
  onToggle,
}: {
  holding: HoldingView;
  baseCurrency: string;
  updateHolding: UpdateHolding;
  removeHolding: RemoveHolding;
  open: boolean;
  onToggle: () => void;
}) {
  const {
    editing,
    draft,
    setDraft,
    costDraft,
    setCostDraft,
    confirmingDelete,
    setConfirmingDelete,
    startEditing,
    cancel,
    save,
  } = useHoldingEditor(holding, updateHolding);
  const symbol = holding.instrument.symbol;
  const { t } = useTranslation();
  const sentiments = useSentiments();

  return (
    <ExpandingCard
      label={t('holdings.details.toggle', { symbol })}
      open={open}
      locked={editing || confirmingDelete}
      onToggle={onToggle}
      details={<HoldingDetails holding={holding} baseCurrency={baseCurrency} />}
    >
    <div className="space-y-1.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <SymbolLabel holding={holding} linked={false}>
            {sentiments.shown && <SentimentCell inline holding={sentiments.byInstrument.get(holding.instrument.id)} />}
          </SymbolLabel>
          <InstrumentName>{holding.instrument.name ?? assetClassName(holding.instrument.assetClass)}</InstrumentName>
        </div>
        <div className="shrink-0 text-end">
          <p className="text-sm font-semibold">{formatMoney(holding.valueMinor, baseCurrency)}</p>
          <p className="text-xs">
            <DayChange pct={holding.quote?.dayChangePct} />
          </p>
        </div>
        {!editing && !confirmingDelete && (
          <div className="-ms-5 shrink-0">
            <HoldingRowMenu
              symbol={symbol}
              instrumentId={holding.instrument.id}
              onEdit={startEditing}
              onRemove={() => setConfirmingDelete(true)}
            />
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 text-xs text-text-muted">
          {trimQuantity(holding.quantity)} ×{' '}
          {holding.quote
            ? formatMoney(holding.quote.priceMinor, holding.quote.currency)
            : t('holdings.noPrice')}
          {holding.weightPct !== null &&
            t('holdings.ofPortfolio', { share: formatShare(holding.weightPct) })}
        </p>
        {!editing && !confirmingDelete && <ExpandMark open={open} className="me-1.5" />}
      </div>

      {!editing && holding.costBasisMinor === null && (
        <CostWarning symbol={holding.instrument.symbol} onSet={startEditing} />
      )}

      {editing ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-text-muted">
            {t('holdings.columns.quantity')}
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="mt-1 block h-10 w-32 rounded-lg border border-border-subtle bg-surface px-3 text-end text-sm text-text-primary"
              inputMode="decimal"
              aria-label={t('holdings.quantityFor', { symbol })}
            />
          </label>
          <label className="text-xs text-text-muted">
            {t('holdings.costPerUnitIn', { currency: holding.costCurrency })}
            <input
              value={costDraft}
              onChange={(event) => setCostDraft(event.target.value)}
              className="mt-1 block h-10 w-32 rounded-lg border border-border-subtle bg-surface px-3 text-end text-sm text-text-primary"
              inputMode="decimal"
              placeholder={t('common.none')}
              aria-label={t('holdings.costFor', { symbol, currency: holding.costCurrency })}
            />
          </label>
          <button type="button" onClick={save} className={`${CARD_BUTTON} text-gain`}>
            <Check className="size-4" aria-hidden /> {t('common.save')}
          </button>
          <button type="button" onClick={cancel} className={`${CARD_BUTTON} text-text-muted`}>
            {t('common.cancel')}
          </button>
        </div>
      ) : confirmingDelete ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-text-muted">{t('holdings.removeConfirm', { symbol })}</span>
          <span className="w-full text-2xs text-text-muted">{t('holdings.removeNote')}</span>
          <button
            type="button"
            onClick={() => removeHolding.mutate(holding.id)}
            className={`${CARD_BUTTON} border-loss/40 text-loss`}
          >
            {t('common.remove')}
          </button>
          <button
            type="button"
            onClick={() => setConfirmingDelete(false)}
            className={`${CARD_BUTTON} text-text-muted`}
          >
            {t('common.cancel')}
          </button>
        </div>
      ) : null}
    </div>
    </ExpandingCard>
  );
}

/**
 * A holding with no cost basis (D230): its P&L is "—" rather than its whole
 * value, and it is left out of the totals. This says so where the cost would
 * be, and is the way to set one.
 */
export function CostWarning({ symbol, onSet }: { symbol: string; onSet?: () => void }) {
  const { t } = useTranslation();
  const body = (
    <>
      <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
      {t('holdings.setCost')}
    </>
  );
  return onSet ? (
    <button
      type="button"
      onClick={onSet}
      title={t('holdings.noCostTitle')}
      aria-label={t('holdings.setCostFor', { symbol })}
      className="tap-compact tap-tight inline-flex items-center gap-1 rounded bg-warn/15 px-1.5 py-0.5 text-2xs text-warn hover:bg-warn/25"
    >
      {body}
    </button>
  ) : (
    <span title={t('holdings.noCostTitle')} className="inline-flex items-center gap-1 rounded bg-warn/15 px-1.5 py-0.5 text-2xs text-warn">
      {body}
    </span>
  );
}

/** Numeric quantities arrive as exact decimal strings; trim trailing zeros only. */
export function trimQuantity(quantity: string): string {
  if (!quantity.includes('.')) return quantity;
  return quantity.replace(/0+$/, '').replace(/\.$/, '');
}

export { minorToNumber };
