import type { ModelChoicesResponse } from '@traders/shared';

import { errorMessage } from '../api/client.ts';
import { leftToRight } from '../i18n/format.ts';
import { useTranslation } from '../i18n/index.ts';
import { useChooseAgentModel, useChooseUserModel, useModelChoicesQuery } from '../queries/modelChoices.ts';
import { useStore } from '../stores/context.tsx';
import { ModelPicker } from './ModelPicker.tsx';
import { Card, ErrorNote, Spinner } from './ui.tsx';

/**
 * Ask's model and the explanations' model, chosen by a user on their own key
 * (D244). The admin chooses on the Admin page and sees nothing here.
 */
export function UserModelsCard() {
  const { t } = useTranslation();
  const { auth } = useStore();
  const isAdmin = auth.user?.role === 'admin';
  const query = useModelChoicesQuery(!isAdmin);
  if (isAdmin) return null;
  return (
    <Card title={t('models.title')}>
      <p className="mb-3 max-w-2xl text-xs text-text-muted">{t('models.intro')}</p>
      <ModelChoicesBody query={query}>
        {(data) => (
          <div className="space-y-5">
            <UserScopePicker data={data} scope="assistant" />
            <UserScopePicker data={data} scope="explain" />
          </div>
        )}
      </ModelChoicesBody>
    </Card>
  );
}

function UserScopePicker({ data, scope }: { data: ModelChoicesResponse; scope: 'assistant' | 'explain' }) {
  const { t } = useTranslation();
  const save = useChooseUserModel(scope);
  return (
    <ModelPicker
      id={`user-model-${scope}`}
      label={t(`models.scope.${scope}`)}
      data={data}
      resolution={data.choices[scope]}
      save={save}
      perScan={false}
    />
  );
}

/**
 * The model an agent scans with (D244). The admin chooses here too (D353); an
 * agent of theirs with none runs on the Admin page's agent model.
 */
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
              label={t('models.scope.agent')}
              data={data}
              resolution={agent}
              save={save}
              perScan
              unchosen={
                data.admin && data.agentDefault
                  ? {
                      model: data.agentDefault,
                      label: t('models.notChosenAdmin', { model: leftToRight(data.agentDefault) }),
                    }
                  : undefined
              }
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
