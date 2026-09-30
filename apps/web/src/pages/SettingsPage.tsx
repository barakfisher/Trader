import type { ReactNode } from 'react';
import { observer } from 'mobx-react-lite';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, BellOff, Settings as SettingsIcon } from 'lucide-react';

import { Disclaimer } from '../components/Disclaimer.tsx';
import { TelegramConnect } from '../components/TelegramConnect.tsx';
import { Button, Card, ErrorNote, Spinner, buttonClass } from '../components/ui.tsx';
import {
  MUTE_PRESET_HOURS,
  describeMute,
  describeQuietHours,
  isMuted,
} from '../lib/notificationSchedule.ts';
import { SEVERITY_BANDS, SEVERITY_CHOICES, describeSeverityFloor } from '../lib/severityScale.ts';
import { formatClockTime, formatExactTime, getDisplayTimeZone } from '../lib/relativeTime.ts';
import {
  MAX_PROPOSAL_TTL_HOURS,
  MIN_PROPOSAL_TTL_HOURS,
} from '../stores/SettingsStore.ts';
import { errorMessage } from '../api/client.ts';
import { useSettingsQuery } from '../queries/settings.ts';
import { useStore } from '../stores/context.tsx';

/**
 * The settings page.
 *
 * Every control is a statement about this user's attention, so each one says
 * what it will cost them - a severity floor is meaningless without the bands
 * that produce it, and a TTL is meaningless without the reason proposals expire
 * at all. The severity table at the bottom is the reference those sentences
 * point at.
 *
 * The form edits a draft and saves the whole object at once, because the API
 * replaces the whole object. Nothing here writes on change: a settings page
 * that saves as you type turns a mistyped digit into a rule that is already in
 * force.
 */
