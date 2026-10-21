import type { AgentView } from '@traders/shared';

import { useTranslation } from '../i18n/index.ts';
import { agentStateWord } from '../lib/agentPresentation.ts';
import type { HoldingsScope } from '../lib/holdingsScope.ts';

/**
 * `[ All ] [ Real ] [ Simulated ]` above the holdings table (D229), and under
 * *Simulated*, one chip per agent when there is more than one to choose
 * between. Shown only when a non-archived simulated agent exists: without one,
 * every view is the real portfolio.
 */
export function HoldingsScopeToggle({
  scope,
  agents,
  onChange,
}: {
  scope: HoldingsScope;
  agents: AgentView[];
  onChange: (scope: HoldingsScope) => void;
}) {
  const { t } = useTranslation();
  const segment = scope.kind === 'agent' ? 'simulated' : scope.kind;
  const options = [
    { kind: 'all', label: t('combined.scopes.all') },
    { kind: 'real', label: t('combined.scopes.real') },
    { kind: 'simulated', label: t('combined.scopes.simulated') },
  ] as const;
  const chip = (selected: boolean) =>
    `rounded-full border px-3 py-1 text-xs transition ${
      selected
        ? 'border-accent bg-accent/15 font-medium text-accent'
        : 'border-border-subtle text-text-muted hover:text-text-primary'
    }`;

  return (
    <div className="space-y-2">
      <div
        role="radiogroup"
        aria-label={t('combined.scopes.label')}
        className="inline-flex rounded-lg border border-border-subtle bg-surface p-0.5 text-sm"
      >
        {options.map((option) => (
          <button
            key={option.kind}
            type="button"
            role="radio"
            aria-checked={segment === option.kind}
            onClick={() => onChange({ kind: option.kind })}
            className={`rounded-md px-3 py-1.5 transition ${
              segment === option.kind
                ? 'bg-accent text-surface font-medium'
                : 'text-text-muted hover:text-text-primary'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      {segment === 'simulated' && agents.length > 1 && (
        <div role="radiogroup" aria-label={t('combined.scopes.agents')} className="flex flex-wrap gap-1.5">
          <button
            type="button"
            role="radio"
            aria-checked={scope.kind === 'simulated'}
            onClick={() => onChange({ kind: 'simulated' })}
            className={chip(scope.kind === 'simulated')}
          >
            {t('combined.scopes.everyAgent')}
          </button>
          {agents.map((agent) => {
            const selected = scope.kind === 'agent' && scope.agentId === agent.id;
            return (
              <button
                key={agent.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onChange({ kind: 'agent', agentId: agent.id })}
                className={chip(selected)}
              >
                <bdi>{agent.name}</bdi>
                {agent.state === 'paused' && <span className="text-warn"> · {agentStateWord('paused')}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
