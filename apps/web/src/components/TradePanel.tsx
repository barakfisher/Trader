import { useEffect, useState, type FormEvent } from 'react';

import type { TradeInput, TradePreview, TradeSide } from '@traders/shared';

import { useTranslation } from '../i18n/index.ts';
import { formatMoney, formatNumber, formatPercent } from '../i18n/format.ts';
import { BUDGET_INPUT, QUANTITY_INPUT, tradeErrorMessage } from '../lib/agentPresentation.ts';
import { formatClockTime } from '../lib/relativeTime.ts';
import { usePreviewTrade, useTrade } from '../queries/agents.ts';
import { AgentField } from './AgentField.tsx';
import { Drawer } from './Drawer.tsx';
import { Button, ErrorNote } from './ui.tsx';

type PriceMode = 'market' | 'typed';

/**
 * A trade placed by hand into a simulated agent's paper account (D21, D27-D29).
 *
 * Two steps, because the price can move: **Preview** asks the server what the
 * trade would do - price, fee, cash and shares after - and **Confirm** records
 * it, at the live price only if it is still within 0.5% of the one previewed
 * (the server checks; a refusal shows the new price). Changing any field
 * discards the preview, so what is confirmed is always what was shown.
 *
 * Each preview mints the idempotency key its confirm sends, so a double click
 * on Confirm records one trade, not two.
 */
