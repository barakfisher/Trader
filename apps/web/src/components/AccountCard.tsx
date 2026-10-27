import { useState, type FormEvent } from 'react';
import { AlertTriangle, Wallet } from 'lucide-react';

import {
  PRIMARY_MOVEMENT_TYPES,
  type PortfolioSummary,
  type PrimaryCashResponse,
  type PrimaryMovementType,
} from '@traders/shared';

import { ApiRequestError } from '../api/client.ts';
import { formatMoney } from '../i18n/format.ts';
import { t as translate, useTranslation } from '../i18n/index.ts';
import { BUDGET_INPUT } from '../lib/agentPresentation.ts';
import { useCashMovement, useCashWrite, usePrimaryCash, type CashAction } from '../queries/portfolioCash.ts';
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

/** The sentence for a refused cash write, from its code: the server's own words are English only. */
function cashErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiRequestError)) return fallback;
  switch (error.code) {
    case 'insufficient_cash':
      return translate('account.errors.insufficientCash');
    case 'amount_out_of_range':
      return translate('account.errors.outOfRange');
    case 'cash_not_set':
      return translate('account.errors.notSet');
    case 'cash_already_set':
      return translate('account.errors.alreadySet');
    default:
      return fallback;
  }
}

/**
 * Set the opening cash; once set, record a movement for what it is (D340), or
 * set the cash to what the broker shows to put a typo right (D342).
 */
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
        <Fact label={t('account.income')} value={formatMoney(cash.incomeMinor, cash.currency)} />
        <Fact label={t('account.charges')} value={formatMoney(cash.chargesMinor, cash.currency)} />
      </dl>
      <MovementForm onDone={onDone} />
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

/** One movement of the cash: what it is, then its amount - always positive, the type says which way. */
function MovementForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const write = useCashMovement();
  const [type, setType] = useState<PrimaryMovementType>('deposit');
  const [amount, setAmount] = useState('');
  const typed = amount.trim();
  const valid = BUDGET_INPUT.test(typed) && Number(typed) > 0;
  const send = (event: FormEvent) => {
    event.preventDefault();
    // On the promise, as `AmountForm` does: the drawer closes when the write lands.
    write.mutateAsync({ type, amount: typed }).then(onDone, () => {
      // The error is shown from `write.error`.
    });
  };
  return (
    <section className="space-y-2">
      <h3 className="font-medium">{t('account.movementTitle')}</h3>
      <form onSubmit={send} className="space-y-2">
        <fieldset className="space-y-1">
          <legend className="text-xs text-text-muted">{t('account.movementType')}</legend>
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
            {PRIMARY_MOVEMENT_TYPES.map((option) => (
              <label
                key={option}
                className={`cursor-pointer rounded-lg border px-2 py-1.5 text-center text-xs transition ${
                  option === type
                    ? 'border-accent bg-accent/10 font-medium text-text-primary'
                    : 'border-border-subtle text-text-muted hover:bg-surface-hover'
                }`}
              >
                <input
                  type="radio"
                  name="movement-type"
                  value={option}
                  checked={option === type}
                  onChange={() => setType(option)}
                  className="sr-only"
                />
                {t(`account.movements.${option}.label`)}
              </label>
            ))}
          </div>
        </fieldset>
        <p className="text-xs text-text-muted">{t(`account.movements.${type}.explained`)}</p>
        <label className="block space-y-1">
          <span className="text-xs text-text-muted">{t('account.movementAmount')}</span>
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
          {t(`account.movements.${type}.submit`)}
        </Button>
        {write.error && <ErrorNote message={cashErrorMessage(write.error, t('account.saveFailed'))} />}
      </form>
    </section>
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
      {write.error && <ErrorNote message={cashErrorMessage(write.error, t('account.saveFailed'))} />}
    </form>
  );
}
