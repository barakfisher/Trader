import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Check, Clock, Pencil, Trash2, X } from 'lucide-react';

import { formatMoney, formatPercent, minorToNumber, type HoldingView } from '@traders/shared';

import { formatAge, formatExactTime } from '../lib/relativeTime.ts';
import { errorMessage } from '../api/client.ts';
import { baseCurrencyOf } from '../lib/portfolioView.ts';
import { useNarrowViewport } from '../lib/viewport.ts';
import { usePortfolioQuery, useRemoveHolding, useUpdateQuantity } from '../queries/portfolio.ts';
import { Card, Delta } from './ui.tsx';

type UpdateQuantity = ReturnType<typeof useUpdateQuantity>;
type RemoveHolding = ReturnType<typeof useRemoveHolding>;

export function HoldingsTable() {
  const { data: portfolio } = usePortfolioQuery();
  // Owned by the table, not each row, so a failure is reported once, under the
  // table, whichever row caused it - as it was before.
  const updateQuantity = useUpdateQuantity();
  const removeHolding = useRemoveHolding();
  const holdings = portfolio?.holdings ?? [];
  const currency = baseCurrencyOf(portfolio);
  const failure =
    (updateQuantity.error && errorMessage(updateQuantity.error, 'Could not update that holding.')) ||
    (removeHolding.error && errorMessage(removeHolding.error, 'Could not remove that holding.'));

  // Below `sm` the table became an 880 px strip inside a 341 px box, showing
  // the symbol, the quantity and half a price: a phone gets one card per holding.
  const narrow = useNarrowViewport();

  if (holdings.length === 0) return null;

  if (narrow) {
    return (
      <Card title={`Holdings (${holdings.length})`}>
        <ul className="divide-y divide-border-subtle/60">
          {holdings.map((holding) => (
            <li key={holding.id} className="py-3 first:pt-0 last:pb-0">
              <HoldingCard
                holding={holding}
                baseCurrency={currency}
                updateQuantity={updateQuantity}
                removeHolding={removeHolding}
              />
            </li>
          ))}
        </ul>
        {failure && <p className="mt-3 text-xs text-loss">{failure}</p>}
      </Card>
    );
  }

  return (
    <Card title={`Holdings (${holdings.length})`} className="overflow-hidden">
      <div className="-mx-4 overflow-x-auto px-4">
        <table className="w-full min-w-[880px] text-sm">
          <thead>
            <tr className="border-b border-border-subtle text-left text-xs uppercase tracking-wide text-text-muted">
              <th className="pb-2 pr-3 font-medium">Symbol</th>
              <th className="pb-2 pr-3 text-right font-medium">Quantity</th>
              <th className="pb-2 pr-3 text-right font-medium">Price</th>
              <th className="pb-2 pr-3 text-right font-medium">Day</th>
              <th className="pb-2 pr-3 text-right font-medium">Value</th>
              <th className="pb-2 pr-3 text-right font-medium">Cost</th>
              <th className="pb-2 pr-3 text-right font-medium">P&amp;L</th>
              <th className="pb-2 pr-3 text-right font-medium">Weight</th>
              <th className="pb-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {holdings.map((holding) => (
              <HoldingRow
                key={holding.id}
                holding={holding}
                baseCurrency={currency}
                updateQuantity={updateQuantity}
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

/**
 * One holding's edit and remove state, shared by its table row and its card so
 * the two cannot disagree about what Save or Remove does.
 */
function useHoldingEditor(holding: HoldingView, updateQuantity: UpdateQuantity) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(holding.quantity);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  return {
    editing,
    draft,
    setDraft,
    confirmingDelete,
    setConfirmingDelete,
    startEditing: () => setEditing(true),
    cancel: () => {
      setDraft(holding.quantity);
      setEditing(false);
    },
    save: () =>
      updateQuantity.mutate(
        { holdingId: holding.id, quantity: draft },
        { onSuccess: () => setEditing(false) },
      ),
  };
}

function HoldingRow({
  holding,
  baseCurrency,
  updateQuantity,
  removeHolding,
}: {
  holding: HoldingView;
  baseCurrency: string;
  updateQuantity: UpdateQuantity;
  removeHolding: RemoveHolding;
}) {
  const { editing, draft, setDraft, confirmingDelete, setConfirmingDelete, startEditing, cancel, save } =
    useHoldingEditor(holding, updateQuantity);

  return (
    <tr className="border-b border-border-subtle/50 last:border-0 hover:bg-surface-hover/40">
      <td className="py-2 pr-3">
        <SymbolLabel holding={holding} />
        <p className="text-xs text-text-muted">
          {holding.instrument.name ?? holding.instrument.assetClass}
        </p>
      </td>

      <td className="py-2 pr-3 text-right">
        {editing ? (
          <div className="flex items-center justify-end gap-1">
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="w-24 rounded border border-border-subtle bg-surface px-2 py-1 text-right text-sm"
              inputMode="decimal"
              aria-label={`Quantity for ${holding.instrument.symbol}`}
            />
            <button type="button" onClick={save} aria-label="Save quantity" className="text-gain">
              <Check className="size-4" />
            </button>
            <button
              type="button"
              onClick={cancel}
              aria-label="Cancel"
              className="text-text-muted"
            >
              <X className="size-4" />
            </button>
          </div>
        ) : (
          trimQuantity(holding.quantity)
        )}
      </td>

      <td className="py-2 pr-3 text-right">
        {holding.quote ? (
          <>
            <div>{formatMoney(holding.quote.priceMinor, holding.quote.currency)}</div>
            {/* The price is only as fresh as its observation window, and the
                provider's delay is on top of that. Showing both stops the table
                implying every figure is live. */}
            <div
              className="text-[11px] text-text-muted"
              title={`Observed ${formatExactTime(holding.quote.asOf)} via ${holding.quote.source}${
                holding.quote.delaySeconds > 0
                  ? `, on a ${Math.round(holding.quote.delaySeconds / 60)}-minute delayed feed`
                  : ''
              }`}
            >
              {formatAge(holding.quote.asOf)}
              {holding.quote.delaySeconds > 0 &&
                ` · ${Math.round(holding.quote.delaySeconds / 60)}m delay`}
            </div>
          </>
        ) : (
          '—'
        )}
      </td>
      <td className="py-2 pr-3 text-right">
        <Delta value={holding.quote?.dayChangePct ?? null}>
          {formatPercent(holding.quote?.dayChangePct ?? null)}
        </Delta>
      </td>
      <td className="py-2 pr-3 text-right">{formatMoney(holding.valueMinor, baseCurrency)}</td>
      <td className="py-2 pr-3 text-right text-text-muted">
        {formatMoney(holding.costMinor, baseCurrency)}
      </td>
      <td className="py-2 pr-3 text-right">
        <Delta value={holding.pnlMinor}>
          {holding.pnlMinor === null
            ? '—'
            : `${formatMoney(holding.pnlMinor, baseCurrency)} (${formatPercent(holding.pnlPct)})`}
        </Delta>
      </td>
      <td className="py-2 pr-3 text-right text-text-muted">
        {holding.weightPct === null ? '—' : `${holding.weightPct.toFixed(1)}%`}
      </td>

      <td className="py-2 text-right">
        {confirmingDelete ? (
          <span className="flex items-center justify-end gap-2 text-xs">
            <button
              type="button"
              onClick={() => removeHolding.mutate(holding.id)}
              className="text-loss underline"
            >
              Remove
            </button>
            <button type="button" onClick={() => setConfirmingDelete(false)} className="text-text-muted">
              Cancel
            </button>
          </span>
        ) : (
          <span className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={startEditing}
              aria-label={`Edit ${holding.instrument.symbol}`}
              className="text-text-muted hover:text-text-primary"
            >
              <Pencil className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              aria-label={`Remove ${holding.instrument.symbol}`}
              className="text-text-muted hover:text-loss"
            >
              <Trash2 className="size-4" />
            </button>
          </span>
        )}
      </td>
    </tr>
  );
}

/** The symbol with its warnings: a stale price and an unpriced holding are said beside it. */
function SymbolLabel({ holding }: { holding: HoldingView }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link
        to="/holdings/$holdingId"
        params={{ holdingId: holding.id }}
        className="font-medium text-accent hover:underline"
      >
        {holding.instrument.symbol}
      </Link>
      {holding.quote?.stale && (
        <span
          title={`Last known price, observed ${formatExactTime(holding.quote.asOf)}. No provider could refresh it.`}
          className="flex items-center gap-1 rounded bg-warn/15 px-1.5 py-0.5 text-[10px] text-warn"
        >
          <Clock className="size-3" aria-hidden /> stale
        </span>
      )}
      {holding.valueMinor === null && (
        <span className="rounded bg-loss/15 px-1.5 py-0.5 text-[10px] text-loss">unpriced</span>
      )}
    </div>
  );
}

