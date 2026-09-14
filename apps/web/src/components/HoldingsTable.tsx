import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Check, Clock, Pencil, Trash2, X } from 'lucide-react';

import { formatMoney, formatPercent, minorToNumber, type HoldingView } from '@traders/shared';

import { useStore } from '../stores/context.tsx';
import { Card, Delta } from './ui.tsx';

export const HoldingsTable = observer(function HoldingsTable() {
  const { portfolio } = useStore();
  const holdings = portfolio.data?.holdings ?? [];
  const currency = portfolio.baseCurrency;

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
              <HoldingRow key={holding.id} holding={holding} baseCurrency={currency} />
            ))}
          </tbody>
        </table>
      </div>
      {portfolio.mutationError && (
        <p className="mt-3 text-xs text-loss">{portfolio.mutationError}</p>
      )}
    </Card>
  );
});

const HoldingRow = observer(function HoldingRow({
  holding,
  baseCurrency,
}: {
  holding: HoldingView;
  baseCurrency: string;
}) {
  const { portfolio } = useStore();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(holding.quantity);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const save = async () => {
    const ok = await portfolio.updateQuantity(holding.id, draft);
    if (ok) setEditing(false);
  };

  return (
    <tr className="border-b border-border-subtle/50 last:border-0 hover:bg-surface-hover/40">
      <td className="py-2 pr-3">
        <div className="flex items-center gap-2">
          <span className="font-medium">{holding.instrument.symbol}</span>
          {holding.quote?.stale && (
            <span
              title={`Last known price from ${new Date(holding.quote.asOf).toLocaleString()}`}
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
          {holding.quote && holding.quote.delaySeconds > 0 && (
            <span title={`${holding.quote.source} quote, delayed`}>
              {' '}
              · {Math.round(holding.quote.delaySeconds / 60)}m delayed
            </span>
          )}
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
        {holding.quote ? formatMoney(holding.quote.priceMinor, holding.quote.currency) : '—'}
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
              onClick={() => portfolio.removeHolding(holding.id)}
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
});

/** Numeric quantities arrive as exact decimal strings; trim trailing zeros only. */
function trimQuantity(quantity: string): string {
  if (!quantity.includes('.')) return quantity;
  return quantity.replace(/0+$/, '').replace(/\.$/, '');
}

export { minorToNumber };
