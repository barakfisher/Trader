import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';

import { minorToDecimalString } from '@traders/shared';

import { errorMessage } from '../api/client.ts';
import { useTranslation } from '../i18n/index.ts';
import { formatMoney, leftToRight } from '../i18n/format.ts';
import { formatAge, todayInDisplayZone } from '../lib/relativeTime.ts';
import { useInstrumentQuote } from '../queries/instruments.ts';
import { useAddHolding } from '../queries/portfolio.ts';
import { SymbolField } from './SymbolField.tsx';
import { Button, Card } from './ui.tsx';

/**
 * Add a holding by hand. In its own card on the empty dashboard; bare inside
 * the holdings card's drawer (UX5), which closes on `onAdded`.
 *
 * Once a symbol is settled on, the cost per unit is prefilled with its latest
 * price, and the opening date defaults to today (D326). The date does not move
 * the price. A cost the user typed is never overwritten; one the form filled
 * follows the symbol. No price is an empty field, never zero.
 */
export function AddHoldingForm({ framed = true, onAdded }: { framed?: boolean; onAdded?: () => void } = {}) {
  // Pending until the portfolio has refetched, so the new row is on screen by
  // the time the button stops saying "Adding…".
  const addHolding = useAddHolding();
  const { t } = useTranslation();
  const [symbol, setSymbol] = useState('');
  const [quantity, setQuantity] = useState('');
  const [costBasis, setCostBasis] = useState('');
  // Whether the cost is the user's own: then nothing the form fetches replaces it.
  const [costTyped, setCostTyped] = useState(false);
  const today = todayInDisplayZone();
  const [openedAt, setOpenedAt] = useState(today);
  const [quoteSymbol, setQuoteSymbol] = useState<string | null>(null);
  const quote = useInstrumentQuote(quoteSymbol);
  const price = quote.data?.symbol === quoteSymbol ? quote.data : undefined;

  useEffect(() => {
    if (costTyped || !price) return;
    setCostBasis(
      price.priceMinor === null || price.currency === null
        ? ''
        : minorToDecimalString(price.priceMinor, price.currency),
    );
  }, [price, costTyped]);

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
          setCostTyped(false);
          setQuoteSymbol(null);
          setOpenedAt(todayInDisplayZone());
          onAdded?.();
        },
      },
    );
  };

  const costHint = costTyped
    ? t('addHolding.optional')
    : quote.isFetching
      ? t('addHolding.priceLoading')
      : price?.priceMinor != null && price.currency
        ? t('addHolding.pricePrefilled', {
            price: leftToRight(formatMoney(price.priceMinor, price.currency)),
            age: formatAge(price.asOf),
          })
        : price
          ? t('addHolding.noPrice')
          : quote.isError
            ? t('addHolding.priceFailed')
            : t('addHolding.optional');

  const form = (
    <form onSubmit={submit} className="space-y-3">
      <SymbolField value={symbol} onChange={setSymbol} onCommit={setQuoteSymbol} />
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
        <Field label={t('addHolding.costPerUnit')} hint={costHint}>
          <input
            value={costBasis}
            onChange={(event) => {
              setCostBasis(event.target.value);
              setCostTyped(event.target.value !== '');
            }}
            inputMode="decimal"
            placeholder={quote.isFetching && !costTyped ? t('addHolding.priceLoading') : '185.40'}
            className="input"
          />
        </Field>
      </div>
      <Field label={t('addHolding.opened')} hint={t('addHolding.optional')}>
        <input
          type="date"
          value={openedAt}
          max={today}
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
