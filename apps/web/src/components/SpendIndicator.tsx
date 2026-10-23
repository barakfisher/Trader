import { useEffect, useId, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Link, useRouterState } from '@tanstack/react-router';
import { KeyRound, X } from 'lucide-react';

import type { KeySpend } from '@traders/shared';

import { t, useTranslation } from '../i18n/index.ts';
import { formatMicroUsdCents } from '../lib/llmCalls.ts';
import { formatResetDate } from '../lib/monthlyCap.ts';
import { formatClockTime } from '../lib/relativeTime.ts';
import { useKeySpendQuery } from '../queries/settings.ts';
import { useStore } from '../stores/context.tsx';

/**
 * Spend on the user's own OpenRouter key, in the top bar on every screen
 * (D247-D250, D281): the ratio against whichever limit binds first, a bar that
 * takes the warning color when five days or fewer are left at this week's pace,
 * and on a tap the pace, the days left and a link to Settings. Tap or click opens
 * it, so it works on a phone and from the keyboard; hover is not needed.
 *
 * The admin, on the installation's key, sees nothing. With no key the chip says
 * *Add key*; with a refused one, that it was refused. Amounts are USD, OpenRouter's
 * currency, never converted, and every figure on it is OpenRouter's or this
 * app's own count against the safety limit - never a guess.
 */
export const SpendIndicator = observer(function SpendIndicator() {
  const { auth } = useStore();
  const { t } = useTranslation();
  const spend = useKeySpendQuery(auth.user !== null && auth.user?.role !== 'admin').data;
  if (!spend || spend.key === 'unavailable') return null;

  if (spend.key !== 'valid') {
    return (
      <Link
        to="/settings"
        className="flex items-center gap-1 rounded-full border border-warn/40 px-2 py-0.5 text-xs text-warn hover:bg-warn/10"
      >
        <KeyRound className="size-3" aria-hidden />
        {t(spend.key === 'none' ? 'spendIndicator.addKey' : 'spendIndicator.keyRefused')}
      </Link>
    );
  }
  return <SpendChip spend={spend} />;
});

/** What the chip and its bar show: the binding limit's ratio, or the key's unlimited one. */
export function headline(spend: KeySpend): { used: number; limit: number | null; period: string | null } | null {
  if (spend.binding === 'safety' && spend.safetyLimit) {
    return { used: spend.safetyLimit.spentMicroUsd, limit: spend.safetyLimit.limitMicroUsd, period: 'month' };
  }
  if (!spend.reading) return null;
  return { used: spend.reading.usedMicroUsd, limit: spend.reading.limitMicroUsd, period: spend.reading.period };
}

