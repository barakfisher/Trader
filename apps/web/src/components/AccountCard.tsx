import { useState, type FormEvent } from 'react';
import { AlertTriangle, Wallet } from 'lucide-react';

import type { PortfolioSummary, PrimaryCashResponse } from '@traders/shared';

import { errorMessage } from '../api/client.ts';
import { formatMoney } from '../i18n/format.ts';
import { useTranslation } from '../i18n/index.ts';
import { BUDGET_INPUT } from '../lib/agentPresentation.ts';
import { useCashWrite, usePrimaryCash, type CashAction } from '../queries/portfolioCash.ts';
import { Drawer } from './Drawer.tsx';
import { Button, Delta, ErrorNote } from './ui.tsx';

/**
 * The main portfolio's account (D328-D330), in place of the total-cost card:
 * the account's value - holdings at market plus the cash at the broker - with
 * the cash and the money put in under it.
 *
 * Until the user enters their cash, the card says so and offers to set it:
 * a $0 nobody entered would read as an empty account (guideline 7). The
 * figures are the portfolio summary's own, so when a holding is unpriced the
 * value carries the same warning the other cards do.
 */
export function AccountCard({ summary }: { summary: PortfolioSummary }) {
  const { t } = useTranslation();
  const cash = usePrimaryCash();
  const [open, setOpen] = useState(false);
  const currency = summary.baseCurrency;
  const money = (minor: number) => <bdi>{formatMoney(minor, currency)}</bdi>;
  const data = cash.data;

  let body: React.ReactNode;
  if (cash.isPending) {
    body = <span className="mt-1 block text-sm text-text-muted">{t('account.loading')}</span>;
  } else if (cash.isError || !data) {
    body = <span className="mt-1 block text-xs text-loss">{t('account.loadFailed')}</span>;
  } else if (data.state === 'unset') {
    body = (
      <>
        <span className="mt-1 block text-base font-semibold tabular-nums sm:text-lg">
          {money(summary.totalValueMinor)}
        </span>
        <span className="mt-1 block text-xs text-text-muted">{t('account.cashUnset')}</span>
      </>
    );
  } else {
    const value = summary.totalValueMinor + data.cashMinor;
    const gain = value - data.investedMinor;
    body = (
      <>
        <span className="mt-1 block text-base font-semibold tabular-nums sm:text-lg">{money(value)}</span>
        <dl className="mt-1 space-y-0.5 text-xs text-text-muted">
          <div className="flex justify-between gap-2">
            <dt>{t('account.cash')}</dt>
            <dd className="tabular-nums text-text-primary">{money(data.cashMinor)}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt>{t('account.invested')}</dt>
            <dd className="tabular-nums text-text-primary">{money(data.investedMinor)}</dd>
          </div>
          {!summary.degraded && (
            <div className="flex justify-between gap-2">
              <dt>{t('account.gain')}</dt>
              <dd className="tabular-nums">
                <Delta value={gain}>{money(gain)}</Delta>
              </dd>
            </div>
          )}
        </dl>
        {summary.degraded && (
          <span className="mt-1 flex items-center gap-1 text-xs text-warn">
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
            {t('account.incomplete')}
          </span>
        )}
      </>
    );
  }

  return (
    <div className="min-w-0 rounded-xl border border-border-subtle bg-surface-raised px-3 py-3 sm:px-4">
      <div className="flex items-start justify-between gap-2">
        <span className="block text-xs uppercase tracking-wide text-text-muted">{t('account.title')}</span>
        {data && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            className="flex items-center gap-1 text-xs text-accent hover:underline"
          >
            <Wallet className="size-3.5" aria-hidden />
            {data.state === 'unset' ? t('account.setCash') : t('account.manage')}
          </button>
        )}
      </div>
      {body}
      {open && data && (
        <Drawer title={t('account.drawerTitle')} closeLabel={t('holdings.actions.close')} onClose={() => setOpen(false)}>
          <CashForms cash={data} onDone={() => setOpen(false)} />
        </Drawer>
      )}
    </div>
  );
}

/** Set the opening cash; once set, deposit or correct it to what the broker shows. */
function CashForms({ cash, onDone }: { cash: PrimaryCashResponse; onDone: () => void }) {
  const { t } = useTranslation();
  if (cash.state === 'unset') {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-text-muted">{t('account.openExplained')}</p>
        <AmountForm action="open" label={t('account.openLabel')} submit={t('account.openSubmit')} allowZero onDone={onDone} />
      </div>
    );
  }
  return (
    <div className="space-y-5 text-sm">
      <dl className="grid grid-cols-2 gap-2 text-xs">
        <Fact label={t('account.cash')} value={formatMoney(cash.cashMinor, cash.currency)} />
        <Fact label={t('account.deposits')} value={formatMoney(cash.depositsMinor, cash.currency)} />
        <Fact label={t('account.openingHoldings')} value={formatMoney(cash.openingHoldingsCostMinor, cash.currency)} />
        <Fact label={t('account.feesPaid')} value={formatMoney(cash.feesPaidMinor, cash.currency)} />
      </dl>
      <section className="space-y-2">
        <h3 className="font-medium">{t('account.depositTitle')}</h3>
        <p className="text-xs text-text-muted">{t('account.depositExplained')}</p>
        <AmountForm action="deposit" label={t('account.depositLabel')} submit={t('account.depositSubmit')} onDone={onDone} />
      </section>
      <section className="space-y-2">
        <h3 className="font-medium">{t('account.correctTitle')}</h3>
        <p className="text-xs text-text-muted">{t('account.correctExplained')}</p>
        <AmountForm
          action="correct"
          label={t('account.correctLabel')}
          submit={t('account.correctSubmit')}
          allowZero
          onDone={onDone}
        />
      </section>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-text-muted">{label}</dt>
      <dd className="font-medium tabular-nums">
        <bdi>{value}</bdi>
      </dd>
    </div>
  );
}

function AmountForm({
  action,
  label,
  submit,
  allowZero = false,
  onDone,
}: {
  action: CashAction;
  label: string;
  submit: string;
  allowZero?: boolean;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const write = useCashWrite(action);
  const [amount, setAmount] = useState('');
  const typed = amount.trim();
  const valid = BUDGET_INPUT.test(typed) && (allowZero || Number(typed) > 0);
  const send = (event: FormEvent) => {
    event.preventDefault();
    // On the promise, not `mutate`'s onSuccess: opening the cash swaps this form
    // for the deposit and correction forms, and a per-call callback of an
    // unmounted form never runs - the drawer would stay open.
    write.mutateAsync({ amount: typed }).then(onDone, () => {
      // The error is shown from `write.error`.
    });
  };
  return (
    <form onSubmit={send} className="space-y-2">
      <label className="block space-y-1">
        <span className="text-xs text-text-muted">{label}</span>
        <input
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          inputMode="decimal"
          dir="ltr"
          placeholder="0.00"
          aria-invalid={amount !== '' && !valid}
          className="input"
        />
      </label>
      <Button type="submit" disabled={!valid || write.isPending}>
        {submit}
      </Button>
      {write.error && <ErrorNote message={errorMessage(write.error, t('account.saveFailed'))} />}
    </form>
  );
}
