import type { AgentView, InstructionsCheckResult } from '@traders/shared';

import { Trans, useTranslation } from '../i18n/index.ts';
import { useDismissInstructionsCheck } from '../queries/agents.ts';
import { Button } from './ui.tsx';

/**
 * Where the instructions contradict the settings (D176-D178). The sentence is
 * the catalogue's, in the reader's language; the quote is the user's own words,
 * which the server checked are theirs, so it keeps its own direction.
 */
export function InstructionsConflicts({ agent }: { agent: AgentView }) {
  const { t } = useTranslation();
  const dismiss = useDismissInstructionsCheck(agent.id);
  if (!agent.instructionsConflicts) return null;
  return (
    <div role="status" className="space-y-1 rounded-md bg-warn/10 px-3 py-2 text-xs text-warn">
      <p className="font-medium">{t('agents.check.title')}</p>
      <ul className="list-disc space-y-0.5 ps-4">
        {agent.instructionsConflicts.map((conflict) => (
          <li key={`${conflict.setting}:${conflict.quote}`}>
            <Trans
              i18nKey="agents.check.conflict"
              values={{ quote: conflict.quote, setting: t(`agents.check.settings.${conflict.setting}`) }}
              components={{ quote: <q dir="auto" /> }}
            />
          </li>
        ))}
      </ul>
      <Button variant="secondary" onClick={() => dismiss.mutate()} disabled={dismiss.isPending}>
        {t('agents.check.dismiss')}
      </Button>
    </div>
  );
}

/** What the check just did, after a save on the agent's page: running, fine, or not possible now. */
export function InstructionsCheckStatus({ pending, result }: { pending: boolean; result: InstructionsCheckResult | undefined }) {
  const { t } = useTranslation();
  if (pending) return <p className="text-xs text-text-muted">{t('agents.check.checking')}</p>;
  if (!result) return null;
  if (result.status === 'checked') {
    return result.conflicts.length === 0 ? <p className="text-xs text-text-muted">{t('agents.check.fine')}</p> : null;
  }
  if (result.reason === 'no_instructions' || result.reason === 'no_settings') return null;
  return <p className="text-xs text-text-muted">{t('agents.check.unavailable')}</p>;
}
