import { useEffect, useId, useRef, useState } from 'react';
import { useLocation } from '@tanstack/react-router';
import { Microscope, Play } from 'lucide-react';

import { RESEARCH_STOPS, type ResearchHolding, type ResearchRunSummary, type ResearchStop } from '@traders/shared';

import { errorMessage } from '../api/client.ts';
import { CollapsingCards } from '../components/CollapsingCards.tsx';
import { Disclaimer } from '../components/Disclaimer.tsx';
import { ExpandMark, ExpandingPanel, useRevealOnOpen } from '../components/ExpandingCard.tsx';
import { OwnKeyNotice } from '../components/OwnKeyNotice.tsx';
import { SentimentBadge, byOn, ratedOn } from '../components/SentimentBadge.tsx';
import { Button, Card, EmptyState, ErrorNote, Spinner } from '../components/ui.tsx';
import { useTranslation } from '../i18n/index.ts';
import { researchRefusalText } from '../lib/researchRefusals.ts';
import { formatExactTime } from '../lib/relativeTime.ts';
import { SERVER_ENGLISH } from '../lib/textDirection.ts';
import { useNarrowViewport } from '../lib/viewport.ts';
import { useAgentsQuery } from '../queries/agents.ts';
import { useModelAccess } from '../queries/modelAccess.ts';
import { useAssignResearchAgent, useResearchQuery, useStartResearch } from '../queries/research.ts';

/**
 * Research on the main portfolio (D254, D289-D293): the agent the user assigned
 * reads each holding's news, market data and sector, and rates the stock's
 * outlook Bullish, Bearish or Neutral, with its reasons. A rating is about the
 * stock, never the user's position, and never an instruction - so the
 * disclaimer heads the page (guardrail 5), and the rationale is shown as the
 * model wrote it, in English (D291), with every figure checked.
 *
 * A stock researched on its own from a holding row (D369) is listed under the
 * holdings, in a section of its own (D370): it is rated, but not held.
 *
 * On a phone (D389) each entry is a closed line that still states the rating, its
 * agent and its date (guardrails 3-4); a tap opens the reasons, one entry at a
 * time. The agent's card closes too, and takes the intro with it. The disclaimer
 * and the note that a rating is not advice are never folded away.
 */