/** A 40 px tap target: the table's 16 px icons are a desktop pointer's size, not a thumb's. */
const CARD_BUTTON = 'flex h-10 items-center gap-1.5 rounded-lg border border-border-subtle px-3 text-xs';

/**
 * One holding on a phone: what it is worth and how it has done first, then the
 * figures behind them, then the two things that can be done to it.
 */
function HoldingCard({
  holding,
  baseCurrency,
  updateQuantity,
  removeHolding,
}: {
  holding: HoldingView;
  baseCurrency: string;
  updateQuantity: UpdateQuantity;
  removeHolding: RemoveHolding;
}) {
  const { editing, draft, setDraft, confirmingDelete, setConfirmingDelete, startEditing, cancel, save } =
    useHoldingEditor(holding, updateQuantity);
  const symbol = holding.instrument.symbol;

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <SymbolLabel holding={holding} />
          <p className="truncate text-xs text-text-muted">
            {holding.instrument.name ?? holding.instrument.assetClass}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-sm font-semibold">{formatMoney(holding.valueMinor, baseCurrency)}</p>
          <p className="text-xs">
            <Delta value={holding.pnlMinor}>
              {holding.pnlMinor === null
                ? '—'
                : `${formatMoney(holding.pnlMinor, baseCurrency)} (${formatPercent(holding.pnlPct)})`}
            </Delta>
          </p>
        </div>
      </div>

      <p className="text-xs text-text-muted">
        {trimQuantity(holding.quantity)} ×{' '}
        {holding.quote ? formatMoney(holding.quote.priceMinor, holding.quote.currency) : 'no price'}
        {holding.quote && (
          <>
            {' · '}
            <Delta value={holding.quote.dayChangePct}>
              {formatPercent(holding.quote.dayChangePct)}
            </Delta>{' '}
            today
          </>
        )}
        {holding.weightPct !== null && ` · ${holding.weightPct.toFixed(1)}% of portfolio`}
        {holding.quote && ` · price ${formatAge(holding.quote.asOf)}`}
      </p>

      {editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="h-10 w-32 rounded-lg border border-border-subtle bg-surface px-3 text-right text-sm"
            inputMode="decimal"
            aria-label={`Quantity for ${symbol}`}
          />
          <button type="button" onClick={save} className={`${CARD_BUTTON} text-gain`}>
            <Check className="size-4" aria-hidden /> Save
          </button>
          <button type="button" onClick={cancel} className={`${CARD_BUTTON} text-text-muted`}>
            Cancel
          </button>
        </div>
      ) : confirmingDelete ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-text-muted">Remove {symbol}?</span>
          <button
            type="button"
            onClick={() => removeHolding.mutate(holding.id)}
            className={`${CARD_BUTTON} border-loss/40 text-loss`}
          >
            Remove
          </button>
          <button
            type="button"
            onClick={() => setConfirmingDelete(false)}
            className={`${CARD_BUTTON} text-text-muted`}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={startEditing}
            aria-label={`Edit ${symbol}`}
            className={`${CARD_BUTTON} text-text-muted`}
          >
            <Pencil className="size-4" aria-hidden /> Quantity
          </button>
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            aria-label={`Remove ${symbol}`}
            className={`${CARD_BUTTON} text-text-muted`}
          >
            <Trash2 className="size-4" aria-hidden /> Remove
          </button>
        </div>
      )}
    </div>
  );
}

/** Numeric quantities arrive as exact decimal strings; trim trailing zeros only. */
function trimQuantity(quantity: string): string {
  if (!quantity.includes('.')) return quantity;
  return quantity.replace(/0+$/, '').replace(/\.$/, '');
}

export { minorToNumber };
