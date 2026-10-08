import { useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, Bot, Plus } from 'lucide-react';

import type { AgentView, SimulatedAgentStanding } from '@traders/shared';

import { AgentField } from '../components/AgentField.tsx';
import { Disclaimer } from '../components/Disclaimer.tsx';
import { Button, Card, ErrorNote, Spinner, buttonClass } from '../components/ui.tsx';
import { errorMessage } from '../api/client.ts';
import { useTranslation } from '../i18n/index.ts';
import { formatMoney } from '../i18n/format.ts';
import { BUDGET_INPUT, agentErrorMessage, agentName, agentStateWord } from '../lib/agentPresentation.ts';
import { MIRROR_IN_RTL } from '../lib/textDirection.ts';
import { useAgentsQuery, useCreateAgent } from '../queries/agents.ts';
import { useConsolidatedQuery } from '../queries/portfolio.ts';

/**
 * Agents: the user's real portfolio and their simulated ones (multi-agent
 * Stage 2, decisions D17-D20). Management only - an agent cannot trade yet, so
 * the page says what one is for rather than showing figures it does not have.
 */
export function AgentsPage() {
  const { t } = useTranslation();
  const agents = useAgentsQuery();
  // Each simulated agent's net worth (D19), valued as its own page values it.
  // An archived agent is not valued here; its page still is.
  const hasSimulated = (agents.data ?? []).some((agent) => !agent.isPrimary && agent.state !== 'archived');
  const standings = new Map(
    (useConsolidatedQuery(hasSimulated).data?.agents ?? []).map((standing) => [standing.agentId, standing]),
  );

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Bot className="size-5 text-accent" aria-hidden />
          <h1 className="text-base font-semibold">{t('agents.title')}</h1>
        </div>
        <Link to="/" className={buttonClass('secondary')}>
          <span className="flex items-center gap-1">
            <ArrowLeft className={`size-4 ${MIRROR_IN_RTL}`} aria-hidden />
            {t('common.backToPortfolio')}
          </span>
        </Link>
      </header>

      <p className="max-w-3xl text-sm text-text-muted">{t('agents.intro')}</p>

      {agents.isPending && <Spinner label={t('agents.loading')} />}
      {agents.error && (
        <ErrorNote
          message={errorMessage(agents.error, t('agents.loadFailed'))}
          onRetry={() => void agents.refetch()}
        />
      )}
      {agents.data && (
        <ul className="space-y-2">
          {agents.data.map((agent) => (
            <li key={agent.id}>
              <AgentRow agent={agent} standing={standings.get(agent.id) ?? null} />
            </li>
          ))}
        </ul>
      )}

      <CreateAgentForm />
      <Disclaimer />
    </div>
  );
}

function AgentRow({ agent, standing }: { agent: AgentView; standing: SimulatedAgentStanding | null }) {
  const { t } = useTranslation();
  return (
    <Link
      to="/agents/$agentId"
      params={{ agentId: agent.id }}
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-subtle bg-surface-raised px-4 py-3 hover:border-accent"
    >
      <span className="flex flex-wrap items-center gap-2">
        <bdi className="font-medium">{agentName(agent)}</bdi>
        <KindBadge agent={agent} />
        {agent.state !== 'active' && (
          <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-text-muted">
            {agentStateWord(agent.state)}
          </span>
        )}
        {agent.waitingForPersona && <WaitingForPersona />}
      </span>
      <span className="text-sm text-text-muted">
        {agent.isPrimary
          ? t('agents.holdingsCount', { count: agent.holdingsCount })
          : standing
            ? t('agents.netWorthLine', {
                netWorth: formatMoney(standing.netWorthMinor, standing.currency),
                budget: formatMoney(agent.budgetMinor, agent.currency),
              })
            : t('agents.budgetLine', { budget: formatMoney(agent.budgetMinor, agent.currency) })}
      </span>
    </Link>
  );
}

/** Real or simulated, on every agent the page shows: the label is the point (P2). */
/** An active agent with no persona never scans and is never billed (D52). */
export function WaitingForPersona() {
  const { t } = useTranslation();
  return (
    <span className="rounded-full bg-warn/15 px-2 py-0.5 text-xs text-warn">{t('agents.waitingForPersona')}</span>
  );
}

export function KindBadge({ agent }: { agent: Pick<AgentView, 'isPrimary'> }) {
  const { t } = useTranslation();
  return agent.isPrimary ? (
    <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
      {t('agents.real')}
    </span>
  ) : (
    <span className="rounded-full border border-border-subtle px-2 py-0.5 text-xs text-text-muted">
      {t('agents.simulated')}
    </span>
  );
}

function CreateAgentForm() {
  const { t } = useTranslation();
  const create = useCreateAgent();
  const [name, setName] = useState('');
  const [budget, setBudget] = useState('');
  const [persona, setPersona] = useState('');
  const budgetValid = BUDGET_INPUT.test(budget.trim());

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { name: name.trim(), budget: budget.trim(), persona: persona.trim() || null },
      {
        onSuccess: () => {
          setName('');
          setBudget('');
          setPersona('');
        },
      },
    );
  };

  return (
    <Card title={t('agents.create.title')}>
      <form onSubmit={submit} className="space-y-3">
        <AgentField label={t('agents.fields.name')}>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
            dir="auto"
            required
            className="w-full rounded-md border border-border-subtle bg-surface px-3 py-2"
          />
        </AgentField>
        <AgentField label={t('agents.fields.budget')} hint={t('agents.fields.budgetHint')}>
          <input
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
            inputMode="decimal"
            dir="ltr"
            placeholder="1000"
            required
            aria-invalid={budget !== '' && !budgetValid}
            className="w-full rounded-md border border-border-subtle bg-surface px-3 py-2 text-start"
          />
        </AgentField>
        <AgentField label={t('agents.fields.persona')} hint={t('agents.fields.personaHint')}>
          <textarea
            value={persona}
            onChange={(event) => setPersona(event.target.value)}
            maxLength={4000}
            dir="auto"
            rows={4}
            className="w-full rounded-md border border-border-subtle bg-surface px-3 py-2"
          />
        </AgentField>
        {create.error && <ErrorNote message={agentErrorMessage(create.error, t('agents.create.failed'))} />}
        <Button type="submit" disabled={create.isPending || !name.trim() || !budgetValid}>
          <span className="flex items-center gap-1">
            <Plus className="size-4" aria-hidden />
            {t('agents.create.submit')}
          </span>
        </Button>
      </form>
    </Card>
  );
}