export function TradePanel({
  agentId,
  initialSymbol = '',
  initialSide = 'buy',
  onClose,
}: {
  agentId: string;
  initialSymbol?: string;
  initialSide?: TradeSide;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const preview = usePreviewTrade(agentId);
  const trade = useTrade(agentId);
  const [symbol, setSymbol] = useState(initialSymbol);
  const [side, setSide] = useState<TradeSide>(initialSide);
  const [quantity, setQuantity] = useState('');
  const [mode, setMode] = useState<PriceMode>('market');
  const [price, setPrice] = useState('');
  const [shown, setShown] = useState<{ preview: TradePreview; key: string } | null>(null);

  // Any change to what is asked discards the preview it no longer describes.
  const reset = preview.reset;
  const resetTrade = trade.reset;
  useEffect(() => {
    setShown(null);
    reset();
    resetTrade();
  }, [symbol, side, quantity, mode, price, reset, resetTrade]);

  const valid =
    symbol.trim() !== '' && QUANTITY_INPUT.test(quantity.trim()) && (mode === 'market' || BUDGET_INPUT.test(price.trim()));

  const input = (): TradeInput => ({
    symbol: symbol.trim().toUpperCase(),
    side,
    quantity: quantity.trim(),
    ...(mode === 'typed' ? { price: price.trim() } : {}),
  });

  const ask = (event: FormEvent) => {
    event.preventDefault();
    preview.mutate(input(), {
      onSuccess: (result) => setShown({ preview: result, key: crypto.randomUUID() }),
    });
  };

  const confirm = () => {
    if (!shown) return;
    trade.mutate(
      {
        ...input(),
        ...(mode === 'market' ? { shownPriceMinor: shown.preview.priceMinor } : {}),
        idempotencyKey: shown.key,
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Drawer title={t('agents.trade.title')} closeLabel={t('agents.trade.close')} onClose={onClose}>
      <form onSubmit={ask} className="space-y-3">
        <AgentField label={t('agents.trade.symbol')} hint={t('agents.trade.symbolHint')}>
          <input
            value={symbol}
            onChange={(event) => setSymbol(event.target.value)}
            dir="ltr"
            autoCapitalize="characters"
            maxLength={32}
            required
            className="w-full rounded-md border border-border-subtle bg-surface px-3 py-2 text-start uppercase"
          />
        </AgentField>

        <fieldset className="flex gap-2">
          <legend className="mb-1 text-xs text-text-muted">{t('agents.trade.side')}</legend>
          {(['buy', 'sell'] as const).map((value) => (
            <label key={value} className="flex items-center gap-1 text-sm">
              <input type="radio" name="side" checked={side === value} onChange={() => setSide(value)} />
              {t(`agents.trade.${value}`)}
            </label>
          ))}
        </fieldset>

        <AgentField label={t('agents.trade.quantity')}>
          <input
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            inputMode="numeric"
            dir="ltr"
            required
            aria-invalid={quantity !== '' && !QUANTITY_INPUT.test(quantity.trim())}
            className="w-full rounded-md border border-border-subtle bg-surface px-3 py-2 text-start"
          />
        </AgentField>

        <fieldset className="space-y-1">
          <legend className="mb-1 text-xs text-text-muted">{t('agents.trade.priceMode')}</legend>
          <label className="flex items-center gap-1 text-sm">
            <input type="radio" name="price-mode" checked={mode === 'market'} onChange={() => setMode('market')} />
            {t('agents.trade.market')}
          </label>
          <label className="flex items-center gap-1 text-sm">
            <input type="radio" name="price-mode" checked={mode === 'typed'} onChange={() => setMode('typed')} />
            {t('agents.trade.typed')}
          </label>
          <p className="text-xs text-text-muted">
            {mode === 'market' ? t('agents.trade.marketHint') : t('agents.trade.typedHint')}
          </p>
        </fieldset>

        {mode === 'typed' && (
          <AgentField label={t('agents.trade.typedPrice')}>
            <input
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              inputMode="decimal"
              dir="ltr"
              required
              aria-invalid={price !== '' && !BUDGET_INPUT.test(price.trim())}
              className="w-full rounded-md border border-border-subtle bg-surface px-3 py-2 text-start"
            />
          </AgentField>
        )}

        {preview.error && <ErrorNote message={tradeErrorMessage(preview.error, t('agents.trade.previewFailed'))} />}
        <Button type="submit" variant="secondary" disabled={!valid || preview.isPending}>
          {t('agents.trade.preview')}
        </Button>
      </form>

      {shown && (
        <PreviewSummary preview={shown.preview}>
          {trade.error && <ErrorNote message={tradeErrorMessage(trade.error, t('agents.trade.failed'))} />}
          <Button onClick={confirm} disabled={trade.isPending}>
            {side === 'buy' ? t('agents.trade.confirmBuy') : t('agents.trade.confirmSell')}
          </Button>
        </PreviewSummary>
      )}
    </Drawer>
  );
}

export function PreviewSummary({ preview, children }: { preview: TradePreview; children: React.ReactNode }) {
  const { t } = useTranslation();
  const money = (minor: number) => <bdi>{formatMoney(minor, preview.currency)}</bdi>;
  const rows: [string, React.ReactNode][] = [
    [
      t('agents.trade.price'),
      <>
        {money(preview.priceMinor)}{' '}
        <span className="text-xs text-text-muted">
          {preview.priceSource === 'user'
            ? t('agents.trade.typedTag')
            : t('agents.trade.quoteTag', {
                time: formatClockTime(preview.quoteAsOf ?? ''),
                minutes: formatNumber(Math.round((preview.quoteDelaySeconds ?? 0) / 60)),
              })}
        </span>
      </>,
    ],
    [t('agents.trade.notional'), money(preview.notionalMinor)],
    [t('agents.trade.fee'), money(preview.feeMinor)],
    [t('agents.trade.cashChange'), money(preview.cashChangeMinor)],
    [t('agents.trade.cashAfter'), money(preview.cashAfterMinor)],
    [t('agents.trade.heldAfter'), <bdi>{formatNumber(Number(preview.heldAfterQuantity))}</bdi>],
  ];
  return (
    <section aria-label={t('agents.trade.previewTitle')} className="mt-4 space-y-3 rounded-lg border border-border-subtle p-3">
      <h3 className="text-xs font-semibold text-text-muted">{t('agents.trade.previewTitle')}</h3>
      <dl className="space-y-1 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3">
            <dt className="text-text-muted">{label}</dt>
            <dd className="text-end">{value}</dd>
          </div>
        ))}
      </dl>
      {preview.warnings.map((warning) => (
        <p key={warning.kind} role="alert" className="rounded-md bg-loss/10 p-2 text-xs text-loss">
          {t('agents.trade.farFromQuote', {
            deviation: formatPercent(warning.deviationBps / 100, 1),
            reference: formatMoney(warning.referencePriceMinor, preview.currency),
            time: formatClockTime(warning.referenceAsOf),
          })}
        </p>
      ))}
      {children}
    </section>
  );
}
