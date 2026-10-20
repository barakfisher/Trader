import { useId, useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { Bot, Plus } from 'lucide-react';

import { MAX_AGENTS_PER_USER_CEILING, type AgentView, type SimulatedAgentStanding } from '@traders/shared';

import { AgentField } from '../components/AgentField.tsx';
import { InstructionsField } from '../components/InstructionsField.tsx';
import { MandateFields } from '../components/MandateFields.tsx';
import { Disclaimer } from '../components/Disclaimer.tsx';
import { Drawer } from '../components/Drawer.tsx';
import { Button, ErrorNote, Spinner } from '../components/ui.tsx';
import { errorMessage } from '../api/client.ts';
import { useTranslation } from '../i18n/index.ts';
import { formatMoney } from '../i18n/format.ts';
import {
  EMPTY_MANDATE_DRAFT,
  describeMandate,
  mandateInput,
  mandateProblems,
  riskBand,
  templateMandate,
  withMandate,
  type MandateDraft,
} from '../lib/agentMandate.ts';
import {
  BUDGET_INPUT,
  activeCount,
  agentErrorMessage,
  agentName,
  agentStateWord,
  atActiveLimit,
  atCeiling,
} from '../lib/agentPresentation.ts';
import {
  PERSONA_TEMPLATES,
  replaceableBy,
  templateName,
  templatePersona,
  type PersonaTemplate,
} from '../lib/personaTemplates.ts';
import { useAgentLimitQuery, useAgentsQuery, useCheckInstructions, useCreateAgent } from '../queries/agents.ts';
import { useConsolidatedQuery } from '../queries/portfolio.ts';
import { useTaxonomyQuery } from '../queries/taxonomy.ts';

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
  const limit = useAgentLimitQuery().data ?? null;
  // D199, D200: at the limit the page says so, and a new agent starts paused.
  const full = atActiveLimit(limit);
  // D202: at the ceiling no agent can be created at all.
  const ceiling = atCeiling(limit);
  const [creating, setCreating] = useState(false);
  // The draft outlives the drawer: Escape or a stray click on the shade closes
  // it, and a persona half-written is not lost to that.
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  // Here, not in the form: the drawer closes on create, and the check outlives it (D178).
  const check = useCheckInstructions();

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Bot className="size-5 text-accent" aria-hidden />
          <h1 className="text-base font-semibold">{t('agents.title')}</h1>
        </div>
        <div className="flex items-center gap-3">
          {limit && (
            <span className="text-xs text-text-muted">{activeCount(limit)}</span>
          )}
          <Button disabled={ceiling} onClick={() => setCreating(true)}>
            <span className="flex items-center gap-1">
              <Plus className="size-4" aria-hidden />
              {t('agents.create.title')}
            </span>
          </Button>
        </div>
      </header>

      <p className="max-w-3xl text-sm text-text-muted">{t('agents.intro')}</p>
      {ceiling ? (
        <p className="text-sm text-text-muted">{t('agents.limit.ceiling', { max: MAX_AGENTS_PER_USER_CEILING })}</p>
      ) : (
        full && <p className="text-sm text-text-muted">{t('agents.limit.full', { max: limit.max })}</p>
      )}

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

      {creating && (
        <Drawer title={t('agents.create.title')} closeLabel={t('common.close')} onClose={() => setCreating(false)}>
          <CreateAgentForm
            draft={draft}
            onChange={setDraft}
            pausedAtLimit={full ? limit.max : null}
            onCreated={(agentId, needsCheck) => {
              setDraft(EMPTY_DRAFT);
              setCreating(false);
              if (needsCheck) check.mutate(agentId);
            }}
          />
        </Drawer>
      )}
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
        {agent.waitingForBrief && <WaitingForBrief />}
        {agent.instructionsConflicts && (
          <span className="rounded-full bg-warn/15 px-2 py-0.5 text-xs text-warn">{t('agents.check.badge')}</span>
        )}
        <MandateSummary agent={agent} />
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

/** The prompt-side of a mandate in words, beside the agent's name: how bold, how long. */
function MandateSummary({ agent }: { agent: AgentView }) {
  const { t } = useTranslation();
  const band = riskBand(agent.mandate?.riskLevel ?? null);
  const horizon = agent.mandate?.horizon ?? null;
  if (!band && !horizon) return null;
  const words = [
    band ? t(`agents.mandate.bands.${band}`) : null,
    horizon ? t(`agents.mandate.horizonWords.${horizon}`) : null,
  ].filter((word): word is string => word !== null);
  return <span className="text-xs text-text-muted">{words.join(' · ')}</span>;
}

/** Real or simulated, on every agent the page shows: the label is the point (P2). */
/** An active agent with no persona never scans and is never billed (D52). */
export function WaitingForBrief() {
  const { t } = useTranslation();
  return (
    <span className="rounded-full bg-warn/15 px-2 py-0.5 text-xs text-warn">{t('agents.waitingForBrief')}</span>
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

interface AgentDraft {
  name: string;
  budget: string;
  persona: string;
  /** The instructions last written from the settings (D174): while `persona` equals it, it is rewritten. */
  generated: string;
  mandate: MandateDraft;
}

const EMPTY_DRAFT: AgentDraft = { name: '', budget: '', persona: '', generated: '', mandate: EMPTY_MANDATE_DRAFT };

function CreateAgentForm({
  draft,
  onChange,
  pausedAtLimit,
  onCreated,
}: {
  draft: AgentDraft;
  onChange: (draft: AgentDraft) => void;
  /** The limit when it is reached, so the agent is created paused (D200); else null. */
  pausedAtLimit: number | null;
  /** `needsCheck`: the instructions are the user's own words, so they may contradict the settings (D176). */
  onCreated: (agentId: string, needsCheck: boolean) => void;
}) {
  const { t } = useTranslation();
  const create = useCreateAgent();
  const taxonomy = useTaxonomyQuery();
  const { name, budget, persona, generated, mandate } = draft;
  const budgetValid = BUDGET_INPUT.test(budget.trim());
  const mandateValid = mandateProblems(mandate).length === 0;
  // A disabled button says why (D225): what is still missing, beside it.
  const missing = [
    !name.trim() && t('agents.create.missingName'),
    budget.trim() === '' ? t('agents.create.missingBudget') : !budgetValid && t('agents.create.invalidBudget'),
  ].filter((reason): reason is string => Boolean(reason));
  // Instructions the user wrote are never replaced by a click; text a template
  // or the settings wrote may be.
  const templatesAvailable = replaceableBy(persona, templatePersona) || persona === generated;

  const applyTemplate = (template: PersonaTemplate) => {
    // A template is a full preset (D168): its mandate, and its own words as the instructions.
    const next = templateMandate(template, taxonomy.data);
    onChange({
      ...draft,
      name: replaceableBy(name, templateName) ? templateName(template) : name,
      persona: templatePersona(template),
      generated: describeMandate(next),
      mandate: next,
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      {
        name: name.trim(),
        budget: budget.trim(),
        persona: persona.trim() || null,
        mandate: mandateInput(mandate),
        ...(pausedAtLimit === null ? {} : { state: 'paused' as const }),
      },
      { onSuccess: (agent) => onCreated(agent.id, persona.trim() !== '' && persona !== generated) },
    );
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <PersonaTemplatePicker disabled={!templatesAvailable} onPick={applyTemplate} />
      <AgentField label={t('agents.fields.name')}>
        <input
          value={name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          maxLength={60}
          dir="auto"
          required
          className="w-full rounded-md border border-border-subtle bg-surface px-3 py-2"
        />
      </AgentField>
      <AgentField label={t('agents.fields.budget')} hint={t('agents.fields.budgetHint')}>
        <input
          value={budget}
          onChange={(event) => onChange({ ...draft, budget: event.target.value })}
          inputMode="decimal"
          dir="ltr"
          required
          aria-invalid={budget !== '' && !budgetValid}
          className="w-full rounded-md border border-border-subtle bg-surface px-3 py-2 text-start"
        />
      </AgentField>
      <MandateFields draft={mandate} onChange={(next) => onChange(withMandate(draft, next))} />
      <InstructionsField
        value={persona}
        generated={generated}
        rows={8}
        onChange={(value) => onChange({ ...draft, persona: value })}
      />
      {!mandateValid && <p className="text-xs text-loss">{t('agents.mandate.invalid')}</p>}
      {pausedAtLimit !== null && (
        <p className="text-xs text-text-muted">{t('agents.limit.startsPaused', { max: pausedAtLimit })}</p>
      )}
      {create.error && <ErrorNote message={agentErrorMessage(create.error, t('agents.create.failed'))} />}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          disabled={create.isPending || missing.length > 0 || !mandateValid}
          describedBy={missing.length > 0 ? 'create-agent-missing' : undefined}
        >
          <span className="flex items-center gap-1">
            <Plus className="size-4" aria-hidden />
            {t('agents.create.submit')}
          </span>
        </Button>
        {missing.length > 0 && (
          <p id="create-agent-missing" className="text-xs text-text-muted">
            {missing.join(' ')}
          </p>
        )}
      </div>
    </form>
  );
}

function PersonaTemplatePicker({ disabled, onPick }: { disabled: boolean; onPick: (template: PersonaTemplate) => void }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div role="group" aria-labelledby={`${id}-label`} aria-describedby={`${id}-hint`} className="text-sm">
      <p id={`${id}-label`} className="mb-1 text-text-muted">
        {t('agents.templates.label')}
      </p>
      <div className="flex flex-wrap gap-2">
        {PERSONA_TEMPLATES.map((template) => (
          <Button
            key={template}
            variant="secondary"
            disabled={disabled}
            onClick={() => onPick(template)}
          >
            {templateName(template)}
          </Button>
        ))}
      </div>
      <p id={`${id}-hint`} className="mt-1 text-xs text-text-muted">
        {t('agents.templates.hint')}
      </p>
    </div>
  );
}
