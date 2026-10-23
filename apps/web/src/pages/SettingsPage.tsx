import { useEffect, useState, type ReactNode } from 'react';
import { observer } from 'mobx-react-lite';
import { AtSign, BellOff, KeyRound, Settings as SettingsIcon } from 'lucide-react';

import { SAFETY_LIMIT_CEILING_MICRO_USD, type MonthlySpend } from '@traders/shared';

import { AccountResetCard } from '../components/AccountResetCard.tsx';
import { Disclaimer } from '../components/Disclaimer.tsx';
import { Drawer } from '../components/Drawer.tsx';
import { EmailChange } from '../components/EmailChange.tsx';
import { OwnLlmKeyForm } from '../components/OwnLlmKeyForm.tsx';
import { PasswordChange } from '../components/PasswordChange.tsx';
import { TelegramConnect } from '../components/TelegramConnect.tsx';
import { TimeZoneChange } from '../components/TimeZoneChange.tsx';
import { Button, Card, ErrorNote, Spinner } from '../components/ui.tsx';
import {
  MUTE_PRESET_HOURS,
  describeMute,
  describeQuietHours,
  isMuted,
} from '../lib/notificationSchedule.ts';
import { SEVERITY_BANDS, SEVERITY_CHOICES, describeSeverityFloor } from '../lib/severityScale.ts';
import { dollarsTextToMicro, formatMicroUsd, microToDollarsText } from '../lib/llmCalls.ts';
import { formatResetDate } from '../lib/monthlyCap.ts';
import { formatClockTime, formatExactTime, getDisplayTimeZone } from '../lib/relativeTime.ts';
import {
  MAX_PROPOSAL_TTL_HOURS,
  MIN_PROPOSAL_TTL_HOURS,
} from '../stores/SettingsStore.ts';
import { errorMessage } from '../api/client.ts';
import { LANGUAGES, useTranslation, type Language } from '../i18n/index.ts';
import { useMonthlySpendQuery, useOwnLlmKeyQuery, useSetSafetyLimit, useSettingsQuery } from '../queries/settings.ts';
import { useStore } from '../stores/context.tsx';

/**
 * The settings page.
 *
 * Every control is a statement about this user's attention, so each one says
 * what it will cost them - a severity floor is meaningless without the bands
 * that produce it, and a TTL is meaningless without the reason proposals expire
 * at all. The severity bands, folded under the proposals card, are the
 * reference those sentences point at.
 *
 * The form edits a draft and saves the whole object at once, because the API
 * replaces the whole object. Nothing here writes on change: a settings page
 * that saves as you type turns a mistyped digit into a rule that is already in
 * force.
 */
