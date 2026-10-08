import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { Archive, ArrowLeft, ArrowLeftRight, Pause, Play, RotateCcw, Save } from 'lucide-react';

import type { AgentState, AgentView, TradeSide } from '@traders/shared';

import { AccountSummary, AgentActivity, AgentHoldings } from '../components/AgentAccount.tsx';
import { AgentDecisions } from '../components/AgentDecisions.tsx';
import { AgentPerformance } from '../components/AgentPerformance.tsx';
import { AgentScans } from '../components/AgentScans.tsx';
import { TradePanel } from '../components/TradePanel.tsx';
import { AgentField } from '../components/AgentField.tsx';
import { Disclaimer } from '../components/Disclaimer.tsx';
import { Button, Card, ErrorNote, Spinner, buttonClass } from '../components/ui.tsx';
import { errorMessage } from '../api/client.ts';
import { useTranslation } from '../i18n/index.ts';
import { formatMoney } from '../i18n/format.ts';
import { minorToDecimalString } from '@traders/shared';
import { BUDGET_INPUT, agentErrorMessage, agentName, agentStateWord } from '../lib/agentPresentation.ts';
import { MIRROR_IN_RTL } from '../lib/textDirection.ts';
import { useAgentQuery, useUpdateAgent } from '../queries/agents.ts';
import { KindBadge, WaitingForPersona } from './AgentsPage.tsx';

type Tab = 'holdings' | 'activity' | 'decisions';

/**
 * One agent (decision D19): its account, its settings and persona, and the
 * Holdings and Activity tabs filled by Stage 3's ledger - trades placed by
 * hand from the Trade panel (D21), cash added (D22), every movement listed
 * with the balance it left (D31). The primary has no account or settings - it
 * is the real portfolio, and passive (D1) - so its page points to the
 * dashboard, where the real portfolio lives.
 */
export function AgentPage() {
  const { agentId } = useParams({ from: '/agents/$agentId' });
  const { t } = useTranslation();
  const agent = useAgentQuery(agentId);

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-base font-semibold">
            {/* A user's name for an agent, in either script: isolated, like a topic label. */}
            <bdi>{agent.data ? agentName(agent.data) : t('agents.title')}</bdi>
          </h1>
          {agent.data && <KindBadge agent={agent.data} />}
          {agent.data && agent.data.state !== 'active' && (
            <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-text-muted">
              {agentStateWord(agent.data.state)}
            </span>
          )}
          {agent.data?.waitingForPersona && <WaitingForPersona />}
        </div>
        <Link to="/agents" className={buttonClass('secondary')}>
          <span className="flex items-center gap-1">
            <ArrowLeft className={`size-4 ${MIRROR_IN_RTL}`} aria-hidden />
            {t('agents.backToAgents')}
          </span>
        </Link>
      </header>

      {agent.isPending && <Spinner label={t('agents.loading')} />}
      {agent.error && (
        <ErrorNote
          message={errorMessage(agent.error, t('agents.loadFailed'))}
          onRetry={() => void agent.refetch()}
        />
      )}
      {agent.data && (agent.data.isPrimary ? <PrimaryNote /> : <SimulatedAgent agent={agent.data} />)}
      <Disclaimer />
    </div>
  );
}

function PrimaryNote() {
  const { t } = useTranslation();
  return (
    <Card>
      <p className="text-sm text-text-muted">{t('agents.primaryNote')}</p>
      <Link to="/" className={`${buttonClass('secondary')} mt-3`}>
        {t('common.backToPortfolio')}
      </Link>
    </Card>
  );
}

