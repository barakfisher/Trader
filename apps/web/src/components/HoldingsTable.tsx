import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Check, Clock, Pencil, Trash2, X } from 'lucide-react';

import { formatMoney, formatPercent, minorToNumber, type HoldingView } from '@traders/shared';

import { formatAge, formatExactTime } from '../lib/relativeTime.ts';
import { errorMessage } from '../api/client.ts';
import { baseCurrencyOf } from '../lib/portfolioView.ts';
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

  if (holdings.length === 0) return null;

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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(holding.quantity);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const save = () => {
    updateQuantity.mutate(
      { holdingId: holding.id, quantity: draft },
      { onSuccess: () => setEditing(false) },
    );
  };

  return (
    <tr className="border-b border-border-subtle/50 last:border-0 hover:bg-surface-hover/40">
      <td className="py-2 pr-3">
        <div className="flex items-center gap-2">
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
              onClick={() => {
                setDraft(holding.quantity);
                setEditing(false);
              }}
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
              onClick={() => setEditing(true)}
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

/** Numeric quantities arrive as exact decimal strings; trim trailing zeros only. */
function trimQuantity(quantity: string): string {
  if (!quantity.includes('.')) return quantity;
  return quantity.replace(/0+$/, '').replace(/\.$/, '');
}

export { minorToNumber };