export const SettingsPage = observer(function SettingsPage() {
  const { settings } = useStore();
  const { t } = useTranslation();
  // Read on arrival, not at sign-in: settings are read when someone goes looking.
  const stored = useSettingsQuery();
  const draft = settings.draft;

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <SettingsIcon className="size-5 text-accent" aria-hidden />
          <h1 className="text-base font-semibold">{t('settings.title')}</h1>
          {settings.savedAt && !settings.isDirty && (
            <span className="text-xs text-text-muted">
              {t('settings.saved', { time: formatClockTime(settings.savedAt) })}
            </span>
          )}
        </div>
      </header>

      {stored.isPending && <Spinner label={t('settings.loading')} />}

      {/* A failed read with nothing to show: the page has no settings, rather
          than a settings object that happens to be empty. A failed re-read
          after a good one keeps the form - and any edits in it. */}
      {stored.error && draft === null && (
        <ErrorNote
          message={errorMessage(stored.error, t('settings.loadFailed'))}
          onRetry={() => void stored.refetch()}
        />
      )}

      {/* A failed save leaves the form and the typing in it; Save is the retry. */}
      {settings.error && <ErrorNote message={settings.error} />}

      {draft !== null && (
        <>
          <Card title={t('settings.language')}>
            <Field label={t('settings.interfaceLanguage')} hint={t('settings.languageHint')}>
              <select
                className="input max-w-60"
                aria-label={t('settings.interfaceLanguage')}
                value={draft.language}
                onChange={(event) => settings.setLanguage(event.target.value as Language)}
              >
                {LANGUAGES.map((language) => (
                  // Each name in its own language and direction: someone who
                  // cannot read the current one can still find their own.
                  <option key={language} value={language} lang={language}>
                    {t(`languages.${language}`)}
                  </option>
                ))}
              </select>
            </Field>
          </Card>

          <Card title={t('settings.proposals')}>
            <div className="space-y-4">
              <Field
                label={t('settings.proposalFloor')}
                hint={describeSeverityFloor(draft.proposalSeverity)}
              >
                <select
                  className="input"
                  aria-label={t('settings.proposalFloor')}
                  value={draft.proposalSeverity}
                  onChange={(event) =>
                    settings.setProposalSeverity(
                      event.target.value as typeof draft.proposalSeverity,
                    )
                  }
                >
                  {SEVERITY_CHOICES.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                label={t('settings.ttl')}
                hint={t('settings.ttlHint')}
              >
                <div className="flex items-center gap-2">
                  <input
                    className="input max-w-28"
                    type="number"
                    aria-label={t('settings.ttlInHours')}
                    inputMode="numeric"
                    min={MIN_PROPOSAL_TTL_HOURS}
                    max={MAX_PROPOSAL_TTL_HOURS}
                    step={1}
                    value={draft.proposalTtlHours}
                    onChange={(event) =>
                      settings.setProposalTtlHours(Number(event.target.value))
                    }
                  />
                  <span className="text-sm text-text-muted">
                    {t('settings.ttlRange', { min: MIN_PROPOSAL_TTL_HOURS, max: MAX_PROPOSAL_TTL_HOURS })}
                  </span>
                </div>
              </Field>
              <details className="text-sm">
                <summary className="cursor-pointer text-text-muted">{t('settings.severityTitle')}</summary>
                <p className="mb-3 mt-2 text-xs text-text-muted">{t('settings.severityIntro')}</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-start text-xs uppercase tracking-wide text-text-muted">
                      <tr>
                        <th className="py-2 pe-3 font-medium">{t('settings.finding')}</th>
                        <th className="py-2 pe-3 font-medium">{t('severity.labels.info')}</th>
                        <th className="py-2 pe-3 font-medium">{t('severity.labels.notable')}</th>
                        <th className="py-2 font-medium">{t('severity.labels.high')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {SEVERITY_BANDS.map((band) => (
                        <tr key={band.rule} className="border-t border-border-subtle">
                          <td className="py-2 pe-3">
                            <span className="text-text-primary">{band.rule}</span>
                            <span className="block text-xs text-text-muted">{band.measure}</span>
                          </td>
                          <td className="py-2 pe-3 text-text-muted">{band.info}</td>
                          <td className="py-2 pe-3 text-warn">{band.notable}</td>
                          <td className="py-2 text-loss">{band.high}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </div>
          </Card>

          <Card title={t('settings.notifications')}>
            <div className="space-y-4">
              <Field
                label={t('settings.notifyFloor')}
                hint={t('settings.notifyFloorHint', { floor: describeSeverityFloor(draft.notifySeverity) })}
              >
                <select
                  className="input"
                  aria-label={t('settings.notifyFloor')}
                  value={draft.notifySeverity}
                  onChange={(event) =>
                    settings.setNotifySeverity(event.target.value as typeof draft.notifySeverity)
                  }
                >
                  {SEVERITY_CHOICES.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                label={t('settings.quietHours')}
                hint={t('settings.quietHoursHint', {
                  window: describeQuietHours(draft.quietHoursStart, draft.quietHoursEnd),
                })}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={settings.quietHoursEnabled}
                      onChange={(event) => settings.setQuietHoursEnabled(event.target.checked)}
                    />
                    {t('settings.silenceOvernight')}
                  </label>
                  {settings.quietHoursEnabled && (
                    <div className="flex items-center gap-2">
                      <input
                        className="input max-w-32"
                        type="time"
                        aria-label={t('settings.quietStart')}
                        value={draft.quietHoursStart ?? ''}
                        onChange={(event) =>
                          settings.setQuietHours(event.target.value, draft.quietHoursEnd ?? '')
                        }
                      />
                      <span className="text-sm text-text-muted">{t('settings.quietTo')}</span>
                      <input
                        className="input max-w-32"
                        type="time"
                        aria-label={t('settings.quietEnd')}
                        value={draft.quietHoursEnd ?? ''}
                        onChange={(event) =>
                          settings.setQuietHours(draft.quietHoursStart ?? '', event.target.value)
                        }
                      />
                    </div>
                  )}
                </div>
              </Field>

              <Field
                label={t('settings.mute')}
                hint={t('settings.muteHint')}
              >
                <div className="flex flex-wrap items-center gap-2">
                  {MUTE_PRESET_HOURS.map((hours) => (
                    <Button
                      key={hours}
                      variant="secondary"
                      onClick={() => settings.muteFor(hours)}
                    >
                      <span className="flex items-center gap-1">
                        <BellOff className="size-4" aria-hidden />
                        {t('duration.hours', { count: hours })}
                      </span>
                    </Button>
                  ))}
                  {isMuted(draft.mutedUntil) && (
                    <Button variant="ghost" onClick={settings.clearMute}>
                      {t('settings.unmute')}
                    </Button>
                  )}
                  <span
                    className="text-sm text-text-muted"
                    title={
                      draft.mutedUntil
                        ? t('settings.muteEnds', { when: formatExactTime(draft.mutedUntil) })
                        : undefined
                    }
                  >
                    {describeMute(draft.mutedUntil)}
                  </span>
                </div>
              </Field>
            </div>
          </Card>

          <Card title={t('settings.telegram')}>
            <TelegramConnect />
          </Card>

          <AccountCard />

          <SpendCard />

          <SignInCard />

          <div className="flex flex-wrap items-center justify-end gap-3">
            {settings.blockingIssue && (
              <span className="me-auto text-sm text-loss">{settings.blockingIssue}</span>
            )}
            {settings.isDirty && !settings.blockingIssue && (
              <span className="me-auto text-sm text-text-muted">
                {t('settings.unsaved')}
              </span>
            )}
            <Button variant="ghost" onClick={settings.discard} disabled={!settings.isDirty}>
              {t('settings.discard')}
            </Button>
            <Button onClick={() => void settings.save()} disabled={!settings.canSave}>
              {settings.saving ? t('settings.saving') : t('settings.saveChanges')}
            </Button>
          </div>

          {/* Last, below the save bar: it acts at once and erases, so it is never part of "Save changes". */}
          <AccountResetCard />
        </>
      )}

      <Disclaimer />
    </div>
  );
});

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <span className="block text-sm font-medium text-text-primary">{label}</span>
      {children}
      <p className="max-w-2xl text-xs text-text-muted">{hint}</p>
    </div>
  );
}

/**
 * The address this account signs in with, and the two changes it allows. Each
 * form opens on demand: both are rare, both ask for the current password, and
 * as standing cards they took more of the page than any setting a person
 * actually tunes.
 */
const SignInCard = observer(function SignInCard() {
  const { auth } = useStore();
  const { t } = useTranslation();
  const [open, setOpen] = useState<'email' | 'password' | null>(null);
  const close = () => setOpen(null);
  return (
    <Card title={t('settings.signIn')}>
      <p className="mb-3 text-sm">
        <span className="text-text-muted">{t('email.current')} </span>
        {auth.user?.email ? (
          <bdi dir="ltr" className="font-medium">
            {auth.user.email}
          </bdi>
        ) : (
          <span className="text-text-muted">{t('email.none')}</span>
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => setOpen('email')}>
          <span className="flex items-center gap-1">
            <AtSign className="size-4" aria-hidden />
            {t('email.save')}
          </span>
        </Button>
        <Button variant="secondary" onClick={() => setOpen('password')}>
          <span className="flex items-center gap-1">
            <KeyRound className="size-4" aria-hidden />
            {t('password.save')}
          </span>
        </Button>
      </div>
      {open === 'email' && (
        <Drawer title={t('email.save')} closeLabel={t('common.close')} onClose={close}>
          <EmailChange />
        </Drawer>
      )}
      {open === 'password' && (
        <Drawer title={t('password.save')} closeLabel={t('common.close')} onClose={close}>
          <PasswordChange />
        </Drawer>
      )}
    </Card>
  );
});

/**
 * What this installation fixes rather than asks: shown, so a reader knows what
 * every figure and time is in, and not offered as a choice (the user's decision,
 * 2026-09-29 - no schema or backend change in M6).
 */
/**
 * The user's own OpenRouter key (D206), which every model call of theirs runs on
 * and nothing replaces (D245), then what this app spent on it this month and
 * their optional monthly safety limit (D250). The admin runs on the
 * installation's key and sees neither card; a failed read shows nothing rather
 * than a guess.
 */
function SpendCard() {
  const { t } = useTranslation();
  const spend = useMonthlySpendQuery().data;
  const ownKey = useOwnLlmKeyQuery(Boolean(spend)).data;
  if (!spend) return null;
  return (
    <>
      {ownKey && (
        <Card title={t('settings.ownKey.title')}>
          <OwnLlmKeyForm available={ownKey.available} saved={ownKey.key} />
        </Card>
      )}
      <Card title={t('settings.spend.title')}>
        <p className="text-sm font-medium">
          <bdi>{t('settings.spend.ownKeyLine', { spent: formatMicroUsd(spend.ownKeySpentMicroUsd) })}</bdi>
        </p>
        <p className="mt-1 max-w-2xl text-xs text-text-muted">{t('settings.spend.hint')}</p>
        <SafetyLimitForm spend={spend} />
      </Card>
    </>
  );
}

/**
 * The user's own monthly brake on what this app spends on their key (D250):
 * optional, in dollars and cents, cleared by *Remove limit*. Reaching it stops
 * scans, questions and explanations by the model until the month resets.
 */
/** The smallest limit the field takes: a cent, the finest step dollars and cents can type. */
const MICRO_USD_PER_CENT = 10_000;

function SafetyLimitForm({ spend }: { spend: MonthlySpend }) {
  const { t } = useTranslation();
  const save = useSetSafetyLimit();
  const stored = spend.safetyLimitMicroUsd === null ? '' : microToDollarsText(spend.safetyLimitMicroUsd);
  const [draft, setDraft] = useState(stored);
  useEffect(() => setDraft(stored), [stored]);
  const micro = dollarsTextToMicro(draft);
  const valid = micro !== null && micro >= MICRO_USD_PER_CENT && micro <= SAFETY_LIMIT_CEILING_MICRO_USD;
  const limit = spend.safetyLimitMicroUsd;
  const reached = limit !== null && spend.ownKeySpentMicroUsd >= limit;
  return (
    <div className="mt-4 space-y-2 border-t border-border-subtle pt-4">
      <p className="text-sm font-medium">{t('settings.safetyLimit.title')}</p>
      <p className="max-w-2xl text-xs text-text-muted">{t('settings.safetyLimit.intro')}</p>
      {limit !== null && (
        <p className={`text-sm ${reached ? 'text-warn' : ''}`} role={reached ? 'status' : undefined}>
          <bdi>
            {t(reached ? 'settings.safetyLimit.reached' : 'settings.safetyLimit.line', {
              spent: formatMicroUsd(spend.ownKeySpentMicroUsd),
              limit: formatMicroUsd(limit),
              date: formatResetDate(spend.resetsOn),
            })}
          </bdi>
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) save.mutate(micro);
        }}
        className="flex flex-wrap items-end gap-2"
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs text-text-muted">{t('settings.safetyLimit.label')}</span>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            inputMode="decimal"
            dir="ltr"
            aria-invalid={draft !== '' && !valid}
            className="w-28 rounded-md border border-border-subtle bg-surface px-3 py-2 text-start"
          />
        </label>
        <Button type="submit" disabled={!valid || draft === stored || save.isPending}>
          {t('settings.safetyLimit.save')}
        </Button>
        {limit !== null && (
          <Button variant="ghost" disabled={save.isPending} onClick={() => save.mutate(null)}>
            {t('settings.safetyLimit.remove')}
          </Button>
        )}
      </form>
      <p className="text-xs text-text-muted">
        {t('settings.safetyLimit.bounds', {
          min: formatMicroUsd(MICRO_USD_PER_CENT),
          max: formatMicroUsd(SAFETY_LIMIT_CEILING_MICRO_USD),
        })}
      </p>
      {save.error && <ErrorNote message={errorMessage(save.error, t('settings.safetyLimit.failed'))} />}
    </div>
  );
}

const AccountCard = observer(function AccountCard() {
  const { auth } = useStore();
  const { t } = useTranslation();
  return (
    <Card title={t('settings.account')}>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs uppercase tracking-wide text-text-muted">{t('settings.baseCurrency')}</dt>
          <dd className="font-medium">{auth.user?.baseCurrency ?? 'USD'}</dd>
          <dd className="text-xs text-text-muted">
            {t('settings.baseCurrencyNote')}
          </dd>
        </div>
      </dl>
      <div className="mt-4">
        <TimeZoneChange />
      </div>
    </Card>
  );
});
