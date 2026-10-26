import { useState, type FormEvent } from 'react';
import { observer } from 'mobx-react-lite';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { ShieldCheck } from 'lucide-react';

import {
  ASSISTANT_DAILY_BUDGET_CEILING_MICRO_USD,
  DAILY_NEW_ACCOUNTS_CEILING,
  MAX_AGENTS_PER_USER_CEILING,
  MAX_PENDING_SIGNUPS_CEILING,
  SIGNUP_MODES,
  type SignupMode,
  type AdminUserView,
  type SignupRequestView,
} from '@traders/shared';
import type {
  AdminAuditEntry,
  AdminLlmModelsResponse,
  LlmOfferedModelView,
  LlmScope,
  AdminRun,
  LlmPurposeSummary,
  LlmCallSummary,
  LlmPanelResponse,
  UniverseGap,
  UniverseReconciliation,
} from '@traders/shared';

import { errorMessage } from '../api/client.ts';
import { formatNumber } from '../i18n/format.ts';
import { t as translate, useTranslation } from '../i18n/index.ts';
import { AdminKeysCard } from '../components/AdminKeysCard.tsx';
import { Button, Card, EmptyState, ErrorNote, Spinner } from '../components/ui.tsx';
import {
  LLM_WINDOWS,
  OUTCOME_LABEL,
  VERDICT_LABEL,
  purposeCost,
  callCost,
  decimalUsdToMicro,
  formatPerMtok,
  dollarsTextToMicro,
  formatLatency,
  formatMicroUsd,
  microToDollarsText,
  nonZero,
  reasonLabel,
} from '../lib/llmCalls.ts';
import { useDraft } from '../lib/draft.ts';
import { formatAge, formatExactTime } from '../lib/relativeTime.ts';
import { gapExplanation, gapProfile, gapSubject, isRealGap } from '../lib/universeGaps.ts';
import {
  useAdminAuditQuery,
  useAdminGapsQuery,
  useAdminLlmModelsQuery,
  useAdminLlmQuery,
  useAdminRunsQuery,
  useAdminSettingsQuery,
  useAdminSignupsQuery,
  useAdminUniverseQuery,
  useAdminUsersQuery,
  useChooseLlmModel,
  useDecideSignup,
  useOneTimePassword,
  useRescreen,
  useSetUserStatus,
  useUpdateAdminSettings,
} from '../queries/admin.ts';
import { useStore } from '../stores/context.tsx';

const STATUS_TONE: Record<string, string> = {
  ok: 'text-gain',
  degraded: 'text-warn',
  failed: 'text-loss',
  running: 'text-accent',
  skipped: 'text-text-muted',
};

/**
 * The installation's operations page (M8). Admin sections are added here as
 * the milestone builds them; this first one answers "did the scheduled work
 * happen?" for every account and for none.
 *
 * The page hides itself from a non-admin, but that is courtesy, not security:
 * the server refuses every `/admin/*` request from one (decision 83), and this
 * page would show that refusal as an error rather than any data.
 */
/**
 * The page's four tabs (M10 decision 20): who uses the installation, which
 * models and keys it runs on, what its scheduled work did, and its settings.
 * The tab is in the address (`?tab=`), so a link opens it.
 */
export const ADMIN_TABS = ['users', 'models', 'operations', 'settings'] as const;
export type AdminTab = (typeof ADMIN_TABS)[number];

export function adminTabFrom(search: unknown): AdminTab {
  const value = ((search ?? {}) as Record<string, unknown>).tab;
  return (ADMIN_TABS as readonly unknown[]).includes(value) ? (value as AdminTab) : 'users';
}

