import { observer } from 'mobx-react-lite';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, ShieldCheck } from 'lucide-react';

import type { AdminAuditEntry, AdminRun, UniverseGap } from '@traders/shared';

import { errorMessage } from '../api/client.ts';
import { Card, EmptyState, ErrorNote, Spinner, buttonClass } from '../components/ui.tsx';
import { formatAge, formatExactTime } from '../lib/relativeTime.ts';
import { gapExplanation, gapSubject, isRealGap } from '../lib/universeGaps.ts';
import { useAdminAuditQuery, useAdminGapsQuery, useAdminRunsQuery } from '../queries/admin.ts';
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
export const AdminPage = observer(function AdminPage() {
  const { auth } = useStore();
  const isAdmin = auth.user?.role === 'admin';

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-accent" aria-hidden />
          <h1 className="text-base font-semibold">Admin</h1>
        </div>
        <Link to="/" className={buttonClass('secondary')}>
          <span className="flex items-center gap-1">
            <ArrowLeft className="size-4" aria-hidden />
            Back to portfolio
          </span>
        </Link>
      </header>

      {isAdmin ? (
        <>
          <GapsCard />
          <RunsCard />
          <AuditCard />
        </>
      ) : (
        <EmptyState
          title="Administrators only"
          body="This account is not an administrator, so there is nothing to show here."
        />
      )}
    </div>
  );
});

function RunsCard() {
  const runs = useAdminRunsQuery();

  return (
    <Card title="Recent runs, every account">
      {runs.isPending && <Spinner label="Loading runs…" />}
      {runs.error && (
        <ErrorNote
          message={errorMessage(runs.error, 'Could not load the run history.')}
          onRetry={() => void runs.refetch()}
        />
      )}
      {runs.data && runs.data.runs.length === 0 && (
        <p className="text-sm text-text-muted">No run has been recorded yet.</p>
      )}
      {runs.data && runs.data.runs.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-text-muted">
              <tr>
                <th className="py-2 pr-3 font-medium">Kind</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 font-medium">Started</th>
                <th className="py-2 pr-3 font-medium">Took</th>
                <th className="py-2 pr-3 font-medium">Trigger</th>
                <th className="py-2 font-medium">Run key</th>
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
      <td className="py-2 pr-3">{run.kind}</td>
      <td className={`py-2 pr-3 ${STATUS_TONE[run.status] ?? ''}`}>{run.status}</td>
      <td className="py-2 pr-3 whitespace-nowrap" title={formatExactTime(run.startedAt)}>
        {formatAge(run.startedAt)}
      </td>
      <td className="py-2 pr-3 whitespace-nowrap">{duration(run)}</td>
      <td className="py-2 pr-3">{run.trigger}</td>
      <td className="py-2 break-all font-mono text-xs text-text-muted">{run.runKey}</td>
    </tr>
  );
}

/**
 * What users asked for that the universe could not give them. A gap a
 * rescreen could close is marked; one the screen excludes by rule is listed
 * for completeness, because "we never screen crypto" is an answer too.
 */
function GapsCard() {
  const gaps = useAdminGapsQuery();

  return (
    <Card title="Universe gaps">
      {gaps.isPending && <Spinner label="Loading gaps…" />}
      {gaps.error && (
        <ErrorNote
          message={errorMessage(gaps.error, 'Could not load the universe gaps.')}
          onRetry={() => void gaps.refetch()}
        />
      )}
      {gaps.data && gaps.data.gaps.length === 0 && (
        <p className="text-sm text-text-muted">
          No gap recorded: every symbol and topic users asked about was in the universe.
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
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-2 py-2">
      <span className="min-w-0">
        <span className={`font-medium ${real ? 'text-warn' : ''}`}>{gapSubject(gap)}</span>
        <span className="ml-2 text-text-muted">{gapExplanation(gap)}</span>
      </span>
      <span className="text-xs text-text-muted" title={formatExactTime(gap.lastSeenAt)}>
        {gap.occurrences > 1 ? `${gap.occurrences}× · ` : ''}
        {formatAge(gap.lastSeenAt)}
      </span>
    </li>
  );
}

/**
 * What administrators have done here. Written before each action ran, and
 * append-only in the database, so this is a record nobody - including an
 * admin - can edit from the application.
 */
function AuditCard() {
  const audit = useAdminAuditQuery();

  return (
    <Card title="Admin actions">
      {audit.isPending && <Spinner label="Loading admin actions…" />}
      {audit.error && (
        <ErrorNote
          message={errorMessage(audit.error, 'Could not load the admin actions.')}
          onRetry={() => void audit.refetch()}
        />
      )}
      {audit.data && audit.data.entries.length === 0 && (
        <p className="text-sm text-text-muted">No admin action has been taken yet.</p>
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
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-2 py-2">
      <span className="font-mono text-xs">{entry.action}</span>
      <span className="text-xs text-text-muted" title={formatExactTime(entry.occurredAt)}>
        {formatAge(entry.occurredAt)}
        {entry.ipAddress ? ` from ${entry.ipAddress}` : ''}
      </span>
    </li>
  );
}

/** Seconds a finished run took; a run still going says so rather than showing a number. */
export function duration(run: Pick<AdminRun, 'startedAt' | 'finishedAt'>): string {
  if (!run.finishedAt) return 'still running';
  const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  if (ms < 1000) return '<1 s';
  const seconds = Math.round(ms / 1000);
  return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}
