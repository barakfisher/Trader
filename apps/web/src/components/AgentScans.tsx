import { useEffect, useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { Play, Save } from 'lucide-react';

import {
  minorToDecimalString,
  SCAN_SCHEDULES,
  SCANS_PER_DAY,
  type AgentView,
  type RunScanResult,
  type ScanSchedule,
} from '@traders/shared';

import { ApiRequestError } from '../api/client.ts';
import { useTranslation } from '../i18n/index.ts';
import { BUDGET_INPUT, agentErrorMessage } from '../lib/agentPresentation.ts';
import { formatMicroUsd } from '../lib/llmCalls.ts';
import { useRunScan, useUpdateAgent } from '../queries/agents.ts';
import { AgentField } from './AgentField.tsx';
import { Button, Card, ErrorNote } from './ui.tsx';

/** Micro-USD per cent: a budget is set in dollars and cents. */
const MICRO_PER_CENT = 10_000;

/** A whole-cent allowance as the dollars the field shows ("0.50"). */
export function llmBudgetText(micro: number): string {
  return minorToDecimalString(Math.round(micro / MICRO_PER_CENT), 'USD');
}

/** The refusals *Run a scan now* can meet, in the reader's words; anything else, the server's. */
const RUN_REFUSALS = ['agent_not_active', 'no_persona', 'budget_spent', 'scan_running', 'no_model'] as const;
type RunRefusal = (typeof RUN_REFUSALS)[number];

const isRunRefusal = (code: string): code is RunRefusal => (RUN_REFUSALS as readonly string[]).includes(code);

/**
 * How an agent scans (D45, D46, D52, D65, D66): *Run a scan now* with what it
 * is expected to cost, the schedule with its cost per day, and the model budget
 * with what today has spent. The schedule is stored now and acted on when
 * scheduled scans arrive; until then the card says so rather than implying
 * scans are running.
 */
export function AgentScans({ agent }: { agent: AgentView }) {
  const { t } = useTranslation();
  return (
    <Card title={t('agents.scans.title')}>
      <div className="space-y-4">
        <RunScan agent={agent} />
        <ScanSettings agent={agent} />
      </div>
    </Card>
  );
}

function RunScan({ agent }: { agent: AgentView }) {
  const { t } = useTranslation();
  const run = useRunScan(agent.id);
  const spent = (agent.llmSpentTodayMicroUsd ?? 0) >= (agent.llmBudgetMicroUsd ?? 0);
  const blocked: RunRefusal | null =
    agent.state !== 'active'
      ? 'agent_not_active'
      : agent.waitingForPersona
        ? 'no_persona'
        : spent
          ? 'budget_spent'
          : null;
  const refusal =
    run.error instanceof ApiRequestError && isRunRefusal(run.error.code)
      ? t(`agents.scans.refusals.${run.error.code}`)
      : run.error
        ? agentErrorMessage(run.error, t('agents.saveFailed'))
        : null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => run.mutate()} disabled={run.isPending || blocked !== null}>
          <span className="flex items-center gap-1">
            <Play className="size-4" aria-hidden />
            {t('agents.scans.run')}
          </span>
        </Button>
        {agent.scanCost && (
          <span className="text-xs text-text-muted">
            {t('agents.scans.runCost', {
              cost: formatMicroUsd(agent.scanCost.microUsd),
              basis: t(`agents.scans.basis.${agent.scanCost.basis}`),
            })}
          </span>
        )}
      </div>
      {blocked !== null && <p className="text-xs text-text-muted">{t(`agents.scans.refusals.${blocked}`)}</p>}
      {run.isPending && (
        <p role="status" className="text-sm text-text-muted">
          {t('agents.scans.running')}
        </p>
      )}
      {refusal && <ErrorNote message={refusal} />}
      {run.data && <RunResult result={run.data} />}
    </div>
  );
}

function RunResult({ result }: { result: RunScanResult }) {
  const { t } = useTranslation();
  const side = result.answer?.decision === 'sell' ? 'sell' : 'buy';
  return (
    <p role="status" className="text-sm text-text-primary">
      {t(`agents.scans.result.${result.outcome}`, {
        side: t(`agents.sides.${side}`),
        quantity: result.answer?.quantity ?? '',
        symbol: result.answer?.symbol ?? '',
      })}{' '}
      {result.proposal_id && (
        <Link
          to="/proposals/$proposalId"
          params={{ proposalId: result.proposal_id }}
          className="font-medium text-accent hover:underline"
        >
          {t('agents.scans.openProposal')}
        </Link>
      )}
    </p>
  );
}

function ScanSettings({ agent }: { agent: AgentView }) {
  const { t } = useTranslation();
  const update = useUpdateAgent(agent.id);
  const storedSchedule = agent.scanSchedule ?? 'pre_open';
  const storedBudget = llmBudgetText(agent.llmBudgetMicroUsd ?? 0);
  const [schedule, setSchedule] = useState<ScanSchedule>(storedSchedule);
  const [budget, setBudget] = useState(storedBudget);
  useEffect(() => {
    setSchedule(storedSchedule);
    setBudget(storedBudget);
  }, [storedSchedule, storedBudget]);

  const budgetValid = BUDGET_INPUT.test(budget.trim());
  const dirty = schedule !== storedSchedule || budget.trim() !== storedBudget;
  const perScan = agent.scanCost?.microUsd ?? 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate({ scanSchedule: schedule, llmBudget: budget.trim() });
  };

  return (
    <form onSubmit={submit} className="space-y-3 border-t border-border-subtle pt-3">
      <AgentField
        label={t('agents.scans.schedule')}
        hint={`${t('agents.scans.scheduleCost', { perDay: formatMicroUsd(perScan * SCANS_PER_DAY[schedule]) })} ${t('agents.scans.scheduleNotRunning')}`}
      >
        <select
          value={schedule}
          onChange={(event) => setSchedule(event.target.value as ScanSchedule)}
          className="w-full rounded-md border border-border-subtle bg-surface px-3 py-2"
        >
          {SCAN_SCHEDULES.map((choice) => (
            <option key={choice} value={choice}>
              {t(`agents.scans.schedules.${choice}`)}
            </option>
          ))}
        </select>
      </AgentField>
      <AgentField
        label={t('agents.scans.budget')}
        hint={t('agents.scans.budgetHint', {
          spent: formatMicroUsd(agent.llmSpentTodayMicroUsd ?? 0),
          budget: formatMicroUsd(agent.llmBudgetMicroUsd ?? 0),
        })}
      >
        <input
          value={budget}
          onChange={(event) => setBudget(event.target.value)}
          inputMode="decimal"
          dir="ltr"
          required
          aria-invalid={!budgetValid}
          className="w-full rounded-md border border-border-subtle bg-surface px-3 py-2 text-start"
        />
      </AgentField>
      {update.error && <ErrorNote message={agentErrorMessage(update.error, t('agents.saveFailed'))} />}
      <Button type="submit" variant="secondary" disabled={!dirty || !budgetValid || update.isPending}>
        <span className="flex items-center gap-1">
          <Save className="size-4" aria-hidden />
          {t('agents.scans.save')}
        </span>
      </Button>
    </form>
  );
}
