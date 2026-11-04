import type { ModelChoicesResponse } from '@traders/shared';

import { errorMessage } from '../api/client.ts';
import { useTranslation } from '../i18n/index.ts';
import { useChooseAgentModel, useChooseUserModel, useModelChoicesQuery } from '../queries/modelChoices.ts';
import { ModelPicker } from './ModelPicker.tsx';
import { Card, ErrorNote, Spinner } from './ui.tsx';

/**
 * Ask's model (D244), chosen in Settings by every user, the admin included
 * (D360). The explanations' model is the main portfolio's (`ExplainModelCard`),
 * each agent's on its own page.
 */
export function AskModelCard() {
  const { t } = useTranslation();
  const query = useModelChoicesQuery();
  return (
    <Card title={t('models.title')}>
      <p className="mb-3 max-w-2xl text-xs text-text-muted">{t('models.intro')}</p>
      <ModelChoicesBody query={query}>{(data) => <UserScopePicker data={data} scope="assistant" />}</ModelChoicesBody>
    </Card>
  );
}

/**
 * The explanations' model (narration and Ask's "explain", D43), on the main
 * portfolio's page (D360): its 15-minute scan is rules plus narration, so the
 * narration's model is the one model call the real portfolio makes.
 */
export function ExplainModelCard() {
  const { t } = useTranslation();
  const query = useModelChoicesQuery();
  return (
    <Card title={t('models.agentTitle')}>
      <p className="mb-3 max-w-2xl text-xs text-text-muted">{t('models.explainIntro')}</p>
      <ModelChoicesBody query={query}>{(data) => <UserScopePicker data={data} scope="explain" />}</ModelChoicesBody>
    </Card>
  );
}

function UserScopePicker({ data, scope }: { data: ModelChoicesResponse; scope: 'assistant' | 'explain' }) {
  const { t } = useTranslation();
  const save = useChooseUserModel(scope);
  return (
    <ModelPicker
      id={`user-model-${scope}`}
      use={scope}
      label={t(`models.scope.${scope}`)}
      data={data}
      resolution={data.choices[scope]}
      save={save}
      perScan={false}
    />
  );
}

/** The model an agent scans with (D244); one with none runs on the scans' default, the admin's too (D360). */
export function AgentModelCard({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const query = useModelChoicesQuery();
  const save = useChooseAgentModel(agentId);
  return (
    <Card title={t('models.agentTitle')}>
      <ModelChoicesBody query={query}>
        {(data) => {
          const agent = data.agents.find((candidate) => candidate.agentId === agentId);
          // An archived agent does not scan, and is not listed.
          if (!agent) return <p className="text-sm text-text-muted">{t('models.agentNotScanning')}</p>;
          return (
            <ModelPicker
              id={`agent-model-${agentId}`}
              use="agent"
              label={t('models.scope.agent')}
              data={data}
              resolution={agent}
              save={save}
              perScan
            />
          );
        }}
      </ModelChoicesBody>
    </Card>
  );
}

function ModelChoicesBody({
  query,
  children,
}: {
  query: ReturnType<typeof useModelChoicesQuery>;
  children: (data: ModelChoicesResponse) => React.ReactNode;
}) {
  const { t } = useTranslation();
  if (query.isPending) return <Spinner label={t('models.loading')} />;
  if (query.error) {
    return <ErrorNote message={errorMessage(query.error, t('models.loadFailed'))} onRetry={() => void query.refetch()} />;
  }
  if (!query.data.choosable) return <p className="text-sm text-text-muted">{t('models.notChoosable')}</p>;
  return <>{children(query.data)}</>;
}
