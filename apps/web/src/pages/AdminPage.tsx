import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, ShieldCheck } from 'lucide-react';

import type {
  AdminAuditEntry,
  AdminRun,
  LlmAgentSummary,
  LlmCallSummary,
  LlmPanelResponse,
  UniverseGap,
  UniverseReconciliation,
} from '@traders/shared';

import { errorMessage } from '../api/client.ts';
import { Button, Card, EmptyState, ErrorNote, Spinner, buttonClass } from '../components/ui.tsx';
import {
  LLM_WINDOWS,
  OUTCOME_LABEL,
  VERDICT_LABEL,
  agentCost,
  callCost,
  formatLatency,
  nonZero,
  reasonLabel,
} from '../lib/llmCalls.ts';
import { formatAge, formatExactTime } from '../lib/relativeTime.ts';
import { MIRROR_IN_RTL } from '../lib/textDirection.ts';
import { gapExplanation, gapProfile, gapSubject, isRealGap } from '../lib/universeGaps.ts';
import {
  useAdminAuditQuery,
  useAdminGapsQuery,
  useAdminLlmQuery,
  useAdminRunsQuery,
  useAdminUniverseQuery,
  useRescreen,
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
            <ArrowLeft className={`size-4 ${MIRROR_IN_RTL}`} aria-hidden />
            Back to portfolio
          </span>
        </Link>
      </header>

      {isAdmin ? (
        <>
          <UniverseCard />
          <GapsCard />
          <LlmCard />
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
          <table className="w-full text-start text-sm">
            <thead className="text-xs text-text-muted">
              <tr>
                <th className="py-2 pe-3 font-medium">Kind</th>
                <th className="py-2 pe-3 font-medium">Status</th>
                <th className="py-2 pe-3 font-medium">Started</th>
                <th className="py-2 pe-3 font-medium">Took</th>
                <th className="py-2 pe-3 font-medium">Trigger</th>
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

const RECONCILED: Record<UniverseReconciliation['what'], string> = {
  members: 'Members',
  etf_holdings: 'ETF holdings',
};

const count = new Intl.NumberFormat('en-US');

/**
 * The universe: the snapshot the loader last read, what the database holds,
 * and each difference named by the loader. Only a remainder nobody explained
 * is shown as a problem.
 */
function UniverseCard() {
  const universe = useAdminUniverseQuery();
  const data = universe.data;

  return (
    <Card title="Universe">
      <RescreenControl />
      {universe.isPending && <Spinner label="Loading the universe…" />}
      {universe.error && (
        <ErrorNote
          message={errorMessage(universe.error, 'Could not load the universe status.')}
          onRetry={() => void universe.refetch()}
        />
      )}
      {data && (
        <div className="space-y-3 text-sm">
          <p>
            {count.format(data.database.profiles)} profiled ({count.format(data.database.equities)}{' '}
            equities, {count.format(data.database.etfs)} ETFs), {count.format(data.database.embedded)}{' '}
            embedded, {count.format(data.database.etfHoldings)} ETF holdings.
          </p>
          {data.database.dropped > 0 && (
            <p className="text-text-muted">
              {count.format(data.database.dropped)} dropped by a later snapshot: kept, because
              holdings and topics refer to them, but no longer members.
            </p>
          )}
          {data.database.onDemand > 0 && (
            <p className="text-text-muted">
              Also {count.format(data.database.onDemand)} profiled on demand for listings users named.
              They are described but not members: no topic is answered from them, and they are not
              compared with the snapshot.
            </p>
          )}
          {data.lastLoad ? (
            <p className="text-text-muted">
              Snapshot of {formatExactTime(data.lastLoad.snapshotAsOf)}, last loaded{' '}
              {formatAge(data.lastLoad.loadedAt)}.
            </p>
          ) : (
            <p className="text-warn">
              No load has been recorded, so there is nothing to compare the database against. The
              universe loader records one every time it runs.
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

  return (
    <div className="mb-3 space-y-2 border-b border-border-subtle pb-3 text-sm">
      {!confirming ? (
        <Button variant="secondary" onClick={() => setConfirming(true)} disabled={rescreen.isPending}>
          Rescreen universe
        </Button>
      ) : (
        <div className="space-y-2">
          <p>
            This rebuilds the universe from Yahoo&apos;s screener - half an hour or more, as Yahoo
            limits how fast it answers - and loads it. If Yahoo refuses some listings the run fails
            and keeps what it fetched; rescreening again the same day resumes.
            Listings cross the size floor both ways; a member the new screen lacks is marked dropped
            and no topic is answered from it. Once a rescreen has succeeded, another the same day
            does nothing.
          </p>
          <div className="flex gap-2">
            <Button
              onClick={() => {
                setConfirming(false);
                rescreen.mutate();
              }}
            >
              Rescreen now
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {rescreen.isPending && <Spinner label="Starting the rescreen…" />}
      {rescreen.error && (
        <ErrorNote message={errorMessage(rescreen.error, 'Could not start the rescreen.')} />
      )}
      {result?.status === 'running' && (
        <p className="text-text-muted">
          Rescreen started ({result.runKey}). It runs in the background; follow it under Recent runs.
        </p>
      )}
      {result?.status === 'skipped' && <p className="text-warn">Not started: {result.reason}.</p>}
    </div>
  );
}

function ReconciliationRow({ row }: { row: UniverseReconciliation }) {
  return (
    <div>
      <p className="font-medium">
        {RECONCILED[row.what]}: {count.format(row.inSnapshot)} in the snapshot,{' '}
        {count.format(row.inDatabase)} in the database
      </p>
      <ul className="ms-4 list-disc text-text-muted">
        {row.explained.map((difference) => (
          <li key={difference.reason}>
            {count.format(difference.count)}: {difference.reason}
          </li>
        ))}
        {row.unexplained !== 0 && (
          <li className="text-warn">
            {count.format(Math.abs(row.unexplained))}{' '}
            {row.unexplained > 0 ? 'missing from' : 'more in'} the database, unexplained
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
        <span className="ms-2 text-text-muted">{gapExplanation(gap)}</span>
        {gapProfile(gap) && <span className="block text-xs text-text-muted">{gapProfile(gap)}</span>}
      </span>
      <span className="text-xs text-text-muted" title={formatExactTime(gap.lastSeenAt)}>
        {gap.occurrences > 1 ? `${gap.occurrences}× · ` : ''}
        {formatAge(gap.lastSeenAt)}
      </span>
    </li>
  );
}

/**
 * Every model call, per agent, and narration's fallback reasons counted
 * against the calls behind them (decision 87). Cost says "free route" where a
 * zero is the price. What is not measured is said, not shown as zero.
 */
function LlmCard() {
  const [days, setDays] = useState<number>(7);
  const llm = useAdminLlmQuery(days);
  const data = llm.data;

  return (
    <Card
      title="Model calls"
      action={
        <div className="flex gap-1" role="group" aria-label="Window">
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
              {option === 1 ? '24 h' : `${option} days`}
            </button>
          ))}
        </div>
      }
    >
      {llm.isPending && <Spinner label="Loading model calls…" />}
      {llm.error && (
        <ErrorNote
          message={errorMessage(llm.error, 'Could not load the model calls.')}
          onRetry={() => void llm.refetch()}
        />
      )}
      {data && <LlmPanel data={data} />}
    </Card>
  );
}

function LlmPanel({ data }: { data: LlmPanelResponse }) {
  return (
    <div className="space-y-4 text-sm">
      <p className="text-text-muted">
        {data.firstCallAt
          ? `Calls are recorded since ${formatExactTime(data.firstCallAt)} and kept for a limited time.`
          : 'No model call has been recorded yet. Every call is recorded from the moment it is made.'}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-start text-sm">
          <thead className="text-xs text-text-muted">
            <tr>
              <th className="py-2 pe-3 font-medium">Agent</th>
              <th className="py-2 pe-3 font-medium">Calls</th>
              <th className="py-2 pe-3 font-medium">Outcomes</th>
              <th className="py-2 pe-3 font-medium">Verdicts</th>
              <th className="py-2 pe-3 font-medium">Latency p50 / p95</th>
              <th className="py-2 pe-3 font-medium">Tokens in / out</th>
              <th className="py-2 font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {data.agents.map((agent) => (
              <AgentRow key={agent.agent} agent={agent} />
            ))}
          </tbody>
        </table>
      </div>
      <NarrationReconciliation data={data} />
      <NarrationHistory data={data} />
      <RecentCalls calls={data.recent} />
      <p className="text-xs text-text-muted">
        Not measured: time to first token (no call streams its answer) and a semantic-cache hit rate
        (there is no cache).
      </p>
    </div>
  );
}

function AgentRow({ agent }: { agent: LlmAgentSummary }) {
  const outcomes = nonZero(agent.outcomes, OUTCOME_LABEL);
  const verdicts = nonZero(agent.verdicts, VERDICT_LABEL);
  return (
    <tr className="border-t border-border-subtle align-top">
      <td className="py-2 pe-3">
        <div className="font-medium">{agent.agent}</div>
        {agent.models.map((model) => (
          <div key={model.model ?? 'none'} className="break-all font-mono text-xs text-text-muted">
            {model.model ?? 'no model'} ×{count.format(model.calls)}
          </div>
        ))}
      </td>
      <td className="py-2 pe-3">{count.format(agent.calls)}</td>
      <td className="py-2 pe-3">{outcomes.map((o) => `${o.count} ${o.label}`).join(', ') || '-'}</td>
      <td className="py-2 pe-3">{verdicts.map((v) => `${v.count} ${v.label}`).join(', ') || '-'}</td>
      <td className="py-2 pe-3 whitespace-nowrap">
        {agent.latency
          ? `${formatLatency(agent.latency.p50Ms)} / ${formatLatency(agent.latency.p95Ms)}`
          : '-'}
      </td>
      <td className="py-2 pe-3 whitespace-nowrap">
        {count.format(agent.promptTokens)} / {count.format(agent.completionTokens)}
      </td>
      <td className="py-2 whitespace-nowrap">{agent.calls === 0 ? '-' : agentCost(agent)}</td>
    </tr>
  );
}

/** Explanations stored against calls recorded, reason by reason, where both records exist. */
function NarrationReconciliation({ data }: { data: LlmPanelResponse }) {
  if (!data.reconciliation) return null;
  const { since, rows } = data.reconciliation;
  return (
    <div>
      <p className="font-medium">Narration since {formatExactTime(since)}: explanations and the calls behind them</p>
      {rows.length === 0 ? (
        <p className="text-text-muted">Nothing narrated since then.</p>
      ) : (
        <ul className="ms-4 list-disc">
          {rows.map((row) => (
            <li key={row.reason} className={row.explanations === row.calls ? '' : 'text-warn'}>
              {reasonLabel(row.reason)}: {count.format(row.explanations)} stored,{' '}
              {count.format(row.calls)} {row.calls === 1 ? 'call' : 'calls'}
              {row.explanations !== row.calls && ' - these should agree'}
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
  return (
    <div>
      <p className="font-medium">
        Explanations stored in the last {data.window.days === 1 ? '24 hours' : `${data.window.days} days`}
      </p>
      {total === 0 ? (
        <p className="text-text-muted">None.</p>
      ) : (
        <ul className="ms-4 list-disc">
          {data.narrationFallbacks.map((row) => (
            <li key={row.reason}>
              {reasonLabel(row.reason)}: {count.format(row.count)} of {count.format(total)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RecentCalls({ calls }: { calls: LlmCallSummary[] }) {
  if (calls.length === 0) return null;
  return (
    <div>
      <p className="font-medium">Latest calls</p>
      <ul className="divide-y divide-border-subtle">
        {calls.map((call) => (
          <li key={call.id} className="py-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span>
                {call.agent}: {OUTCOME_LABEL[call.outcome] ?? call.outcome}
                {call.verdict && `, ${VERDICT_LABEL[call.verdict] ?? call.verdict}`}
              </span>
              <span className="text-xs text-text-muted" title={formatExactTime(call.startedAt)}>
                {formatAge(call.startedAt)}
              </span>
            </div>
            <div className="text-xs text-text-muted">
              <span className="break-all font-mono">{call.model ?? 'no model'}</span>
              {call.outcome !== 'no_provider' && call.outcome !== 'budget_exhausted' && (
                <>
                  {' '}
                  · {formatLatency(call.latencyMs)} · {count.format(call.promptTokens)} /{' '}
                  {count.format(call.completionTokens)} tokens · {callCost(call)}
                </>
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
