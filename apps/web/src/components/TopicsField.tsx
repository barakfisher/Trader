import { MAX_TOPIC_LENGTH, MAX_TOPICS } from '@traders/shared';

import { useTranslation } from '../i18n/index.ts';
import { topicsValid } from '../lib/agentTopics.ts';
import { AgentField } from './AgentField.tsx';

/**
 * What an agent follows (D412), on the new-agent drawer and the agent's page. A
 * direction for the briefing, not a limit, so it sits after the mandate's rules.
 */
export function TopicsField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  const valid = topicsValid(value);
  return (
    <div className="space-y-1">
      <AgentField label={t('agents.topics.label')} hint={t('agents.topics.hint', { max: MAX_TOPICS })}>
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          rows={3}
          dir="auto"
          placeholder={t('agents.topics.placeholder')}
          aria-invalid={!valid}
          className="w-full rounded-md border border-border-subtle bg-surface px-3 py-2"
        />
      </AgentField>
      {!valid && (
        <p className="text-xs text-loss">{t('agents.topics.invalid', { max: MAX_TOPICS, length: MAX_TOPIC_LENGTH })}</p>
      )}
    </div>
  );
}