function SpendChip({ spend }: { spend: KeySpend }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const shown = headline(spend);
  const ratio = shown ? ratioText(shown.used, shown.limit) : t('spendIndicator.unreadable');
  const fraction = shown?.limit ? Math.min(1, shown.used / shown.limit) : null;
  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={t('spendIndicator.label', { ratio })}
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-2 rounded-full border px-2 py-0.5 text-xs hover:bg-surface-hover ${
          spend.warning ? 'border-warn/40 text-warn' : 'border-border-subtle text-text-muted'
        }`}
      >
        {fraction !== null && (
          <span className="h-1.5 w-10 overflow-hidden rounded-full bg-surface-hover" aria-hidden>
            <span
              className={`block h-full rounded-full ${spend.warning ? 'bg-warn' : 'bg-accent'}`}
              style={{ width: `${Math.round(fraction * 100)}%` }}
            />
          </span>
        )}
        <bdi className="tabular-nums">{ratio}</bdi>
        {shown?.period && (
          <span className="hidden sm:inline">{t(`spendIndicator.periods.${shown.period as 'month'}`)}</span>
        )}
      </button>
      {open && (
        <div
          id={panelId}
          className="absolute end-0 top-full z-40 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-border-subtle bg-surface-raised p-3 text-start shadow-lg"
        >
          <KeySpendDetails spend={spend} />
          <Link to="/settings" className="mt-2 inline-block text-xs font-medium text-accent hover:underline">
            {t('spendIndicator.openSettings')}
          </Link>
        </div>
      )}
    </div>
  );
}

/**
 * "$12.00 / $50.00", or "$12.00 / Unlimited", as a left-to-right isolate: a ratio
 * of amounts has no letters to set its direction, so in a Hebrew sentence it would
 * otherwise read limit first.
 */
export function ratioText(used: number, limit: number | null): string {
  // Each amount in its own first-strong isolate keeps the locale's own order of
  // number and sign ("42.00 $" in Hebrew); the pair is ordered left to right.
  const amount = (text: string) => `\u2068${text}\u2069`;
  const right = limit === null ? t('spendIndicator.unlimited') : formatMicroUsdCents(limit);
  return `\u2066${amount(formatMicroUsdCents(used))} / ${amount(right)}\u2069`;
}

/** The figures behind the chip: both limits, the pace, the days left. Also in Settings. */
export function KeySpendDetails({ spend }: { spend: KeySpend }) {
  const { t } = useTranslation();
  const reading = spend.reading;
  return (
    <div className="space-y-1.5 text-xs">
      {reading ? (
        <p className="text-text-primary">
          <bdi>
            {t('spendIndicator.keyLine', {
              ratio: ratioText(reading.usedMicroUsd, reading.limitMicroUsd),
              period: reading.period ? t(`spendIndicator.periods.${reading.period}`) : '',
            })}
          </bdi>
        </p>
      ) : (
        <p className="text-text-muted">{t('spendIndicator.unreadable')}</p>
      )}
      {spend.safetyLimit && (
        <p className="text-text-primary">
          <bdi>
            {t('spendIndicator.safetyLine', {
              ratio: ratioText(spend.safetyLimit.spentMicroUsd, spend.safetyLimit.limitMicroUsd),
              date: formatResetDate(spend.safetyLimit.resetsOn),
            })}
          </bdi>
        </p>
      )}
      {reading && (
        <p className="text-text-muted">
          <bdi>
            {spend.dailyPaceMicroUsd === null
              ? t('spendIndicator.noPace')
              : t('spendIndicator.pace', { pace: formatMicroUsdCents(spend.dailyPaceMicroUsd) })}
          </bdi>
        </p>
      )}
      {spend.binding === null && reading && <p className="text-text-muted">{t('spendIndicator.noLimit')}</p>}
      {spend.daysLeft !== null && (
        <p className={spend.warning ? 'font-medium text-warn' : 'text-text-muted'}>
          {t('spendIndicator.daysLeft', { count: spend.daysLeft })}
        </p>
      )}
      {spend.warning && (
        <p className="text-warn">
          {t(spend.binding === 'safety' ? 'spendIndicator.warningSafety' : 'spendIndicator.warningKey')}
        </p>
      )}
      {reading && (
        <p className="text-[11px] text-text-muted">
          {t('spendIndicator.readAt', { time: formatClockTime(reading.readAt) })}
        </p>
      )}
    </div>
  );
}

/** One reminder a local day, dismissed for the day; storage that fails shows it again (D246). */
const REMINDER_KEY = 'traders.spendReminderDismissedOn';

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function dismissedToday(): boolean {
  try {
    return window.localStorage.getItem(REMINDER_KEY) === today();
  } catch {
    return false;
  }
}

/**
 * D246's daily reminder: from five days before the key's projected depletion, a
 * line under the top bar to top up or replace the key - or raise the safety
 * limit, when that is what binds - dismissed for the rest of the day.
 */
export const SpendReminder = observer(function SpendReminder() {
  const { auth } = useStore();
  const { t } = useTranslation();
  const spend = useKeySpendQuery(auth.user !== null && auth.user?.role !== 'admin').data;
  const [dismissed, setDismissed] = useState(dismissedToday);
  if (!spend?.warning || spend.daysLeft === null || dismissed) return null;
  const dismiss = () => {
    try {
      window.localStorage.setItem(REMINDER_KEY, today());
    } catch {
      // A per-browser convenience: without storage it is dismissed for this page only.
    }
    setDismissed(true);
  };
  return (
    <div role="status" className="border-b border-warn/40 bg-warn/10">
      <div className="mx-auto flex max-w-7xl items-start gap-3 px-4 py-2 text-sm text-warn sm:px-6">
        <KeyRound className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p className="min-w-0 flex-1">
          {t(spend.binding === 'safety' ? 'spendIndicator.reminderSafety' : 'spendIndicator.reminderKey', {
            count: spend.daysLeft,
          })}{' '}
          <Link to="/settings" className="font-medium text-accent hover:underline">
            {t('spendIndicator.openSettings')}
          </Link>
        </p>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t('spendIndicator.dismiss')}
          title={t('spendIndicator.dismiss')}
          className="rounded p-0.5 hover:bg-warn/20"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
});