export function ResearchPage() {
  const { t } = useTranslation();
  const research = useResearchQuery();
  const narrow = useNarrowViewport();
  const hash = useLocation({ select: (location) => location.hash });

  // Once per address: the read repeats while a run goes, and the page must not
  // jump back to the stock on every repeat. A stock researched on its own has
  // no entry until its rating lands, so the scroll waits for the entry.
  const scrolledTo = useRef<string | null>(null);
  // One open entry across both lists, and the one a link names starts open.
  const [openEntry, setOpenEntry] = useState<string | null>(hash || null);
  useEffect(() => {
    if (hash) setOpenEntry(hash);
  }, [hash]);
  const toggleEntry = (symbol: string) => setOpenEntry(openEntry === symbol ? null : symbol);
  useEffect(() => {
    if (!hash || scrolledTo.current === hash) return;
    const entry = research.data && document.getElementById(`research-${hash}`);
    if (!entry) return;
    entry.scrollIntoView({ block: 'start' });
    // Again once the agent's card above it has opened itself, if it does.
    window.requestAnimationFrame(() => entry.scrollIntoView({ block: 'start' }));
    scrolledTo.current = hash;
  }, [hash, research.data]);
  const held = research.data?.holdings.filter((holding) => holding.held) ?? [];
  const others = research.data?.holdings.filter((holding) => !holding.held) ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <header className="flex items-center gap-2">
        <Microscope className="size-5 text-accent" aria-hidden />
        <h1 className="text-base font-semibold">{t('research.title')}</h1>
      </header>
      {!narrow && <p className="text-sm text-text-muted">{t('research.intro')}</p>}
      <Disclaimer />
      <p className="text-xs text-text-muted">{t('research.notAdvice')}</p>
      {research.isPending ? (
        <Spinner label={t('common.loading')} />
      ) : research.isError ? (
        <ErrorNote message={errorMessage(research.error, t('research.loadFailed'))} onRetry={() => research.refetch()} />
      ) : (
        <>
          {/* It opens above the list, and must not pull the page from the entry a link named. */}
          <CollapsingCards revealAttention={false}>
            <AssignmentCard
              agentId={research.data.agent?.id ?? null}
              run={research.data.run}
              holdingCount={held.length}
            />
          </CollapsingCards>
          <HoldingsResearch
            holdings={held}
            assigned={research.data.agent !== null}
            openEntry={openEntry}
            onToggle={toggleEntry}
          />
          {research.data.agent !== null && others.length > 0 && (
            <Card title={t('research.othersTitle', { count: others.length })}>
              <p className="mb-3 text-xs text-text-muted">{t('research.othersExplained')}</p>
              <ResearchList holdings={others} openEntry={openEntry} onToggle={toggleEntry} />
            </Card>
          )}
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
  const refusal = researchRefusalText(start.error);
  const narrow = useNarrowViewport();
  // What would otherwise wait behind a closed line on a phone. Each its own reason,
  // so a run that fails opens the card again after it was closed while running.
  const attention =
    refusal ??
    (assign.error
      ? 'assign-failed'
      : !agents.isPending && assigned === null
        ? 'unassigned'
        : running
          ? `running:${run.id}`
          : run?.status === 'failed'
            ? `failed:${run.id}`
            : run?.error
              ? `stopped:${run.id}`
              : null);

  return (
    <Card title={t('research.agentTitle')} attention={attention}>
      <div className="space-y-3">
        {narrow && <p className="text-sm text-text-muted">{t('research.intro')}</p>}
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

function RunStatus({ run }: { run: ResearchRunSummary }) {
  const { t } = useTranslation();
  const when = formatExactTime(run.finishedAt ?? run.startedAt);
  const stop =
    run.error !== null && (RESEARCH_STOPS as readonly string[]).includes(run.error) ? (run.error as ResearchStop) : null;
  return (
    <div role="status" className="space-y-1 text-xs text-text-muted">
      {run.status === 'running' ? (
        <p className="flex items-center gap-2">
          <Spinner label={t('research.running', { count: run.holdings })} />
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

interface EntryOpening {
  openEntry: string | null;
  onToggle: (symbol: string) => void;
}

function HoldingsResearch({
  holdings,
  assigned,
  openEntry,
  onToggle,
}: { holdings: ResearchHolding[]; assigned: boolean } & EntryOpening) {
  const { t } = useTranslation();
  if (holdings.length === 0) return <EmptyState title={t('research.noHoldings')} />;
  if (!assigned) return <EmptyState title={t('research.unassignedTitle')} body={t('research.unassignedBody')} />;
  return (
    <Card title={t('research.holdingsTitle', { count: holdings.length })}>
      <ResearchList holdings={holdings} openEntry={openEntry} onToggle={onToggle} />
    </Card>
  );
}

/** Each stock's latest rating, with the anchor a holding row's "Research this stock" opens at. */
function ResearchList({ holdings, openEntry, onToggle }: { holdings: ResearchHolding[] } & EntryOpening) {
  const narrow = useNarrowViewport();
  return (
    <ul className="divide-y divide-border-subtle/60">
      {holdings.map((holding) => (
        <li
          key={holding.instrumentId}
          id={`research-${holding.symbol}`}
          className="scroll-mt-20 sm:py-3 sm:first:pt-0 sm:last:pb-0"
        >
          <HoldingResearch
            holding={holding}
            closes={narrow}
            open={openEntry === holding.symbol}
            onToggle={() => onToggle(holding.symbol)}
          />
        </li>
      ))}
    </ul>
  );
}

function HoldingResearch({
  holding,
  closes,
  open,
  onToggle,
}: {
  holding: ResearchHolding;
  /** A phone: the reasons wait behind a tap. Elsewhere they are simply there. */
  closes: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLElement>(null);
  const latest = holding.latest;
  const panelId = useId();
  // With no rating there is nothing behind the line, so it offers nothing to open.
  const opens = closes && latest !== null;
  useRevealOnOpen(root, opens && open);
  return (
    <article ref={root} className="scroll-mt-20 sm:space-y-2">
      <div className="relative flex items-center gap-2 max-sm:min-h-11 max-sm:py-2">
        {opens && (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={t('research.toggleEntry', { symbol: holding.symbol })}
            onClick={onToggle}
            className="absolute inset-0 z-[1] rounded-lg transition active:bg-surface-hover/40"
          />
        )}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
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
        {opens && <ExpandMark open={open} />}
      </div>
      {latest && (
        <ExpandingPanel id={panelId} open={open} active={closes}>
          <div className="space-y-2 max-sm:pb-3">
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
          </div>
        </ExpandingPanel>
      )}
      {/* Outside the fold: it says the rating above is not the newest word. */}
      {holding.lastAttempt && (
        <p className="text-xs text-text-muted max-sm:pb-2">
          {t(`research.lastAttempt.${holding.lastAttempt.status}`, { date: ratedOn(holding.lastAttempt.at) })}
        </p>
      )}
    </article>
  );
}