export const SettingsPage = observer(function SettingsPage() {
  const { settings } = useStore();
  // Read on arrival, not at sign-in: settings are read when someone goes looking.
  const stored = useSettingsQuery();
  const draft = settings.draft;

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <SettingsIcon className="size-5 text-accent" aria-hidden />
          <h1 className="text-base font-semibold">Settings</h1>
          {settings.savedAt && !settings.isDirty && (
            <span className="text-xs text-text-muted">
              saved {formatClockTime(settings.savedAt)}
            </span>
          )}
        </div>
        <Link to="/" className={buttonClass('secondary')}>
          <span className="flex items-center gap-1">
            <ArrowLeft className="size-4" aria-hidden />
            Back to portfolio
          </span>
        </Link>
      </header>

      {stored.isPending && <Spinner label="Loading your settings…" />}

      {/* A failed read with nothing to show: the page has no settings, rather
          than a settings object that happens to be empty. A failed re-read
          after a good one keeps the form - and any edits in it. */}
      {stored.error && draft === null && (
        <ErrorNote
          message={errorMessage(stored.error, 'Could not load your settings.')}
          onRetry={() => void stored.refetch()}
        />
      )}

      {/* A failed save leaves the form and the typing in it; Save is the retry. */}
      {settings.error && <ErrorNote message={settings.error} />}

      {draft !== null && (
        <>
          <Card title="Proposals">
            <div className="space-y-4">
              <Field
                label="Ask me to decide when a finding is"
                hint={describeSeverityFloor(draft.proposalSeverity)}
              >
                <select
                  className="input"
                  aria-label="Ask me to decide when a finding is"
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
                label="Keep a proposal answerable for"
                hint="After this, the proposal expires. A decision taken against prices that have moved is a different decision from the one you were asked about."
              >
                <div className="flex items-center gap-2">
                  <input
                    className="input max-w-28"
                    type="number"
                    aria-label="Keep a proposal answerable for, in hours"
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
                    hours ({MIN_PROPOSAL_TTL_HOURS}–{MAX_PROPOSAL_TTL_HOURS})
                  </span>
                </div>
              </Field>
            </div>
          </Card>

          <Card title="Notifications">
            <div className="space-y-4">
              <Field
                label="Interrupt me when a finding is"
                hint={`${describeSeverityFloor(draft.notifySeverity)} This is a separate floor from the one above: what you must answer and what may interrupt you are different questions.`}
              >
                <select
                  className="input"
                  aria-label="Interrupt me when a finding is"
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
                label="Quiet hours"
                hint={`${describeQuietHours(draft.quietHoursStart, draft.quietHoursEnd)} Read in your own timezone, and a window that runs past midnight is normal.`}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={settings.quietHoursEnabled}
                      onChange={(event) => settings.setQuietHoursEnabled(event.target.checked)}
                    />
                    Silence pushes overnight
                  </label>
                  {settings.quietHoursEnabled && (
                    <div className="flex items-center gap-2">
                      <input
                        className="input max-w-32"
                        type="time"
                        aria-label="Quiet hours start"
                        value={draft.quietHoursStart ?? ''}
                        onChange={(event) =>
                          settings.setQuietHours(event.target.value, draft.quietHoursEnd ?? '')
                        }
                      />
                      <span className="text-sm text-text-muted">to</span>
                      <input
                        className="input max-w-32"
                        type="time"
                        aria-label="Quiet hours end"
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
                label="Mute"
                hint="A one-off silence, separate from quiet hours: nothing is pushed until it ends, whatever the severity."
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
                        {hours}h
                      </span>
                    </Button>
                  ))}
                  {isMuted(draft.mutedUntil) && (
                    <Button variant="ghost" onClick={settings.clearMute}>
                      Unmute
                    </Button>
                  )}
                  <span
                    className="text-sm text-text-muted"
                    title={
                      draft.mutedUntil ? `Ends ${formatExactTime(draft.mutedUntil)}` : undefined
                    }
                  >
                    {describeMute(draft.mutedUntil)}
                  </span>
                </div>
              </Field>
            </div>
          </Card>

          <Card title="Telegram">
            <TelegramConnect />
          </Card>

          <AccountCard />

          <Card title="What the severity levels mean">
            <p className="mb-3 text-sm text-text-muted">
              Severity is derived from the size of the finding, never chosen by a narrator. These
              are the default bands; an operator can retune them, and the feed always shows the
              figure a finding was judged on.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-text-muted">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Finding</th>
                    <th className="py-2 pr-3 font-medium">Info</th>
                    <th className="py-2 pr-3 font-medium">Notable</th>
                    <th className="py-2 font-medium">High</th>
                  </tr>
                </thead>
                <tbody>
                  {SEVERITY_BANDS.map((band) => (
                    <tr key={band.rule} className="border-t border-border-subtle">
                      <td className="py-2 pr-3">
                        <span className="text-text-primary">{band.rule}</span>
                        <span className="block text-xs text-text-muted">{band.measure}</span>
                      </td>
                      <td className="py-2 pr-3 text-text-muted">{band.info}</td>
                      <td className="py-2 pr-3 text-warn">{band.notable}</td>
                      <td className="py-2 text-loss">{band.high}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="flex flex-wrap items-center justify-end gap-3">
            {settings.blockingIssue && (
              <span className="mr-auto text-sm text-loss">{settings.blockingIssue}</span>
            )}
            {settings.isDirty && !settings.blockingIssue && (
              <span className="mr-auto text-sm text-text-muted">
                Unsaved changes. Nothing is in force until you save.
              </span>
            )}
            <Button variant="ghost" onClick={settings.discard} disabled={!settings.isDirty}>
              Discard
            </Button>
            <Button onClick={() => void settings.save()} disabled={!settings.canSave}>
              {settings.saving ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
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
 * What this installation fixes rather than asks: shown, so a reader knows what
 * every figure and time is in, and not offered as a choice (the user's decision,
 * 2026-09-29 - no schema or backend change in M6).
 */
const AccountCard = observer(function AccountCard() {
  const { auth } = useStore();
  const zone = getDisplayTimeZone();
  return (
    <Card title="Account">
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs uppercase tracking-wide text-text-muted">Base currency</dt>
          <dd className="font-medium">{auth.user?.baseCurrency ?? 'USD'}</dd>
          <dd className="text-xs text-text-muted">
            Every total, P&amp;L and weight is converted into it. Fixed in this version.
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-text-muted">Timezone</dt>
          <dd className="font-medium">{zone}</dd>
          <dd className="text-xs text-text-muted">
            Every time on screen is shown in it, and &ldquo;today&rdquo; - quiet hours, the daily
            summary, the daily snapshot - begins at midnight here.
          </dd>
        </div>
      </dl>
    </Card>
  );
});
