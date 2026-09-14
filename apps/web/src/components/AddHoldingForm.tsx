import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Plus } from 'lucide-react';

import { useStore } from '../stores/context.tsx';
import { Button, Card } from './ui.tsx';

export const AddHoldingForm = observer(function AddHoldingForm() {
  const { portfolio } = useStore();
  const [symbol, setSymbol] = useState('');
  const [quantity, setQuantity] = useState('');
  const [costBasis, setCostBasis] = useState('');
  const [openedAt, setOpenedAt] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const added = await portfolio.addHolding({
      symbol: symbol.trim(),
      quantity: quantity.trim(),
      costBasis: costBasis.trim() || null,
      openedAt: openedAt || null,
    });
    if (added) {
      setSymbol('');
      setQuantity('');
      setCostBasis('');
      setOpenedAt('');
    }
  };

  return (
    <Card title="Add a holding">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Symbol" hint="Ticker as your data provider spells it, e.g. AAPL or BTC-USD">
          <input
            value={symbol}
            onChange={(event) => setSymbol(event.target.value.toUpperCase())}
            required
            placeholder="AAPL"
            className="input"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Quantity">
            <input
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              required
              inputMode="decimal"
              placeholder="10"
              className="input"
            />
          </Field>
          <Field label="Cost per unit" hint="Optional">
            <input
              value={costBasis}
              onChange={(event) => setCostBasis(event.target.value)}
              inputMode="decimal"
              placeholder="185.40"
              className="input"
            />
          </Field>
        </div>
        <Field label="Opened" hint="Optional">
          <input
            type="date"
            value={openedAt}
            onChange={(event) => setOpenedAt(event.target.value)}
            className="input"
          />
        </Field>

        {portfolio.mutationError && <p className="text-xs text-loss">{portfolio.mutationError}</p>}

        <Button type="submit" disabled={portfolio.mutating || !symbol || !quantity}>
          <span className="flex items-center gap-1">
            <Plus className="size-4" aria-hidden />
            {portfolio.mutating ? 'Adding…' : 'Add holding'}
          </span>
        </Button>
      </form>
    </Card>
  );
});

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
