import { useState } from 'react';

import type { OwnLlmKey } from '@traders/shared';

import { ApiRequestError } from '../api/client.ts';
import { useTranslation } from '../i18n/index.ts';
import { formatExactTime } from '../lib/relativeTime.ts';
import { useRemoveOwnLlmKey, useSaveOwnLlmKey } from '../queries/settings.ts';
import { Button, ErrorNote } from './ui.tsx';

/** The codes the server refuses a save with; anything else is "could not be saved". */
const SAVE_REFUSALS = ['key_rejected', 'key_malformed', 'key_check_unreachable', 'own_keys_unavailable'] as const;

/**
 * Save, replace or remove the user's own OpenRouter key (D206). The key is typed
 * here, sent once, and never comes back: the server answers with its last four
 * characters, and this field is emptied whatever the answer. A key OpenRouter
 * has refused since (D207) is said in full - what happened, and what the user's
 * calls do until they act.
 */
export function OwnLlmKeyForm({ available, saved }: { available: boolean; saved: OwnLlmKey | null }) {
  const { t } = useTranslation();
  const save = useSaveOwnLlmKey();
  const remove = useRemoveOwnLlmKey();
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState(false);

  function refusal(caught: unknown): string {
    const code = caught instanceof ApiRequestError ? caught.code : null;
    const known = SAVE_REFUSALS.find((refused) => refused === code);
    return t(known ? `settings.ownKey.errors.${known}` : 'settings.ownKey.errors.failed');
  }

  async function submit(): Promise<void> {
    const apiKey = draft.trim();
    if (apiKey === '') return;
    setError(null);
    setRemoved(false);
    try {
      await save.mutateAsync(apiKey);
      setEditing(false);
    } catch (caught) {
      setError(refusal(caught));
    } finally {
      // The key is not kept in the page once it has been sent, saved or not.
      setDraft('');
    }
  }

  async function removeKey(): Promise<void> {
    setError(null);
    try {
      await remove.mutateAsync();
      setRemoved(true);
      setEditing(false);
    } catch {
      setError(t('settings.ownKey.errors.removeFailed'));
    }
  }

  const showForm = available && (saved === null || editing);
  return (
    <div className="space-y-3">
      <p className="max-w-2xl text-xs text-text-muted">{t('settings.ownKey.intro')}</p>
      <p className="max-w-2xl text-xs text-text-muted">{t('settings.ownKey.limitHint')}</p>
      {saved?.status === 'failed' && saved.failure && (
        <p role="status" className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
          {t(`settings.ownKey.failed.${saved.failure}`, {
            lastFour: saved.lastFour,
            date: formatExactTime(saved.failedAt),
          })}
        </p>
      )}
      {saved && (
        <p className="text-sm">
          <bdi>
            {t('settings.ownKey.saved', { lastFour: saved.lastFour, date: formatExactTime(saved.savedAt) })}
          </bdi>
        </p>
      )}
      {!available && <p className="text-sm text-text-muted">{t('settings.ownKey.unavailable')}</p>}
      {removed && saved === null && <p role="status" className="text-sm">{t('settings.ownKey.removed')}</p>}
      {showForm && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          className="flex max-w-xl flex-wrap items-end gap-2"
        >
          <label className="min-w-64 flex-1 space-y-1">
            <span className="block text-sm font-medium text-text-primary">{t('settings.ownKey.label')}</span>
            <input
              type="password"
              dir="ltr"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
              className="input"
            />
          </label>
          <Button type="submit" disabled={save.isPending || draft.trim() === ''}>
            {save.isPending ? t('settings.ownKey.saving') : t('settings.ownKey.save')}
          </Button>
        </form>
      )}
      {saved && (
        <div className="flex flex-wrap gap-2">
          {available && !editing && (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              {t('settings.ownKey.replace')}
            </Button>
          )}
          <Button variant="ghost" onClick={() => void removeKey()} disabled={remove.isPending}>
            {t('settings.ownKey.remove')}
          </Button>
        </div>
      )}
      {error && <ErrorNote message={error} />}
    </div>
  );
}
