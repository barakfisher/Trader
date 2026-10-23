import { Link } from '@tanstack/react-router';
import { TriangleAlert } from 'lucide-react';

import { leftToRight, ownDirection } from '../i18n/format.ts';
import { useTranslation } from '../i18n/index.ts';
import { fallbacksOf, useModelChoicesQuery } from '../queries/modelChoices.ts';
import { useStore } from '../stores/context.tsx';

/**
 * Every model the user chose that OpenRouter no longer lists, and what runs
 * instead (D283), each with the way to choose again: Settings for Ask and
 * explanations, the agent's page for an agent. Nothing for the admin, nothing
 * while the read is pending or failed, nothing when nothing fell back.
 */
export function ModelFallbackBanner() {
  const { t } = useTranslation();
  const { auth } = useStore();
  const isAdmin = auth.user?.role === 'admin';
  const data = useModelChoicesQuery(!isAdmin).data;
  if (isAdmin || !data) return null;
  const fallbacks = fallbacksOf(data);
  if (fallbacks.length === 0) return null;
  return (
    <div role="status" className="space-y-1 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
      {fallbacks.map((fallback) => {
        const agent = fallback.scope === 'agent' ? data.agents.find((a) => a.agentId === fallback.agentId) : undefined;
        const resolution = agent ?? (fallback.scope === 'agent' ? undefined : data.choices[fallback.scope]);
        if (!resolution) return null;
        const where = agent ? t('models.banner.agent', { name: ownDirection(agent.name) }) : t(`models.banner.${fallback.scope as 'assistant' | 'explain'}`);
        return (
          <p key={agent?.agentId ?? fallback.scope} className="flex flex-wrap items-start gap-x-2 gap-y-1">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">
              {t('models.banner.line', {
                saved: leftToRight(resolution.saved ?? ''),
                where,
                effective: leftToRight(resolution.effective ?? ''),
              })}
            </span>
            {agent ? (
              <Link
                to="/agents/$agentId"
                params={{ agentId: agent.agentId }}
                search={{ tab: 'settings' }}
                className="font-medium text-accent hover:underline"
              >
                {t('models.banner.chooseAgent')}
              </Link>
            ) : (
              <Link to="/settings" className="font-medium text-accent hover:underline">
                {t('models.banner.chooseSettings')}
              </Link>
            )}
          </p>
        );
      })}
    </div>
  );
}
