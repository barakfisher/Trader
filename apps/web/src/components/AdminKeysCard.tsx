import { useState } from 'react';
import { KeyRound } from 'lucide-react';

import type { InstallationKeyTestView, InstallationKeyView } from '@traders/shared';

import { errorMessage } from '../api/client.ts';
import { useTranslation } from '../i18n/index.ts';
import { formatAge, formatExactTime } from '../lib/relativeTime.ts';
import { useAdminKeysQuery, useTestInstallationKey } from '../queries/admin.ts';
import { Card, ErrorNote, Spinner, buttonClass } from './ui.tsx';

/**
 * The installation's provider keys (D251, D288): set or not, what each serves
 * here, the last error a real call met, and a free *Test* where one exists.
 * Never a value: changing a key stays an edit of `.env` or the cluster's
 * Secret and a redeploy (guideline 9). The app's own secrets are not listed.
 */
export function AdminKeysCard() {
  const { t } = useTranslation();
  const keys = useAdminKeysQuery();
  return (
    <Card title={t('admin.keys.title')}>
      <p className="mb-3 max-w-3xl text-xs text-text-muted">{t('admin.keys.intro')}</p>
      {keys.isPending && <Spinner label={t('admin.keys.loading')} />}
      {keys.error && (
        <ErrorNote message={errorMessage(keys.error, t('admin.keys.failed'))} onRetry={() => void keys.refetch()} />
      )}
      {keys.data && (
        <ul className="divide-y divide-border-subtle/60">
          {keys.data.keys.map((key) => (
            <li key={key.name} className="py-3 first:pt-0 last:pb-0">
              <KeyRow entry={key} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function KeyRow({ entry }: { entry: InstallationKeyView }) {
  const { t } = useTranslation();
  const test = useTestInstallationKey();
  const [result, setResult] = useState<InstallationKeyTestView | null>(null);
  // A key this configuration needs and does not have is a fault, said as one.
  const state = !entry.isSet
    ? entry.serves.length > 0
      ? 'missing'
      : 'notSet'
    : entry.unused !== null
      ? entry.unused
      : 'inUse';
  const tone = state === 'inUse' ? 'text-gain' : state === 'missing' ? 'text-warn' : 'text-text-muted';
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <p className="flex flex-wrap items-center gap-2">
          <KeyRound className="size-4 text-text-muted" aria-hidden />
          <span className="font-medium">{entry.provider}</span>
          <code dir="ltr" className="rounded bg-surface-hover px-1 text-xs text-text-muted">
            {entry.name}
          </code>
        </p>
        <p className={`text-sm ${tone}`}>
          {t(`admin.keys.state.${state}`)}
          {entry.serves.length > 0 &&
            ` · ${t(state === 'missing' ? 'admin.keys.needs' : 'admin.keys.serves', {
              what: entry.serves.map((serve) => t(`admin.keys.servesWhat.${serve}`)).join(', '),
            })}`}
        </p>
        {entry.lastError && (
          <p className="text-xs text-warn" title={formatExactTime(entry.lastError.at)}>
            {t('admin.keys.lastError', { age: formatAge(entry.lastError.at) })}{' '}
            <bdi dir="ltr" className="break-all font-mono">
              {entry.lastError.message}
            </bdi>
          </p>
        )}
        {result && (
          <p role="status" className={`text-xs ${result.ok ? 'text-gain' : 'text-loss'}`}>
            {result.ok ? t('admin.keys.testOk') : t('admin.keys.testFailed')}
            {result.detail && (
              <>
                {' '}
                <bdi dir="ltr" className="break-all font-mono">
                  {result.detail}
                </bdi>
              </>
            )}
          </p>
        )}
        {test.error && <ErrorNote message={errorMessage(test.error, t('admin.keys.testError'))} />}
      </div>
      {entry.testable && (
        <button
          type="button"
          className={buttonClass('secondary')}
          disabled={test.isPending}
          onClick={() => test.mutate(entry.name, { onSuccess: setResult })}
          aria-label={t('admin.keys.testLabel', { provider: entry.provider })}
        >
          {test.isPending ? t('admin.keys.testing') : t('admin.keys.test')}
        </button>
      )}
    </div>
  );
}
