import { useEffect, useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { Play, Save } from 'lucide-react';

import {
  HORIZON_MAX_DECISIONS,
  HORIZON_SCHEDULES,
  MAX_DECISIONS_PER_SCAN,
  MAX_SCAN_EVERY_HOURS,
  MIN_DECISIONS_PER_SCAN,
  MIN_SCAN_EVERY_HOURS,
  minorToDecimalString,
  scansPerDay,
  type AgentView,
  type RunScanResult,
  type ScanSchedule,
} from '@traders/shared';

import { ApiRequestError } from '../api/client.ts';
import { t, useTranslation } from '../i18n/index.ts';
import { BUDGET_INPUT, agentErrorMessage } from '../lib/agentPresentation.ts';
import { formatMicroUsd } from '../lib/llmCalls.ts';
import { capResetLabel } from '../lib/monthlyCap.ts';
import { formatClockTime, formatExactTime } from '../lib/relativeTime.ts';
import { minutesUntilSoonScan, sameSchedule, scheduleTimes, schedulesAnything } from '../lib/scanTimes.ts';
import { useRunScan, useUpdateAgent } from '../queries/agents.ts';
import { useModelAccess } from '../queries/modelAccess.ts';
import { AgentField } from './AgentField.tsx';
import { OwnKeyNotice } from './OwnKeyNotice.tsx';
import { Button, Card, ErrorNote } from './ui.tsx';

/** Micro-USD per cent: a budget is set in dollars and cents. */
const MICRO_PER_CENT = 10_000;

/** A whole-cent allowance as the dollars the field shows ("0.50"). */
export function llmBudgetText(micro: number): string {
  return minorToDecimalString(Math.round(micro / MICRO_PER_CENT), 'USD');
}

/** The refusals *Run a scan now* can meet, in the reader's words; anything else, the server's. */
const RUN_REFUSALS = [
  'agent_not_active',
  'no_persona',
  'budget_spent',
  'scan_running',
  'no_model',
  'own_key_required',
  'own_key_failed',
  'safety_limit_reached',
] as const;
type RunRefusal = (typeof RUN_REFUSALS)[number];

const isRunRefusal = (code: string): code is RunRefusal => (RUN_REFUSALS as readonly string[]).includes(code);

/** Why *Run a scan now* would be refused before it is asked, or null: shared by the agent's page and its row (D252). */
export function runBlocked(agent: AgentView): RunRefusal | null {
  const spent = (agent.llmSpentTodayMicroUsd ?? 0) >= (agent.llmBudgetMicroUsd ?? 0);
  if (agent.state !== 'active') return 'agent_not_active';
  if (agent.waitingForBrief) return 'no_persona';
  if (spent) return 'budget_spent';
  return null;
}

/** A failed run in the reader's words: a known refusal from the catalogue, else the server's. */
export function runErrorText(error: Error | null): string | null {
  if (error === null) return null;
  return error instanceof ApiRequestError && isRunRefusal(error.code)
    ? t(`agents.scans.refusals.${error.code}`)
    : agentErrorMessage(error, t('agents.saveFailed'));
}

/**
 * How an agent scans (D45, D46, D52, D65, D66), in two cards on two tabs: *Run
 * a scan now* with what it is expected to cost, above the scans it has run; and
 * among the settings, the schedule with its cost per day and when the next
 * scheduled scan runs - or that this installation does not schedule them
 * (D71) - and the model budget with what today has spent.
 */
export function RunScanCard({ agent }: { agent: AgentView }) {
  return (
    <Card>
      <RunScan agent={agent} />
    </Card>
  );
}

export function ScanScheduleCard({ agent }: { agent: AgentView }) {
  const { t } = useTranslation();
  return (
    <Card title={t('agents.scans.settingsTitle')}>
      <ScanSettings agent={agent} />
    </Card>
  );
}

function RunScan({ agent }: { agent: AgentView }) {
  const { t } = useTranslation();
  const run = useRunScan(agent.id);
  // D245, D280: no scan is offered that nobody may pay for; the notice says why.
  const access = useModelAccess();
  const running = agent.runningScan;
  const soon = running ? null : minutesUntilSoonScan(agent.scheduling?.nextAt);
  const blocked = runBlocked(agent);
  const refusal = runErrorText(run.error);
  return (
    <div className="space-y-2">
      <OwnKeyNotice access={access} />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={() => run.mutate()}
          disabled={run.isPending || blocked !== null || access.block !== null || running !== null}
        >
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
      {running && !run.isPending && (
        <p role="status" className="text-sm text-text-muted">
          {t(`agents.scans.runningNow.${running.trigger}`, { since: formatClockTime(running.startedAt) })}
        </p>
      )}
      {soon !== null && blocked === null && (
        <p className="text-xs text-text-muted">
          {t('agents.scans.nextSoon', { count: soon, at: formatClockTime(agent.scheduling!.nextAt!) })}
        </p>
      )}
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
  const kept = (result.answer?.trades ?? []).filter((trade) => !trade.refused);
  const label = (trade: (typeof kept)[number]) =>
    t('agents.decisions.proposed', {
      side: t(`agents.sides.${trade.decision === 'sell' ? 'sell' : 'buy'}`),
      quantity: trade.quantity ?? '',
      symbol: trade.symbol ?? '',
    });
  return (
    <div role="status" className="space-y-1 text-sm text-text-primary">
      <p>
        {t(`agents.scans.result.${result.outcome}`, {
          trades: kept.map(label).join(' · '),
          date: capResetLabel(),
        })}
      </p>
      {/* D197: one proposal per kept trade, in the same order. */}
      {result.proposal_ids.length > 0 && (
        <p className="flex flex-wrap gap-x-3 gap-y-1">
          <span className="text-text-muted">{t('agents.scans.review')}</span>
          {result.proposal_ids.map((proposalId, index) => (
            <Link
              key={proposalId}
              to="/proposals/$proposalId"
              params={{ proposalId }}
              className="font-medium text-accent hover:underline"
            >
              {kept[index] ? label(kept[index]) : t('agents.scans.openProposal')}
            </Link>
          ))}
        </p>
      )}
    </div>
  );
}

/**
 * Where scheduled scans stand for this agent (D71): on another installation,
 * the next one's time, or none coming. Before the agent's own page has loaded
 * its scheduling, nothing is claimed.
 */
function scheduleState(agent: AgentView): string {
  const scheduling = agent.scheduling;
  if (scheduling === undefined) return '';
  if (!scheduling.enabled) return t('agents.scans.scheduleElsewhere');
  return scheduling.nextAt === null
    ? t('agents.scans.scheduleNone')
    : t('agents.scans.scheduleNext', { when: formatExactTime(scheduling.nextAt) });
}

const MANUAL_ONLY: ScanSchedule = { everyHours: null, preOpen: false, postClose: false };
/** What the hours field offers when market-hours scans are switched on: the short horizon's (D195). */
const DEFAULT_EVERY_HOURS = HORIZON_SCHEDULES.short.everyHours ?? MIN_SCAN_EVERY_HOURS;

/**
 * When the agent scans (D195): market hours every N hours, before the open,
 * after the close - any of them, or none. Below, the times that makes on a
 * regular day in the user's own time, what it costs a day, and a suggestion from
 * the agent's horizon that one press applies.
 */
function ScanSettings({ agent }: { agent: AgentView }) {
  const { t } = useTranslation();
  const update = useUpdateAgent(agent.id);
  const stored = agent.scanSchedule ?? MANUAL_ONLY;
  const storedBudget = llmBudgetText(agent.llmBudgetMicroUsd ?? 0);
  const [schedule, setSchedule] = useState<ScanSchedule>(stored);
  // The hours typed are kept while market-hours scans are off, so switching back restores them.
  const [hoursText, setHoursText] = useState(String(stored.everyHours ?? DEFAULT_EVERY_HOURS));
  const [budget, setBudget] = useState(storedBudget);
  const storedDecisions = agent.maxDecisions ?? MIN_DECISIONS_PER_SCAN;
  const [decisionsText, setDecisionsText] = useState(String(storedDecisions));
  useEffect(() => {
    setSchedule(stored);
    setHoursText(String(stored.everyHours ?? DEFAULT_EVERY_HOURS));
    setBudget(storedBudget);
    setDecisionsText(String(storedDecisions));
    // The three parts stand for `agent.scanSchedule`, whose identity changes on every read.
  }, [stored.everyHours, stored.preOpen, stored.postClose, storedBudget, storedDecisions]);

  const hours = Number(hoursText);
  const hoursValid = Number.isInteger(hours) && hours >= MIN_SCAN_EVERY_HOURS && hours <= MAX_SCAN_EVERY_HOURS;
  const marketOn = schedule.everyHours !== null;
  const budgetValid = BUDGET_INPUT.test(budget.trim());
  const decisions = Number(decisionsText);
  const decisionsValid =
    Number.isInteger(decisions) && decisions >= MIN_DECISIONS_PER_SCAN && decisions <= MAX_DECISIONS_PER_SCAN;
  const dirty =
    !sameSchedule(schedule, stored) || budget.trim() !== storedBudget || decisions !== storedDecisions;
  const perScan = agent.scanCost?.microUsd ?? 0;
  const horizon = agent.mandate?.horizon ?? null;
  const suggested = horizon ? HORIZON_SCHEDULES[horizon] : null;
  const suggestedDecisions = horizon ? HORIZON_MAX_DECISIONS[horizon] : null;
  const maxHoldings = agent.mandate?.maxHoldings ?? null;

  const setHours = (text: string) => {
    setHoursText(text);
    const value = Number(text);
    if (Number.isInteger(value) && value >= MIN_SCAN_EVERY_HOURS && value <= MAX_SCAN_EVERY_HOURS) {
      setSchedule({ ...schedule, everyHours: value });
    }
  };
  // On again: the hours last typed, or the default when what was typed is not a choice.
  const switchMarketHours = (on: boolean) => {
    if (on && !hoursValid) setHoursText(String(DEFAULT_EVERY_HOURS));
    setSchedule({ ...schedule, everyHours: on ? (hoursValid ? hours : DEFAULT_EVERY_HOURS) : null });
  };
  // The horizon's suggestion is a schedule and a number of decisions, applied together (D195, D197).
  const apply = (next: ScanSchedule, nextDecisions: number) => {
    setSchedule(next);
    if (next.everyHours !== null) setHoursText(String(next.everyHours));
    setDecisionsText(String(nextDecisions));
  };
  const differsFromSuggestion =
    suggested !== null && (!sameSchedule(suggested, schedule) || decisions !== suggestedDecisions);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate({ scanSchedule: schedule, maxDecisions: decisions, llmBudget: budget.trim() });
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">{t('agents.scans.schedule')}</legend>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={marketOn}
              onChange={(event) => switchMarketHours(event.target.checked)}
            />
            {t('agents.scans.marketHours')}
          </label>
          <label className="flex items-center gap-2">
            <span className={marketOn ? '' : 'text-text-muted'}>{t('agents.scans.every')}</span>
            <input
              type="number"
              min={MIN_SCAN_EVERY_HOURS}
              max={MAX_SCAN_EVERY_HOURS}
              step={1}
              value={hoursText}
              disabled={!marketOn}
              onChange={(event) => setHours(event.target.value)}
              aria-invalid={marketOn && !hoursValid}
              aria-label={t('agents.scans.everyHoursLabel')}
              dir="ltr"
              className="w-16 rounded-md border border-border-subtle bg-surface px-2 py-1 text-center disabled:opacity-50"
            />
            <span className={marketOn ? '' : 'text-text-muted'}>{t('agents.scans.hours', { count: hoursValid ? hours : DEFAULT_EVERY_HOURS })}</span>
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={schedule.preOpen}
            onChange={(event) => setSchedule({ ...schedule, preOpen: event.target.checked })}
          />
          {t('agents.scans.preOpen')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={schedule.postClose}
            onChange={(event) => setSchedule({ ...schedule, postClose: event.target.checked })}
          />
          {t('agents.scans.postClose')}
        </label>
        {marketOn && !hoursValid && (
          <p className="text-xs text-loss">
            {t('agents.scans.everyInvalid', { min: MIN_SCAN_EVERY_HOURS, max: MAX_SCAN_EVERY_HOURS })}
          </p>
        )}
        <SchedulePreview schedule={schedule} perScan={perScan} agent={agent} />
        <p className="text-xs text-text-muted">
          {t(`agents.scans.guidance.${horizon ?? 'none'}`)}{' '}
          {suggested && suggestedDecisions !== null && differsFromSuggestion && (
            <button
              type="button"
              onClick={() => apply(suggested, suggestedDecisions)}
              className="font-medium text-accent hover:underline"
            >
              {t('agents.scans.useSuggestion')}
            </button>
          )}
        </p>
      </fieldset>
      <AgentField
        label={t('agents.scans.decisions')}
        hint={[
          t('agents.scans.decisionsHint', { count: decisionsValid ? decisions : storedDecisions }),
          maxHoldings !== null && decisionsValid && decisions > maxHoldings
            ? t('agents.scans.decisionsOverHoldings', { max: maxHoldings })
            : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <input
          type="number"
          min={MIN_DECISIONS_PER_SCAN}
          max={MAX_DECISIONS_PER_SCAN}
          step={1}
          value={decisionsText}
          onChange={(event) => setDecisionsText(event.target.value)}
          aria-invalid={!decisionsValid}
          dir="ltr"
          className="w-20 rounded-md border border-border-subtle bg-surface px-2 py-1 text-center"
        />
      </AgentField>
      {!decisionsValid && (
        <p className="text-xs text-loss">
          {t('agents.scans.decisionsInvalid', { min: MIN_DECISIONS_PER_SCAN, max: MAX_DECISIONS_PER_SCAN })}
        </p>
      )}
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
      <Button
        type="submit"
        variant="secondary"
        disabled={!dirty || !budgetValid || !decisionsValid || (marketOn && !hoursValid) || update.isPending}
      >
        <span className="flex items-center gap-1">
          <Save className="size-4" aria-hidden />
          {t('agents.scans.save')}
        </span>
      </Button>
    </form>
  );
}

/** The times a schedule makes on a regular day, in the user's time, with its count and cost; or that it makes none. */
function SchedulePreview({ schedule, perScan, agent }: { schedule: ScanSchedule; perScan: number; agent: AgentView }) {
  const { t } = useTranslation();
  if (!schedulesAnything(schedule)) {
    return <p className="text-sm text-text-muted">{t('agents.scans.manualOnly')}</p>;
  }
  const count = scansPerDay(schedule);
  return (
    <div className="rounded-md bg-surface px-3 py-2 text-sm">
      <p>{t('agents.scans.times', { times: scheduleTimes(schedule).map(formatClockTime).join(', ') })}</p>
      <p className="text-xs text-text-muted">
        {t('agents.scans.perDay', { count, cost: formatMicroUsd(perScan * count) })} {scheduleState(agent)}
      </p>
    </div>
  );
}
