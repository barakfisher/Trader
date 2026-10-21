import { useState } from 'react';

import { ACCOUNT_RESET_CONFIRMATION, ACCOUNT_RESET_GROUPS, type AccountResetGroup } from '@traders/shared';

import { errorMessage } from '../api/client.ts';
import { useTranslation } from '../i18n/index.ts';
import { useResetAccount } from '../queries/settings.ts';
import { Button, Card, ErrorNote, Spinner } from './ui.tsx';

/**
 * Reset the account, by group (task 18) - each user's own (D162), on Settings. Every group is ticked, a full reset,
 * and the user unticks what to keep; what each erases and what is always kept
 * are written beside the boxes, because the alternative is finding out. The
 * typed word is the same in every language, and the server checks it too.
 */
export function AccountResetCard() {
  const { t } = useTranslation();
  const reset = useResetAccount();
  const [groups, setGroups] = useState<AccountResetGroup[]>([...ACCOUNT_RESET_GROUPS]);
  const [typed, setTyped] = useState('');
  const result = reset.data;
  const ready = groups.length > 0 && typed === ACCOUNT_RESET_CONFIRMATION && !reset.isPending;
  const erased = result ? Object.values(result.erased).reduce((sum, n) => sum + n, 0) : 0;

  const toggle = (group: AccountResetGroup, on: boolean) =>
    setGroups((current) =>
      ACCOUNT_RESET_GROUPS.filter((g) => (g === group ? on : current.includes(g))),
    );

  return (
    <Card title={t('accountReset.title')} className="border-loss/40">
      <div className="space-y-3 text-sm">
        <p>{t('accountReset.intro')}</p>
        <fieldset className="space-y-2">
          <legend className="sr-only">{t('accountReset.groupsLegend')}</legend>
          {ACCOUNT_RESET_GROUPS.map((group) => (
            <label key={group} className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={groups.includes(group)}
                onChange={(event) => toggle(group, event.target.checked)}
              />
              <span>
                <span className="font-medium">{t(`accountReset.group.${group}.label`)}</span>
                <span className="block text-text-muted">{t(`accountReset.group.${group}.erases`)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="text-text-muted">{t('accountReset.kept')}</p>
        <label className="block space-y-1">
          <span>{t('accountReset.confirmLabel', { word: ACCOUNT_RESET_CONFIRMATION })}</span>
          <input
            className="input max-w-48"
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
        {groups.length === 0 && <p className="text-warn">{t('accountReset.nothingTicked')}</p>}
        <Button
          variant="danger"
          disabled={!ready}
          onClick={() => {
            reset.mutate({ groups, confirm: typed }, { onSuccess: () => setTyped('') });
          }}
        >
          {t('accountReset.submit')}
        </Button>
        {reset.isPending && <Spinner label={t('accountReset.running')} />}
        {reset.error && <ErrorNote message={errorMessage(reset.error, t('accountReset.failed'))} />}
        {result && (
          <p className="text-gain">
            {t('accountReset.done', { count: erased, id: result.resetId })}
          </p>
        )}
      </div>
    </Card>
  );
}