function SimulatedAgent({ agent }: { agent: AgentView }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('holdings');
  const [trading, setTrading] = useState<{ symbol: string; side: TradeSide } | null>(null);
  const canTrade = agent.state !== 'archived';
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text-muted">
          {t('agents.budgetLine', { budget: formatMoney(agent.budgetMinor, agent.currency) })}
        </p>
        {canTrade && (
          <Button onClick={() => setTrading({ symbol: '', side: 'buy' })}>
            <span className="flex items-center gap-1">
              <ArrowLeftRight className="size-4" aria-hidden />
              {t('agents.trade.open')}
            </span>
          </Button>
        )}
      </div>
      <AccountSummary agent={agent} />
      <AgentPerformance agentId={agent.id} />
      <StateControls agent={agent} />
      <div role="tablist" className="flex gap-2 border-b border-border-subtle">
        {(['holdings', 'activity', 'decisions'] as const).map((name) => (
          <button
            key={name}
            role="tab"
            type="button"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              tab === name ? 'border-accent text-text-primary' : 'border-transparent text-text-muted'
            }`}
          >
            {t(`agents.tabs.${name}`)}
          </button>
        ))}
      </div>
      {tab === 'holdings' && (
        <AgentHoldings agent={agent} onSell={(symbol) => setTrading({ symbol, side: 'sell' })} />
      )}
      {tab === 'activity' && <AgentActivity agent={agent} />}
      {tab === 'decisions' && <AgentDecisions agentId={agent.id} />}
      <AgentScans agent={agent} />
      <SettingsForm agent={agent} />
      {trading && (
        <TradePanel
          agentId={agent.id}
          initialSymbol={trading.symbol}
          initialSide={trading.side}
          onClose={() => setTrading(null)}
        />
      )}
    </>
  );
}

function StateControls({ agent }: { agent: AgentView }) {
  const { t } = useTranslation();
  const update = useUpdateAgent(agent.id);
  const set = (state: AgentState) => update.mutate({ state });
  return (
    <div className="flex flex-wrap items-center gap-2">
      {agent.state === 'active' && (
        <Button variant="secondary" onClick={() => set('paused')} disabled={update.isPending}>
          <span className="flex items-center gap-1">
            <Pause className="size-4" aria-hidden />
            {t('agents.actions.pause')}
          </span>
        </Button>
      )}
      {agent.state === 'paused' && (
        <Button variant="secondary" onClick={() => set('active')} disabled={update.isPending}>
          <span className="flex items-center gap-1">
            <Play className="size-4" aria-hidden />
            {t('agents.actions.resume')}
          </span>
        </Button>
      )}
      {agent.state === 'archived' ? (
        <Button variant="secondary" onClick={() => set('active')} disabled={update.isPending}>
          <span className="flex items-center gap-1">
            <RotateCcw className="size-4" aria-hidden />
            {t('agents.actions.restore')}
          </span>
        </Button>
      ) : (
        <Button variant="danger" onClick={() => set('archived')} disabled={update.isPending}>
          <span className="flex items-center gap-1">
            <Archive className="size-4" aria-hidden />
            {t('agents.actions.archive')}
          </span>
        </Button>
      )}
      <span className="text-xs text-text-muted">{t('agents.stateHint')}</span>
      {update.error && <ErrorNote message={agentErrorMessage(update.error, t('agents.saveFailed'))} />}
    </div>
  );
}

function SettingsForm({ agent }: { agent: AgentView }) {
  const { t } = useTranslation();
  const update = useUpdateAgent(agent.id);
  const storedBudget = agent.budgetMinor === null ? '' : minorToDecimalString(agent.budgetMinor, agent.currency);
  const [name, setName] = useState(agent.name);
  const [budget, setBudget] = useState(storedBudget);
  const [persona, setPersona] = useState(agent.persona ?? '');
  // A save, or another tab's, re-renders with the stored values.
  useEffect(() => {
    setName(agent.name);
    setBudget(storedBudget);
    setPersona(agent.persona ?? '');
  }, [agent.name, storedBudget, agent.persona]);

  const dirty = name !== agent.name || budget !== storedBudget || persona !== (agent.persona ?? '');
  const budgetValid = BUDGET_INPUT.test(budget.trim());

  const submit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate({ name: name.trim(), budget: budget.trim(), persona: persona.trim() || null });
  };

  return (
    <Card title={t('agents.settings')}>
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
        <AgentField label={t('agents.fields.budget')} hint={t('agents.fields.budgetEditHint')}>
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
        <AgentField label={t('agents.fields.persona')} hint={t('agents.fields.personaHint')}>
          <textarea
            value={persona}
            onChange={(event) => setPersona(event.target.value)}
            maxLength={4000}
            dir="auto"
            rows={6}
            className="w-full rounded-md border border-border-subtle bg-surface px-3 py-2"
          />
        </AgentField>
        {update.error && <ErrorNote message={agentErrorMessage(update.error, t('agents.saveFailed'))} />}
        <Button type="submit" disabled={!dirty || update.isPending || !name.trim() || !budgetValid}>
          <span className="flex items-center gap-1">
            <Save className="size-4" aria-hidden />
            {t('agents.save')}
          </span>
        </Button>
      </form>
    </Card>
  );
}
