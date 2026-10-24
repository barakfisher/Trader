import { useEffect } from 'react';
import { useLocation } from '@tanstack/react-router';
import { Microscope, Play } from 'lucide-react';

import {
  RESEARCH_REFUSALS,
  RESEARCH_STOPS,
  type ResearchHolding,
  type ResearchRunSummary,
  type ResearchStop,
} from '@traders/shared';

import { ApiRequestError, errorMessage } from '../api/client.ts';
import { Disclaimer } from '../components/Disclaimer.tsx';
import { OwnKeyNotice } from '../components/OwnKeyNotice.tsx';
import { SentimentBadge, byOn, ratedOn } from '../components/SentimentBadge.tsx';
import { Button, Card, EmptyState, ErrorNote, Spinner } from '../components/ui.tsx';
import { t, useTranslation } from '../i18n/index.ts';
import { formatExactTime } from '../lib/relativeTime.ts';
import { SERVER_ENGLISH } from '../lib/textDirection.ts';
import { useAgentsQuery } from '../queries/agents.ts';
import { useModelAccess } from '../queries/modelAccess.ts';
import { useAssignResearchAgent, useResearchQuery, useStartResearch } from '../queries/research.ts';

/** Refusals the page says in the reader's words: research's own, the payer's, and no model. */
const SAID_REFUSALS = [
  ...RESEARCH_REFUSALS,
  'own_key_required',
  'own_key_failed',
  'safety_limit_reached',
  'no_model',
] as const;
type SaidRefusal = (typeof SAID_REFUSALS)[number];

/**
 * Research on the main portfolio (D254, D289-D293): the agent the user assigned
 * reads each holding's news, market data and sector, and rates the stock's
 * outlook Bullish, Bearish or Neutral, with its reasons. A rating is about the
 * stock, never the user's position, and never an instruction - so the
 * disclaimer heads the page (guardrail 5), and the rationale is shown as the
 * model wrote it, in English (D291), with every figure checked.
 */
export function ResearchPage() {
  const { t } = useTranslation();
  const research = useResearchQuery();
  const hash = useLocation({ select: (location) => location.hash });

  useEffect(() => {
    if (hash && research.data) document.getElementById(`research-${hash}`)?.scrollIntoView({ block: 'start' });
  }, [hash, research.data]);

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <header className="flex items-center gap-2">
        <Microscope className="size-5 text-accent" aria-hidden />
        <h1 className="text-base font-semibold">{t('research.title')}</h1>
      </header>
      <p className="text-sm text-text-muted">{t('research.intro')}</p>
      <Disclaimer />
      <p className="text-xs text-text-muted">{t('research.notAdvice')}</p>
      {research.isPending ? (
        <Spinner label={t('common.loading')} />
      ) : research.isError ? (
        <ErrorNote message={errorMessage(research.error, t('research.loadFailed'))} onRetry={() => research.refetch()} />
      ) : (
        <>
          <AssignmentCard
            agentId={research.data.agent?.id ?? null}
            run={research.data.run}
            holdingCount={research.data.holdings.length}
          />
          <HoldingsResearch holdings={research.data.holdings} assigned={research.data.agent !== null} />
        </>
      )}
    </div>
  );
}

function AssignmentCard({
  agentId,
  run,
  holdingCount,
}: {
  agentId: string | null;
  run: ResearchRunSummary | null;
  holdingCount: number;
}) {
  const { t } = useTranslation();
  const agents = useAgentsQuery();
  const assign = useAssignResearchAgent();
  const start = useStartResearch();
  const access = useModelAccess();
  const choosable = (agents.data ?? []).filter((agent) => !agent.isPrimary && agent.state !== 'archived');
  const assigned = choosable.find((agent) => agent.id === agentId) ?? null;
  const running = run?.status === 'running';
  const refusal = refusalText(start.error);

  return (
    <Card title={t('research.agentTitle')}>
      <div className="space-y-3">
        <label className="block space-y-1 text-sm">
          <span className="text-text-muted">{t('research.agentLabel')}</span>
          <select
            className="block w-full max-w-sm"
            value={agentId ?? ''}
            disabled={assign.isPending || agents.isPending}
            onChange={(event) => assign.mutate(event.target.value === '' ? null : event.target.value)}
          >
            <option value="">{t('research.noAgent')}</option>
            {choosable.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.state === 'paused' ? t('research.pausedAgent', { name: agent.name }) : agent.name}
              </option>
            ))}
          </select>
        </label>
        {choosable.length === 0 && !agents.isPending && <p className="text-xs text-text-muted">{t('research.noAgents')}</p>}
        {assign.error && <p className="text-xs text-loss">{errorMessage(assign.error, t('research.assignFailed'))}</p>}
        {assigned && (
          <>
            <p className="text-xs text-text-muted">{t('research.schedule', { name: assigned.name })}</p>
            <p className="text-xs text-text-muted">{t('research.cost', { count: holdingCount })}</p>
            <OwnKeyNotice access={access} />
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={() => start.mutate()}
                disabled={start.isPending || running || access.block !== null || assigned.state !== 'active' || holdingCount === 0}
              >
                <span className="flex items-center gap-1">
                  <Play className="size-4" aria-hidden />
                  {t('research.run')}
                </span>
              </Button>
              {assigned.state !== 'active' && <span className="text-xs text-text-muted">{t('research.refusals.agent_not_active')}</span>}
            </div>
            {refusal && <p className="text-xs text-loss">{refusal}</p>}
          </>
        )}
        {run && <RunStatus run={run} />}
      </div>
    </Card>
  );
}

