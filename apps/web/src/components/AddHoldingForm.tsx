import { useState } from 'react';
import { Plus } from 'lucide-react';

import { errorMessage } from '../api/client.ts';
import { useTranslation } from '../i18n/index.ts';
import { useAddHolding } from '../queries/portfolio.ts';
import { Button, Card } from './ui.tsx';

/**
 * Add a holding by hand. In its own card on the empty dashboard; bare inside
 * the holdings card's drawer (UX5), which closes on `onAdded`.
 */
export function AddHoldingForm({ framed = true, onAdded }: { framed?: boolean; onAdded?: () => void } = {}) {
  // Pending until the portfolio has refetched, so the new row is on screen by
  // the time the button stops saying "Adding…".
  const addHolding = useAddHolding();
  const { t } = useTranslation();
  const [symbol, setSymbol] = useState('');
  const [quantity, setQuantity] = useState('');
  const [costBasis, setCostBasis] = useState('');
  const [openedAt, setOpenedAt] = useState('');

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    addHolding.mutate(
      {
        symbol: symbol.trim(),
        quantity: quantity.trim(),
        costBasis: costBasis.trim() || null,
        openedAt: openedAt || null,
      },
      {
        onSuccess: () => {
          setSymbol('');
          setQuantity('');
          setCostBasis('');
          setOpenedAt('');
          onAdded?.();
        },
      },
    );
  };

  const form = (
    <form onSubmit={submit} className="space-y-3">
      <Field label={t('addHolding.symbol')} hint={t('addHolding.symbolHint')}>
        <input
          value={symbol}
          onChange={(event) => setSymbol(event.target.value.toUpperCase())}
          required
          placeholder="AAPL"
          className="input"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('addHolding.quantity')}>
          <input
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            required
            inputMode="decimal"
            placeholder="10"
            className="input"
          />
        </Field>
        <Field label={t('addHolding.costPerUnit')} hint={t('addHolding.optional')}>
          <input
            value={costBasis}
            onChange={(event) => setCostBasis(event.target.value)}
            inputMode="decimal"
            placeholder="185.40"
            className="input"
          />
        </Field>
      </div>
      <Field label={t('addHolding.opened')} hint={t('addHolding.optional')}>
        <input
          type="date"
          value={openedAt}
          onChange={(event) => setOpenedAt(event.target.value)}
          className="input"
        />
      </Field>

      {addHolding.error && (
        <p className="text-xs text-loss">{errorMessage(addHolding.error, t('addHolding.failed'))}</p>
      )}

      <Button type="submit" disabled={addHolding.isPending || !symbol || !quantity}>
        <span className="flex items-center gap-1">
          <Plus className="size-4" aria-hidden />
          {addHolding.isPending ? t('addHolding.adding') : t('addHolding.add')}
        </span>
      </Button>
    </form>
  );
  return framed ? <Card title={t('addHolding.title')}>{form}</Card> : form;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs uppercase tracking-wide text-text-muted">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-text-muted">{hint}</span>}
    </label>
  );
}
