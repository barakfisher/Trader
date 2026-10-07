import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { parseToMinor, type AgentScanDetail, type AgentScanStep, type AgentScanSummary } from '@traders/shared';

import { errorMessage } from '../api/client.ts';
import { useTranslation } from '../i18n/index.ts';
import { formatMoney, formatNumber } from '../i18n/format.ts';
import { formatMicroUsd } from '../lib/llmCalls.ts';
import { formatExactTime } from '../lib/relativeTime.ts';
import { MIRROR_IN_RTL } from '../lib/textDirection.ts';
import { useAgentScanQuery, useAgentScansQuery } from '../queries/agents.ts';
import { Button, Card, EmptyState, ErrorNote, Spinner } from './ui.tsx';

/**
 * The *Decisions* tab (D50, D64): every scan the agent ran - one that proposed,
 * one that did nothing, one that ran out of budget - with what it cost. A row
 * opens to the reasoning as readable steps: what the briefing held, each tool
 * the model chose with its arguments, the result folded away as the JSON the
 * model read, and the answer with its thesis. A proposal links to its page and
 * a fill to the Activity tab. Showing the scans that did nothing is the point:
 * the money spent on "no trade" is real, and so is the reasoning behind it.
 */
export function AgentDecisions({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const scans = useAgentScansQuery(agentId);
  if (scans.isPending) return <Spinner label={t('agents.decisions.loading')} />;
  if (scans.error) {
    return (
      <ErrorNote
        message={errorMessage(scans.error, t('agents.decisions.loadFailed'))}
        onRetry={() => void scans.refetch()}
      />
    );
  }
  const rows = scans.data.pages.flatMap((page) => page.scans);
  if (rows.length === 0) {
    return <EmptyState title={t('agents.tabs.decisions')} body={t('agents.decisions.empty')} />;
  }
  return (
    <Card>
      <ul className="divide-y divide-border-subtle/60">
        {rows.map((scan) => (
          <ScanRow key={scan.id} agentId={agentId} scan={scan} />
        ))}
      </ul>
      {scans.hasNextPage && (
        <Button
          variant="secondary"
          className="mt-3"
          onClick={() => void scans.fetchNextPage()}
          disabled={scans.isFetchingNextPage}
        >
          {t('agents.decisions.older')}
        </Button>
      )}
    </Card>
  );
}

function outcomeClass(scan: AgentScanSummary): string {
  if (scan.outcome === 'trade') return 'bg-accent/15 text-accent';
  if (scan.outcome === 'failed' || scan.outcome === 'invalid_answer') return 'bg-loss/15 text-loss';
  if (scan.outcome === 'budget_reached' || scan.outcome === 'step_limit') return 'bg-warn/15 text-warn';
  return 'bg-surface-hover text-text-muted';
}

function ScanRow({ agentId, scan }: { agentId: string; scan: AgentScanSummary }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center justify-between gap-2 text-start text-sm"
      >
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          {open ? (
            <ChevronDown className="size-4 shrink-0 text-text-muted" aria-hidden />
          ) : (
            <ChevronRight className={`size-4 shrink-0 text-text-muted ${MIRROR_IN_RTL}`} aria-hidden />
          )}
          <span className="text-text-primary">{formatExactTime(scan.startedAt)}</span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${outcomeClass(scan)}`}>
            {t(`agents.decisions.outcomes.${scan.outcome ?? 'running'}`)}
          </span>
          {scan.decision !== null && scan.decision !== 'none' && scan.symbol !== null && (
            <span className="text-xs text-text-primary">
              {t('agents.decisions.proposed', {
                side: t(`agents.sides.${scan.decision}`),
                quantity: scan.quantity ?? '',
                symbol: scan.symbol,
              })}
            </span>
          )}
          <span className="text-xs text-text-muted">{t(`agents.decisions.trigger.${scan.trigger}`)}</span>
        </span>
        <span className="text-xs text-text-muted">
          <bdi>
            {t('agents.decisions.cost', { cost: formatMicroUsd(scan.costMicroUsd), count: scan.steps })}
          </bdi>
        </span>
      </button>
      {open && <ScanDetail agentId={agentId} scanId={scan.id} />}
    </li>
  );
}

function ScanDetail({ agentId, scanId }: { agentId: string; scanId: string }) {
  const { t } = useTranslation();
  const scan = useAgentScanQuery(agentId, scanId, true);
  if (scan.isPending) return <Spinner label={t('agents.decisions.loading')} />;
  if (scan.error) {
    return <ErrorNote message={errorMessage(scan.error, t('agents.decisions.loadFailed'))} />;
  }
  const data = scan.data;
  return (
    <div className="ms-6 mt-2 space-y-3 border-s border-border-subtle ps-3 text-xs">
      <Briefing briefing={data.briefing} />
      {data.transcript.map((step, index) =>
        isAnswerTurn(step) ? (
          // The model's last turn is its answer, shown read below; here only its raw form.
          <Folded key={index} label={t('agents.decisions.rawAnswer')} value={parsed(step.text)} />
        ) : (
          <Step key={index} step={step} />
        ),
      )}
      <Answer scan={data} />
    </div>
  );
}

/** A turn that called no tool is the answer (scan.py): the loop ends on it. */
function isAnswerTurn(step: AgentScanStep): step is Extract<AgentScanStep, { role: 'assistant' }> {
  return step.role === 'assistant' && step.toolCalls.length === 0;
}

/** The answer as the JSON it was, when it was JSON; else its text. */
function parsed(text: string | null): unknown {
  try {
    return JSON.parse(text ?? '');
  } catch {
    return text;
  }
}

/** What the scan started from, in one line; the whole briefing folded beneath it. */
function Briefing({ briefing }: { briefing: unknown }) {
  const { t } = useTranslation();
  const brief = (briefing ?? {}) as { cash?: unknown; holdings?: unknown; movers?: Record<string, unknown> };
  const cashMinor = typeof brief.cash === 'string' ? parseToMinor(brief.cash, 'USD') : null;
  const holdings = Array.isArray(brief.holdings) ? brief.holdings.length : 0;
  const movers = Object.values(brief.movers ?? {}).reduce<number>(
    (count, list) => count + (Array.isArray(list) ? list.length : 0),
    0,
  );
  return (
    <div className="space-y-1">
      <p className="text-text-muted">
        {t('agents.decisions.briefing', {
          cash: formatMoney(cashMinor, 'USD'),
          holdings: formatNumber(holdings),
          movers: formatNumber(movers),
        })}
      </p>
      <Folded label={t('agents.decisions.briefingRaw')} value={briefing} />
    </div>
  );
}

function Step({ step }: { step: AgentScanStep }) {
  const { t } = useTranslation();
  if (step.role === 'tool') {
    return <Folded label={t('agents.decisions.result')} value={step.result} />;
  }
  return (
    <div className="space-y-1">
      {step.text && (
        <p className="text-text-primary">
          <span className="font-medium text-text-muted">{t('agents.decisions.thought')}: </span>
          {/* The model writes in the user's language, or not: its own text decides its direction. */}
          <span dir="auto">{step.text}</span>
        </p>
      )}
      {step.toolCalls.map((call) => (
        <p key={call.id} className="font-medium text-text-primary">
          {t('agents.decisions.called', { tool: call.name })}{' '}
          <code dir="ltr" className="rounded bg-surface-hover px-1 font-normal text-text-muted">
            {JSON.stringify(call.arguments)}
          </code>
        </p>
      ))}
    </div>
  );
}

/** JSON the model read, closed until asked for: it is evidence, not prose. */
function Folded({ label, value }: { label: string; value: unknown }) {
  return (
    <details>
      <summary className="cursor-pointer text-text-muted">{label}</summary>
      <pre dir="ltr" className="mt-1 max-h-72 overflow-auto rounded bg-surface-hover p-2 text-[11px] text-start">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

function Answer({ scan }: { scan: AgentScanDetail }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1 rounded-md border border-border-subtle p-2">
      <p className="font-medium text-text-primary">{t('agents.decisions.answer')}</p>
      {scan.thesis && (
        <p dir="auto" className="text-sm text-text-primary">
          {scan.thesis}
        </p>
      )}
      {scan.problems.length > 0 && (
        <p className="text-loss">{t('agents.decisions.problems', { problems: scan.problems.join('; ') })}</p>
      )}
      {scan.error && <p className="text-loss">{t('agents.decisions.error', { error: scan.error })}</p>}
      {scan.proposal && (
        <p>
          <Link
            to="/proposals/$proposalId"
            params={{ proposalId: scan.proposal.id }}
            className="font-medium text-accent hover:underline"
          >
            {t('agents.decisions.proposal')}
          </Link>{' '}
          <span className="text-text-muted">
            {t('agents.decisions.proposalState', { state: t(`proposal.states.${scan.proposal.state}`) })}
          </span>
        </p>
      )}
      {scan.fillId && <p className="text-text-muted">{t('agents.decisions.fill')}</p>}
      {scan.model && <p className="text-text-muted">{t('agents.decisions.model', { model: scan.model })}</p>}
    </div>
  );
}