export const AdminPage = observer(function AdminPage() {
  const { auth } = useStore();
  const { t } = useTranslation();
  const isAdmin = auth.user?.role === 'admin';
  const navigate = useNavigate();
  const tab = adminTabFrom(useSearch({ strict: false }));
  const setTab = (next: AdminTab) =>
    void navigate({ to: '/admin', search: { tab: next === 'users' ? undefined : next }, replace: true });

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-accent" aria-hidden />
          <h1 className="text-base font-semibold">{t('admin.title')}</h1>
        </div>
      </header>

      {isAdmin ? (
        <>
          <div role="tablist" className="flex gap-2 overflow-x-auto border-b border-border-subtle">
            {ADMIN_TABS.map((name) => (
              <button
                key={name}
                role="tab"
                type="button"
                aria-selected={tab === name}
                onClick={() => setTab(name)}
                className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm ${
                  tab === name ? 'border-accent text-text-primary' : 'border-transparent text-text-muted'
                }`}
              >
                {t(`admin.tabs.${name}`)}
              </button>
            ))}
          </div>
          {tab === 'users' && (
            <>
              <SignupRequestsCard />
              <UsersCard />
            </>
          )}
          {tab === 'models' && (
            <>
              <ModelsCard />
              <AdminKeysCard />
            </>
          )}
          {tab === 'operations' && (
            <>
              <RunsCard />
              <GapsCard />
              <UniverseCard />
              <LlmCard />
              <AuditCard />
            </>
          )}
          {tab === 'settings' && (
            <>
              <AgentLimitCard />
              <AssistantLimitCard />
              <SignupSettingsCard />
            </>
          )}
        </>
      ) : (
        <EmptyState
          title={t('admin.onlyTitle')}
          body={t('admin.onlyBody')}
        />
      )}
    </div>
  );
});

function RunsCard() {
  const runs = useAdminRunsQuery();
  const { t } = useTranslation();

  return (
    <Card title={t('admin.runs')}>
      {runs.isPending && <Spinner label={t('admin.runsLoading')} />}
      {runs.error && (
        <ErrorNote
          message={errorMessage(runs.error, t('admin.runsFailed'))}
          onRetry={() => void runs.refetch()}
        />
      )}
      {runs.data && runs.data.runs.length === 0 && (
        <p className="text-sm text-text-muted">{t('admin.runsEmpty')}</p>
      )}
      {runs.data && runs.data.runs.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-start text-sm">
            <thead className="text-xs text-text-muted">
              <tr>
                <th className="py-2 pe-3 font-medium">{t('admin.runColumns.kind')}</th>
                <th className="py-2 pe-3 font-medium">{t('admin.runColumns.status')}</th>
                <th className="py-2 pe-3 font-medium">{t('admin.runColumns.started')}</th>
                <th className="py-2 pe-3 font-medium">{t('admin.runColumns.took')}</th>
                <th className="py-2 pe-3 font-medium">{t('admin.runColumns.trigger')}</th>
                <th className="py-2 font-medium">{t('admin.runColumns.runKey')}</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.runs.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function RunRow({ run }: { run: AdminRun }) {
  return (
    <tr className="border-t border-border-subtle">
      <td className="py-2 pe-3">{run.kind}</td>
      <td className={`py-2 pe-3 ${STATUS_TONE[run.status] ?? ''}`}>{run.status}</td>
      <td className="py-2 pe-3 whitespace-nowrap" title={formatExactTime(run.startedAt)}>
        {formatAge(run.startedAt)}
      </td>
      <td className="py-2 pe-3 whitespace-nowrap">{duration(run)}</td>
      <td className="py-2 pe-3">{run.trigger}</td>
      <td className="py-2 break-all font-mono text-xs text-text-muted">{run.runKey}</td>
    </tr>
  );
}

/** A count as the locale groups it: "5,223". */
const count = { format: (value: number) => formatNumber(value) };

/**
 * The universe: the snapshot the loader last read, what the database holds,
 * and each difference named by the loader. Only a remainder nobody explained
 * is shown as a problem.
 */
function UniverseCard() {
  const universe = useAdminUniverseQuery();
  const data = universe.data;
  const { t } = useTranslation();

  return (
    <Card title={t('admin.universe')}>
      <RescreenControl />
      {universe.isPending && <Spinner label={t('admin.universeLoading')} />}
      {universe.error && (
        <ErrorNote
          message={errorMessage(universe.error, t('admin.universeFailed'))}
          onRetry={() => void universe.refetch()}
        />
      )}
      {data && (
        <div className="space-y-3 text-sm">
          <p>
            {t('admin.profiled', {
              profiles: count.format(data.database.profiles),
              equities: count.format(data.database.equities),
              etfs: count.format(data.database.etfs),
              embedded: count.format(data.database.embedded),
              holdings: count.format(data.database.etfHoldings),
            })}
          </p>
          {data.database.dropped > 0 && (
            <p className="text-text-muted">
              {t('admin.dropped', { value: count.format(data.database.dropped) })}
            </p>
          )}
          {data.database.onDemand > 0 && (
            <p className="text-text-muted">
              {t('admin.onDemand', { value: count.format(data.database.onDemand) })}
            </p>
          )}
          {data.lastLoad ? (
            <p className="text-text-muted">
              {t('admin.lastLoad', {
                snapshot: formatExactTime(data.lastLoad.snapshotAsOf),
                age: formatAge(data.lastLoad.loadedAt),
              })}
            </p>
          ) : (
            <p className="text-warn">
              {t('admin.noLoad')}
            </p>
          )}
          {data.reconciliation.map((row) => (
            <ReconciliationRow key={row.what} row={row} />
          ))}
        </div>
      )}
    </Card>
  );
}

/**
 * Rescreen now. Asked twice, because it rewrites what every topic resolves
 * against: listings cross the size floor both ways, and a member the new
 * screen lacks is marked dropped. The answer says where to follow the run.
 */
function RescreenControl() {
  const rescreen = useRescreen();
  const [confirming, setConfirming] = useState(false);
  const result = rescreen.data;
  const { t } = useTranslation();

  return (
    <div className="mb-3 space-y-2 border-b border-border-subtle pb-3 text-sm">
      {!confirming ? (
        <Button variant="secondary" onClick={() => setConfirming(true)} disabled={rescreen.isPending}>
          {t('admin.rescreen')}
        </Button>
      ) : (
        <div className="space-y-2">
          <p>
            {t('admin.rescreenWarning')}
          </p>
          <div className="flex gap-2">
            <Button
              onClick={() => {
                setConfirming(false);
                rescreen.mutate();
              }}
            >
              {t('admin.rescreenNow')}
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}
      {rescreen.isPending && <Spinner label={t('admin.rescreenStarting')} />}
      {rescreen.error && (
        <ErrorNote message={errorMessage(rescreen.error, t('admin.rescreenFailed'))} />
      )}
      {result?.status === 'running' && (
        <p className="text-text-muted">
          {t('admin.rescreenStarted', { runKey: result.runKey })}
        </p>
      )}
      {result?.status === 'skipped' && (
        <p className="text-warn">{t('admin.rescreenSkipped', { reason: result.reason })}</p>
      )}
    </div>
  );
}

function ReconciliationRow({ row }: { row: UniverseReconciliation }) {
  const { t } = useTranslation();
  return (
    <div>
      <p className="font-medium">
        {t('admin.reconciliation', {
          what: t(`admin.reconciled.${row.what}`),
          snapshot: count.format(row.inSnapshot),
          database: count.format(row.inDatabase),
        })}
      </p>
      <ul className="ms-4 list-disc text-text-muted">
        {row.explained.map((difference) => (
          <li key={difference.reason}>
            {t('admin.explained', { value: count.format(difference.count), reason: difference.reason })}
          </li>
        ))}
        {row.unexplained !== 0 && (
          <li className="text-warn">
            {row.unexplained > 0
              ? t('admin.missingFrom', { value: count.format(row.unexplained) })
              : t('admin.moreIn', { value: count.format(-row.unexplained) })}
          </li>
        )}
      </ul>
    </div>
  );
}

/**
 * What users asked for that the universe could not give them. A gap a
 * rescreen could close is marked; one the screen excludes by rule is listed
 * for completeness, because "we never screen crypto" is an answer too.
 */
function GapsCard() {
  const gaps = useAdminGapsQuery();
  const { t } = useTranslation();

  return (
    <Card title={t('admin.gaps')}>
      {gaps.isPending && <Spinner label={t('admin.gapsLoading')} />}
      {gaps.error && (
        <ErrorNote
          message={errorMessage(gaps.error, t('admin.gapsFailed'))}
          onRetry={() => void gaps.refetch()}
        />
      )}
      {gaps.data && gaps.data.gaps.length === 0 && (
        <p className="text-sm text-text-muted">
          {t('admin.gapsEmpty')}
        </p>
      )}
      {gaps.data && gaps.data.gaps.length > 0 && (
        <ul className="divide-y divide-border-subtle text-sm">
          {gaps.data.gaps.map((gap) => (
            <GapItem key={gap.id} gap={gap} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function GapItem({ gap }: { gap: UniverseGap }) {
  const real = isRealGap(gap);
  const { t } = useTranslation();
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-2 py-2">
      <span className="min-w-0">
        <span className={`font-medium ${real ? 'text-warn' : ''}`}>{gapSubject(gap)}</span>
        <span className="ms-2 text-text-muted">{gapExplanation(gap)}</span>
        {gapProfile(gap) && <span className="block text-xs text-text-muted">{gapProfile(gap)}</span>}
      </span>
      <span className="text-xs text-text-muted" title={formatExactTime(gap.lastSeenAt)}>
        {gap.occurrences > 1 ? t('admin.occurrences', { count: gap.occurrences }) : ''}
        {formatAge(gap.lastSeenAt)}
      </span>
    </li>
  );
}

/**
 * Every model call, per purpose, and narration's fallback reasons counted
 * against the calls behind them (decision 87). Cost says "free route" where a
 * zero is the price. What is not measured is said, not shown as zero.
 */
/**
 * Which model narration, `/ask` and agents use, and what each choice would cost
 * (D43, D44). Changing the selection shows that model's estimate before anything
 * is saved; saving is an audited admin action. The balance beside the totals
 * answers "how much should I add to the account".
 */
/**
 * Sign-up requests (D156, D188), first on the page because someone is waiting
 * on each. A waiting request is approved - with no amount: users run on their
 * own key only (D245, D279) - or rejected; a rejection can be undone, which
 * puts the request back to waiting. A request already decided
 * in Telegram simply leaves the list when it is read again.
 */
function SignupRequestsCard() {
  const { t } = useTranslation();
  const signups = useAdminSignupsQuery();
  return (
    <Card title={t('admin.signups.title')}>
      {signups.isPending && <Spinner label={t('admin.signups.title')} />}
      {signups.error && <ErrorNote message={errorMessage(signups.error, t('admin.signups.title'))} />}
      {signups.data && (
        <div className="space-y-3 text-sm">
          {signups.data.pending.length === 0 ? (
            <p className="text-text-muted">{t('admin.signups.none')}</p>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {signups.data.pending.map((request) => (
                <PendingSignup key={request.userId} request={request} />
              ))}
            </ul>
          )}
          {signups.data.rejected.length > 0 && (
            <details>
              <summary className="cursor-pointer text-text-muted">
                {t('admin.signups.rejected', { count: signups.data.rejected.length })}
              </summary>
              <ul className="mt-2 divide-y divide-border-subtle">
                {signups.data.rejected.map((request) => (
                  <RejectedSignup key={request.userId} request={request} />
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * The accounts (D162, D239): status, this month's spend, own key and last
 * sign-in - operations only, never a user's finances. Each user can be
 * disabled (signed out at once, data kept) and enabled again, have their cap
 * changed, or be given a one-time password, shown here once to pass on. The
 * admin's own row has none of these: the admin is never disabled or capped,
 * and a forgotten admin password is `scripts/admin-password.sh`'s.
 */
function UsersCard() {
  const { t } = useTranslation();
  const users = useAdminUsersQuery();
  return (
    <Card title={t('admin.users.title')}>
      {users.isPending && <Spinner label={t('admin.users.title')} />}
      {users.error && <ErrorNote message={errorMessage(users.error, t('admin.users.failed'))} />}
      {users.data && (
        <ul className="divide-y divide-border-subtle text-sm">
          {users.data.users.map((user) => (
            <UserRow key={user.userId} user={user} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function UserRow({ user }: { user: AdminUserView }) {
  const { t } = useTranslation();
  const status = useSetUserStatus();
  const oneTime = useOneTimePassword();
  const isAdmin = user.role === 'admin';
  const error = status.error ?? oneTime.error;

  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <bdi dir="ltr" className="block truncate font-medium">
            {user.email ?? t('admin.users.noEmail')}
          </bdi>
          <span className="text-xs text-text-muted">
            {t(`admin.users.role.${user.role}`)} · {t(`admin.users.status.${user.status}`)} ·{' '}
            <bdi dir="ltr">{user.timezone}</bdi> ·{' '}
            {user.lastSignInAt
              ? t('admin.users.lastSignIn', { age: formatAge(user.lastSignInAt) })
              : t('admin.users.neverSignedIn')}
          </span>
        </div>
        <span className="text-xs text-text-muted">
          <bdi>
            {t(isAdmin ? 'admin.users.spentInstallation' : 'admin.users.spentOwnKey', {
              spent: formatMicroUsd(user.spentThisMonthMicroUsd),
            })}
          </bdi>
          {' · '}
          {t(`admin.users.ownKey.${user.ownKey}`)}
        </span>
      </div>
      {!isAdmin && (
        <div className="flex flex-wrap items-end gap-2">
          <Button
            variant="secondary"
            disabled={oneTime.isPending}
            onClick={() => oneTime.mutate({ userId: user.userId })}
          >
            {t('admin.users.oneTimePassword')}
          </Button>
          <Button
            variant={user.status === 'active' ? 'danger' : 'secondary'}
            disabled={status.isPending}
            onClick={() =>
              status.mutate({ userId: user.userId, action: user.status === 'active' ? 'disable' : 'enable' })
            }
          >
            {user.status === 'active' ? t('admin.users.disable') : t('admin.users.enable')}
          </Button>
        </div>
      )}
      {oneTime.data && (
        <p className="rounded-md border border-border-subtle bg-surface p-2">
          <span className="block text-xs text-text-muted">{t('admin.users.oneTimeShown')}</span>
          <code dir="ltr" className="select-all font-mono text-base">
            {oneTime.data.password}
          </code>
        </p>
      )}
      {error && <ErrorNote message={errorMessage(error, t('admin.users.failed'))} />}
    </li>
  );
}

function SignupWho({ request }: { request: SignupRequestView }) {
  const { t } = useTranslation();
  return (
    <div className="min-w-0">
      <bdi dir="ltr" className="block truncate font-medium">{request.email}</bdi>
      <span className="text-xs text-text-muted" title={formatExactTime(request.requestedAt)}>
        {t('admin.signups.asked', { age: formatAge(request.requestedAt) })} · <bdi dir="ltr">{request.timezone}</bdi>
      </span>
    </div>
  );
}

function PendingSignup({ request }: { request: SignupRequestView }) {
  const { t } = useTranslation();
  const decide = useDecideSignup();
  return (
    <li className="flex flex-wrap items-end justify-between gap-3 py-2">
      <SignupWho request={request} />
      <div className="flex flex-wrap items-end gap-2">
        <Button
          disabled={decide.isPending}
          onClick={() => decide.mutate({ userId: request.userId, action: 'approve' })}
        >
          {t('admin.signups.approve')}
        </Button>
        <Button
          variant="secondary"
          disabled={decide.isPending}
          onClick={() => decide.mutate({ userId: request.userId, action: 'reject' })}
        >
          {t('admin.signups.reject')}
        </Button>
      </div>
      {decide.error && <ErrorNote message={errorMessage(decide.error, t('admin.signups.title'))} />}
    </li>
  );
}

function RejectedSignup({ request }: { request: SignupRequestView }) {
  const { t } = useTranslation();
  const decide = useDecideSignup();
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-2">
      <SignupWho request={request} />
      <Button
        variant="ghost"
        disabled={decide.isPending}
        onClick={() => decide.mutate({ userId: request.userId, action: 'restore' })}
      >
        {t('admin.signups.undo')}
      </Button>
      {decide.error && <ErrorNote message={errorMessage(decide.error, t('admin.signups.title'))} />}
    </li>
  );
}

/**
 * How strangers get in (D243): the mode - *automatic* once the address is
 * verified, *approval* by the admin after verification, or *closed* - the
 * daily limit on automatic accounts, beyond which a verified sign-up waits for
 * the admin (D305), and how many verified requests may wait at once (D156).
 * Without outbound mail no address can be verified, so nobody can sign up
 * whatever the mode, and *automatic* is not offered (D259). Users run on their
 * own key only (D245).
 */
function SignupSettingsCard() {
  const { t } = useTranslation();
  const settings = useAdminSettingsQuery();
  const update = useUpdateAdminSettings();
  const storedMode: SignupMode = settings.data?.signupMode ?? 'approval';
  const [mode, setMode] = useDraft(storedMode);
  const storedDaily = settings.data ? String(settings.data.dailyNewAccountsLimit) : '';
  const [daily, setDaily] = useDraft(storedDaily);
  const storedMax = settings.data ? String(settings.data.maxPendingSignups) : '';
  const [max, setMax] = useDraft(storedMax);
  const dailyValid = /^\d+$/.test(daily) && Number(daily) <= DAILY_NEW_ACCOUNTS_CEILING;
  const maxValid = /^\d+$/.test(max) && Number(max) <= MAX_PENDING_SIGNUPS_CEILING;
  const unchanged = mode === storedMode && daily === storedDaily && max === storedMax;
  const emailConfigured = settings.data?.emailConfigured ?? false;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (dailyValid && maxValid) {
      update.mutate({ signupMode: mode as SignupMode, dailyNewAccountsLimit: Number(daily), maxPendingSignups: Number(max) });
    }
  };
  const field = (label: string, value: string, set: (next: string) => void, valid: boolean) => (
    <label className="flex flex-col gap-1">
      <span className="text-text-muted">{label}</span>
      <input
        value={value}
        onChange={(event) => set(event.target.value)}
        inputMode="numeric"
        dir="ltr"
        aria-invalid={!valid}
        className="w-24 rounded-md border border-border-subtle bg-surface px-3 py-2 text-start"
      />
    </label>
  );
  return (
    <Card title={t('admin.signupSettings.title')}>
      {settings.isPending && <Spinner label={t('admin.signupSettings.title')} />}
      {settings.error && <ErrorNote message={errorMessage(settings.error, t('admin.signupSettings.title'))} />}
      {settings.data && (
        <form onSubmit={submit} className="space-y-3 text-sm">
          {!emailConfigured && (
            <p role="status" className="rounded-lg border border-loss/40 bg-loss/10 px-3 py-2 text-loss">
              {t('admin.signupSettings.noEmail')}
            </p>
          )}
          <fieldset className="space-y-2">
            <legend className="mb-1 text-text-muted">{t('admin.signupSettings.mode')}</legend>
            {SIGNUP_MODES.map((option) => (
              <label key={option} className="flex items-start gap-2">
                <input
                  type="radio"
                  name="signup-mode"
                  value={option}
                  checked={mode === option}
                  disabled={option === 'automatic' && !emailConfigured}
                  onChange={() => setMode(option)}
                  className="mt-1"
                />
                <span>
                  <span className="font-medium">{t(`admin.signupSettings.modes.${option}.label`)}</span>
                  <span className="block text-xs text-text-muted">{t(`admin.signupSettings.modes.${option}.hint`)}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap items-end gap-3">
            {field(t('admin.signupSettings.daily'), daily, setDaily, dailyValid)}
            {field(t('admin.signupSettings.max'), max, setMax, maxValid)}
            <Button type="submit" disabled={!dailyValid || !maxValid || unchanged || update.isPending}>
              {t('admin.signupSettings.save')}
            </Button>
            {update.isSuccess && unchanged && (
              <span role="status" className="text-xs text-text-muted">
                {t('admin.signupSettings.saved')}
              </span>
            )}
          </div>
          <p className="text-xs text-text-muted">
            {t('admin.signupSettings.hint', { daily: DAILY_NEW_ACCOUNTS_CEILING, max: MAX_PENDING_SIGNUPS_CEILING })}
          </p>
          {update.error && <ErrorNote message={errorMessage(update.error, t('admin.signupSettings.title'))} />}
        </form>
      )}
    </Card>
  );
}

/**
 * What one user's questions to the assistant may spend a day (migration 0052).
 * Entered in dollars and cents, stored in integer micro-USD; 0 switches the
 * assistant off. Provisional until its cost per question is measured.
 */
function AssistantLimitCard() {
  const { t } = useTranslation();
  const settings = useAdminSettingsQuery();
  const update = useUpdateAdminSettings();
  const stored = settings.data ? microToDollarsText(settings.data.assistantDailyBudgetMicroUsd) : '';
  const [value, setValue] = useDraft(stored);
  const micro = /^\d+(\.\d{1,2})?$/.test(value.trim()) ? decimalUsdToMicro(value) : null;
  const valid = micro !== null && micro <= ASSISTANT_DAILY_BUDGET_CEILING_MICRO_USD;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (micro !== null) update.mutate({ assistantDailyBudgetMicroUsd: micro });
  };
  return (
    <Card title={t('admin.assistantLimit.title')}>
      {settings.isPending && <Spinner label={t('admin.assistantLimit.title')} />}
      {settings.error && <ErrorNote message={errorMessage(settings.error, t('admin.assistantLimit.title'))} />}
      {settings.data && (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-text-muted">{t('admin.assistantLimit.label')}</span>
            <input
              value={value}
              onChange={(event) => setValue(event.target.value)}
              inputMode="decimal"
              dir="ltr"
              aria-invalid={!valid}
              className="w-28 rounded-md border border-border-subtle bg-surface px-3 py-2 text-start"
            />
          </label>
          <Button type="submit" disabled={!valid || value === stored || update.isPending}>
            {t('admin.assistantLimit.save')}
          </Button>
          {update.isSuccess && value === stored && (
            <span role="status" className="text-xs text-text-muted">
              {t('admin.assistantLimit.saved')}
            </span>
          )}
          <p className="basis-full text-xs text-text-muted">
            {t('admin.assistantLimit.hint', { max: formatMicroUsd(ASSISTANT_DAILY_BUDGET_CEILING_MICRO_USD) })}
          </p>
          {update.error && <ErrorNote message={errorMessage(update.error, t('admin.assistantLimit.title'))} />}
        </form>
      )}
    </Card>
  );
}

/** D72: how many simulated agents a user may have. Every change is audited. */
function AgentLimitCard() {
  const { t } = useTranslation();
  const settings = useAdminSettingsQuery();
  const update = useUpdateAdminSettings();
  const stored = settings.data ? String(settings.data.maxAgentsPerUser) : '';
  const [value, setValue] = useDraft(stored);
  const number = Number(value);
  const valid = /^\d+$/.test(value) && number >= 1 && number <= MAX_AGENTS_PER_USER_CEILING;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate({ maxAgentsPerUser: number });
  };
  return (
    <Card title={t('admin.agentLimit.title')}>
      {settings.isPending && <Spinner label={t('admin.agentLimit.title')} />}
      {settings.error && <ErrorNote message={errorMessage(settings.error, t('admin.agentLimit.title'))} />}
      {settings.data && (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-text-muted">{t('admin.agentLimit.label')}</span>
            <input
              value={value}
              onChange={(event) => setValue(event.target.value)}
              inputMode="numeric"
              dir="ltr"
              aria-invalid={!valid}
              className="w-24 rounded-md border border-border-subtle bg-surface px-3 py-2 text-start"
            />
          </label>
          <Button type="submit" disabled={!valid || value === stored || update.isPending}>
            {t('admin.agentLimit.save')}
          </Button>
          {update.isSuccess && value === stored && (
            <span role="status" className="text-xs text-text-muted">
              {t('admin.agentLimit.saved')}
            </span>
          )}
          <p className="basis-full text-xs text-text-muted">
            {t('admin.agentLimit.hint', { max: MAX_AGENTS_PER_USER_CEILING })}
          </p>
          {update.error && <ErrorNote message={errorMessage(update.error, t('admin.agentLimit.title'))} />}
        </form>
      )}
    </Card>
  );
}

function ModelsCard() {
  const models = useAdminLlmModelsQuery();
  const { t } = useTranslation();
  return (
    <Card title={t('admin.models.title')}>
      {models.isPending && <Spinner label={t('admin.models.loading')} />}
      {models.error && (
        <ErrorNote message={errorMessage(models.error, t('admin.models.failed'))} onRetry={() => void models.refetch()} />
      )}
      {models.data && <ModelsPanel data={models.data} />}
    </Card>
  );
}

const SCOPES: readonly LlmScope[] = ['explain', 'agent', 'assistant'];

/**
 * The model in use, or '' when it is not offered for this scope - the free route
 * for agents, or a chosen model since withdrawn. Never the first offered model:
 * that showed Sonnet as chosen while scans ran on the configured default.
 */
function initialSelection(data: AdminLlmModelsResponse, scope: LlmScope): string {
  const choice = data.choices.find((candidate) => candidate.scope === scope);
  const offered = data.models.filter((model) => model.scopes.includes(scope));
  const current = choice?.chosen ?? choice?.effective ?? null;
  return offered.find((model) => model.id === current)?.id ?? '';
}

/** The assistant has no estimate until its cost per question is measured (its PR 4). */
function estimateFor(model: LlmOfferedModelView | undefined, scope: LlmScope) {
  if (!model || scope === 'assistant') return null;
  return scope === 'explain' ? model.estimates.explain : model.estimates.agent;
}

function ModelsPanel({ data }: { data: AdminLlmModelsResponse }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Record<LlmScope, string>>(() => ({
    explain: initialSelection(data, 'explain'),
    agent: initialSelection(data, 'agent'),
    assistant: initialSelection(data, 'assistant'),
  }));
  const pick = (scope: LlmScope) => data.models.find((model) => model.id === selected[scope]);
  const totals = SCOPES.map((scope) => estimateFor(pick(scope), scope));
  const daily = totals.reduce((sum, estimate) => sum + (estimate?.dailyMicroUsd ?? 0), 0);
  const monthly = totals.reduce((sum, estimate) => sum + (estimate?.monthlyMicroUsd ?? 0), 0);

  return (
    <div className="space-y-4 text-sm">
      {!data.choosable && <p className="text-warn">{t('admin.models.notChoosable', { provider: data.provider })}</p>}
      {SCOPES.map((scope) => (
        <ScopePicker
          key={scope}
          data={data}
          scope={scope}
          value={selected[scope]}
          onChange={(model) => setSelected((current) => ({ ...current, [scope]: model }))}
        />
      ))}
      <div className="rounded border border-border-subtle p-3">
        <div className="font-medium">
          {t('admin.models.total', { daily: formatMicroUsd(daily), monthly: formatMicroUsd(monthly) })}
        </div>
        <Credits credits={data.credits} monthlyMicroUsd={monthly} />
        <p className="mt-1 text-xs text-text-muted">{t('admin.models.estimateNote')}</p>
      </div>
    </div>
  );
}

function ScopePicker({
  data,
  scope,
  value,
  onChange,
}: {
  data: AdminLlmModelsResponse;
  scope: LlmScope;
  value: string;
  onChange: (model: string) => void;
}) {
  const { t } = useTranslation();
  const choose = useChooseLlmModel();
  const choice = data.choices.find((candidate) => candidate.scope === scope);
  const offered = data.models.filter((model) => model.scopes.includes(scope));
  const model = offered.find((candidate) => candidate.id === value);
  const estimate = estimateFor(model, scope);
  const unchanged = value === choice?.chosen;
  const id = `model-${scope}`;

  return (
    <section className="space-y-1">
      <label htmlFor={id} className="block font-medium">
        {t(`admin.models.scope.${scope}`)}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <select
          id={id}
          value={value}
          disabled={!data.choosable || offered.length === 0}
          onChange={(event) => onChange(event.target.value)}
          className="input w-auto max-w-full min-w-0"
        >
          {value === '' && (
            <option value="" disabled>
              {choice?.chosen
                ? t('admin.models.notOffered', { model: choice.chosen })
                : t('admin.models.notChosen', { model: choice?.effective ?? t('admin.noModel') })}
            </option>
          )}
          {offered.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.label}
            </option>
          ))}
        </select>
        <Button
          variant="secondary"
          disabled={!data.choosable || !value || unchanged || choose.isPending}
          onClick={() => choose.mutate({ scope, model: value })}
        >
          {t('admin.models.save')}
        </Button>
      </div>
      <p className="text-xs text-text-muted">
        {choice?.chosen
          ? t('admin.models.inUse', { model: choice.chosen })
          : t('admin.models.inUseDefault', { model: choice?.effective ?? t('admin.noModel') })}
      </p>
      {model && (
        <p className="text-xs text-text-muted">
          {model.free
            ? t('admin.models.freeRoute')
            : t('admin.models.price', {
                input: formatPerMtok(model.promptUsdPerMtok),
                output: formatPerMtok(model.completionUsdPerMtok),
              })}
        </p>
      )}
      {estimate && (
        <p>
          {t('admin.models.estimate', {
            daily: formatMicroUsd(estimate.dailyMicroUsd),
            monthly: formatMicroUsd(estimate.monthlyMicroUsd),
          })}
        </p>
      )}
      <p className="text-xs text-text-muted">
        {scope === 'assistant'
          ? t('admin.models.assistantBasis')
          : scope === 'explain'
          ? t('admin.models.explainBasis', {
              days: data.explainBasis.windowDays,
              prompt: count.format(data.explainBasis.promptTokensPerDay),
              completion: count.format(data.explainBasis.completionTokensPerDay),
            })
          : t(
              data.agentBasis.source === 'assumed' ? 'admin.models.agentBasisAssumed' : 'admin.models.agentBasis',
              {
                count: data.agentBasis.scanningAgents,
                scans: data.agentBasis.scansPerDay,
                tokens: count.format(data.agentBasis.promptTokensPerScan + data.agentBasis.completionTokensPerScan),
                scan: model?.scanEstimateMicroUsd != null ? formatMicroUsd(model.scanEstimateMicroUsd) : '-',
              },
            )}
      </p>
      {choose.error && <ErrorNote message={errorMessage(choose.error, t('admin.models.saveFailed'))} />}
    </section>
  );
}

function Credits({
  credits,
  monthlyMicroUsd,
}: {
  credits: AdminLlmModelsResponse['credits'];
  monthlyMicroUsd: number;
}) {
  const { t } = useTranslation();
  if (credits === null) return <p className="text-text-muted">{t('admin.models.balanceUnavailable')}</p>;
  const remaining = decimalUsdToMicro(credits.remainingUsd);
  const used = decimalUsdToMicro(credits.usedUsd);
  const purchased = decimalUsdToMicro(credits.purchasedUsd);
  if (remaining === null || used === null || purchased === null) {
    return <p className="text-text-muted">{t('admin.models.balanceUnavailable')}</p>;
  }
  return (
    <>
      <p>
        {t('admin.models.balance', {
          remaining: formatMicroUsd(Math.max(remaining, 0)),
          used: formatMicroUsd(used),
          purchased: formatMicroUsd(purchased),
        })}
      </p>
      {remaining <= 0 ? (
        <p className="text-loss">{t('admin.models.noCredit')}</p>
      ) : (
        monthlyMicroUsd > 0 && (
          <p className="text-text-muted">
            {t('admin.models.lasts', { count: Math.floor((remaining * 30) / monthlyMicroUsd) })}
          </p>
        )
      )}
    </>
  );
}

function LlmCard() {
  const [days, setDays] = useState<number>(7);
  const llm = useAdminLlmQuery(days);
  const data = llm.data;
  const { t } = useTranslation();

  return (
    <Card
      title={t('admin.llm')}
      action={
        <div className="flex gap-1" role="group" aria-label={t('admin.window')}>
          {LLM_WINDOWS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={option === days}
              onClick={() => setDays(option)}
              className={`rounded px-2 py-0.5 text-xs ${
                option === days ? 'bg-surface-hover text-text-primary' : 'text-text-muted hover:text-text-primary'
              }`}
            >
              {option === 1 ? t('admin.last24h') : t('admin.lastDays', { count: option })}
            </button>
          ))}
        </div>
      }
    >
      {llm.isPending && <Spinner label={t('admin.llmLoading')} />}
      {llm.error && (
        <ErrorNote
          message={errorMessage(llm.error, t('admin.llmFailed'))}
          onRetry={() => void llm.refetch()}
        />
      )}
      {data && <LlmPanel data={data} />}
    </Card>
  );
}

function LlmPanel({ data }: { data: LlmPanelResponse }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4 text-sm">
      <p className="text-text-muted">
        {data.firstCallAt
          ? t('admin.recordedSince', { when: formatExactTime(data.firstCallAt) })
          : t('admin.noCalls')}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-start text-sm">
          <thead className="text-xs text-text-muted">
            <tr>
              <th className="py-2 pe-3 font-medium">{t('admin.llmColumns.purpose')}</th>
              <th className="py-2 pe-3 font-medium">{t('admin.llmColumns.calls')}</th>
              <th className="py-2 pe-3 font-medium">{t('admin.llmColumns.outcomes')}</th>
              <th className="py-2 pe-3 font-medium">{t('admin.llmColumns.verdicts')}</th>
              <th className="py-2 pe-3 font-medium">{t('admin.llmColumns.latency')}</th>
              <th className="py-2 pe-3 font-medium">{t('admin.llmColumns.tokens')}</th>
              <th className="py-2 font-medium">{t('admin.llmColumns.cost')}</th>
            </tr>
          </thead>
          <tbody>
            {data.purposes.map((summary) => (
              <PurposeRow key={summary.purpose} summary={summary} />
            ))}
          </tbody>
        </table>
      </div>
      <NarrationReconciliation data={data} />
      <NarrationHistory data={data} />
      <RecentCalls calls={data.recent} />
      <p className="text-xs text-text-muted">
        {t('admin.notMeasured')}
      </p>
    </div>
  );
}

function PurposeRow({ summary }: { summary: LlmPurposeSummary }) {
  const outcomes = nonZero(summary.outcomes, OUTCOME_LABEL);
  const verdicts = nonZero(summary.verdicts, VERDICT_LABEL);
  const { t } = useTranslation();
  const counted = (rows: { count: number; label: string }[]) =>
    rows.map((row) => t('admin.countLabel', { count: row.count, label: row.label })).join(t('common.listSeparator')) ||
    '-';
  return (
    <tr className="border-t border-border-subtle align-top">
      <td className="py-2 pe-3">
        <div className="font-medium">{summary.purpose}</div>
        {summary.models.map((model) => (
          <div key={model.model ?? 'none'} className="break-all font-mono text-xs text-text-muted">
            {t('admin.modelCalls', { model: model.model ?? t('admin.noModel'), value: count.format(model.calls) })}
          </div>
        ))}
      </td>
      <td className="py-2 pe-3">{count.format(summary.calls)}</td>
      <td className="py-2 pe-3">{counted(outcomes)}</td>
      <td className="py-2 pe-3">{counted(verdicts)}</td>
      <td className="py-2 pe-3 whitespace-nowrap">
        {summary.latency
          ? t('admin.latencyPair', {
              p50: formatLatency(summary.latency.p50Ms),
              p95: formatLatency(summary.latency.p95Ms),
            })
          : '-'}
      </td>
      <td className="py-2 pe-3 whitespace-nowrap">
        {t('admin.tokensPair', {
          prompt: count.format(summary.promptTokens),
          completion: count.format(summary.completionTokens),
        })}
      </td>
      <td className="py-2 whitespace-nowrap">{summary.calls === 0 ? '-' : purposeCost(summary)}</td>
    </tr>
  );
}

/** Explanations stored against calls recorded, reason by reason, where both records exist. */
function NarrationReconciliation({ data }: { data: LlmPanelResponse }) {
  const { t } = useTranslation();
  if (!data.reconciliation) return null;
  const { since, rows } = data.reconciliation;
  return (
    <div>
      <p className="font-medium">{t('admin.narrationSince', { when: formatExactTime(since) })}</p>
      {rows.length === 0 ? (
        <p className="text-text-muted">{t('admin.nothingNarrated')}</p>
      ) : (
        <ul className="ms-4 list-disc">
          {rows.map((row) => (
            <li key={row.reason} className={row.explanations === row.calls ? '' : 'text-warn'}>
              {t('admin.storedCalls', {
                reason: reasonLabel(row.reason),
                stored: count.format(row.explanations),
                count: row.calls,
              })}
              {row.explanations !== row.calls && t('admin.shouldAgree')}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The longer record: why each stored explanation in the window was or was not the model's. */
function NarrationHistory({ data }: { data: LlmPanelResponse }) {
  const total = data.narrationFallbacks.reduce((sum, row) => sum + row.count, 0);
  const { t } = useTranslation();
  return (
    <div>
      <p className="font-medium">
        {data.window.days === 1
          ? t('admin.storedLast24h')
          : t('admin.storedLastDays', { count: data.window.days })}
      </p>
      {total === 0 ? (
        <p className="text-text-muted">{t('admin.none')}</p>
      ) : (
        <ul className="ms-4 list-disc">
          {data.narrationFallbacks.map((row) => (
            <li key={row.reason}>
              {t('admin.fallbackShare', {
                reason: reasonLabel(row.reason),
                value: count.format(row.count),
                total: count.format(total),
              })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RecentCalls({ calls }: { calls: LlmCallSummary[] }) {
  const { t } = useTranslation();
  if (calls.length === 0) return null;
  return (
    <div>
      <p className="font-medium">{t('admin.latestCalls')}</p>
      <ul className="divide-y divide-border-subtle">
        {calls.map((call) => (
          <li key={call.id} className="py-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span>
                {t('admin.callOutcome', { purpose: call.purpose, outcome: OUTCOME_LABEL[call.outcome] ?? call.outcome })}
                {call.verdict && t('admin.callVerdict', { verdict: VERDICT_LABEL[call.verdict] ?? call.verdict })}
              </span>
              <span className="text-xs text-text-muted" title={formatExactTime(call.startedAt)}>
                {formatAge(call.startedAt)}
              </span>
            </div>
            <div className="text-xs text-text-muted">
              <span className="break-all font-mono">{call.model ?? t('admin.noModel')}</span>
              {call.outcome !== 'no_provider' && call.outcome !== 'budget_exhausted' && (
                t('admin.callDetail', {
                  latency: formatLatency(call.latencyMs),
                  prompt: count.format(call.promptTokens),
                  completion: count.format(call.completionTokens),
                  cost: callCost(call),
                })
              )}
            </div>
            {call.error && <div className="break-all text-xs text-loss">{call.error}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What administrators have done here. Written before each action ran, and
 * append-only in the database, so this is a record nobody - including an
 * admin - can edit from the application.
 */
function AuditCard() {
  const audit = useAdminAuditQuery();
  const { t } = useTranslation();

  return (
    <Card title={t('admin.audit')}>
      {audit.isPending && <Spinner label={t('admin.auditLoading')} />}
      {audit.error && (
        <ErrorNote
          message={errorMessage(audit.error, t('admin.auditFailed'))}
          onRetry={() => void audit.refetch()}
        />
      )}
      {audit.data && audit.data.entries.length === 0 && (
        <p className="text-sm text-text-muted">{t('admin.auditEmpty')}</p>
      )}
      {audit.data && audit.data.entries.length > 0 && (
        <ul className="divide-y divide-border-subtle text-sm">
          {audit.data.entries.map((entry) => (
            <AuditItem key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function AuditItem({ entry }: { entry: AdminAuditEntry }) {
  const { t } = useTranslation();
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-2 py-2">
      <span className="font-mono text-xs">{entry.action}</span>
      <span className="text-xs text-text-muted" title={formatExactTime(entry.occurredAt)}>
        {formatAge(entry.occurredAt)}
        {entry.ipAddress ? t('admin.fromIp', { ip: entry.ipAddress }) : ''}
      </span>
    </li>
  );
}

/** Seconds a finished run took; a run still going says so rather than showing a number. */
export function duration(run: Pick<AdminRun, 'startedAt' | 'finishedAt'>): string {
  if (!run.finishedAt) return translate('admin.stillRunning');
  const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  if (ms < 1000) return translate('admin.underASecond');
  const seconds = Math.round(ms / 1000);
  return seconds < 120
    ? translate('admin.seconds', { count: seconds })
    : translate('admin.minutes', { count: Math.round(seconds / 60) });
}