/** A refused start in the reader's words: a known refusal from the catalogue, else the server's. */
function refusalText(error: Error | null): string | null {
  if (error === null) return null;
  return error instanceof ApiRequestError && (SAID_REFUSALS as readonly string[]).includes(error.code)
    ? t(`research.refusals.${error.code as SaidRefusal}`)
    : errorMessage(error, t('research.startFailed'));
}

function RunStatus({ run }: { run: ResearchRunSummary }) {
  const { t } = useTranslation();
  const when = formatExactTime(run.finishedAt ?? run.startedAt);
  const stop =
    run.error !== null && (RESEARCH_STOPS as readonly string[]).includes(run.error) ? (run.error as ResearchStop) : null;
  return (
    <div role="status" className="space-y-1 text-xs text-text-muted">
      {run.status === 'running' ? (
        <p className="flex items-center gap-2">
          <Spinner label={t('research.running', { holdings: run.holdings })} />
        </p>
      ) : (
        <p>
          {t(run.status === 'failed' ? 'research.lastFailed' : 'research.lastRun', {
            when,
            rated: run.rated,
            holdings: run.holdings,
          })}
        </p>
      )}
      {stop && <p>{t(`research.stops.${stop}`)}</p>}
    </div>
  );
}

function HoldingsResearch({ holdings, assigned }: { holdings: ResearchHolding[]; assigned: boolean }) {
  const { t } = useTranslation();
  if (holdings.length === 0) return <EmptyState title={t('research.noHoldings')} />;
  if (!assigned) return <EmptyState title={t('research.unassignedTitle')} body={t('research.unassignedBody')} />;
  return (
    <Card title={t('research.holdingsTitle', { count: holdings.length })}>
      <ul className="divide-y divide-border-subtle/60">
        {holdings.map((holding) => (
          <li key={holding.instrumentId} id={`research-${holding.symbol}`} className="scroll-mt-20 py-3 first:pt-0 last:pb-0">
            <HoldingResearch holding={holding} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function HoldingResearch({ holding }: { holding: ResearchHolding }) {
  const { t } = useTranslation();
  const latest = holding.latest;
  return (
    <article className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold">{holding.symbol}</h2>
        {holding.name && <span className="text-xs text-text-muted">{holding.name}</span>}
        {latest ? (
          <>
            <SentimentBadge rating={latest.rating} />
            <span className="text-xs text-text-muted">
              {t('research.byOn', byOn(latest.agentName, latest.ratedAt))}
            </span>
            {latest.stale && <span className="text-xs text-warn">{t('research.staleLong')}</span>}
          </>
        ) : (
          <span className="text-xs text-text-muted">{t('research.notYet')}</span>
        )}
      </div>
      {latest && (
        <>
          <p {...SERVER_ENGLISH} className="text-sm">
            {latest.rationale}
          </p>
          {latest.findings.length > 0 && (
            <ul {...SERVER_ENGLISH} className="list-disc space-y-0.5 ps-5 text-xs text-text-muted">
              {latest.findings.map((finding, index) => (
                <li key={index}>{finding}</li>
              ))}
            </ul>
          )}
        </>
      )}
      {holding.lastAttempt && (
        <p className="text-xs text-text-muted">
          {t(`research.lastAttempt.${holding.lastAttempt.status}`, { date: ratedOn(holding.lastAttempt.at) })}
        </p>
      )}
    </article>
  );
}
