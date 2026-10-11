import { observer } from 'mobx-react-lite';
import { BellOff, Clock } from 'lucide-react';

import type { Alert, AlertSource, Observation } from '@traders/shared';

import { errorMessage } from '../api/client.ts';
import { useTranslation } from '../i18n/index.ts';
import { baseCurrencyOf } from '../lib/portfolioView.ts';
import { formatAge, formatExactTime } from '../lib/relativeTime.ts';
import { loadedAlerts, useAlertsQuery } from '../queries/alerts.ts';
import { FEED_PAGE_SIZE } from '../queries/observations.ts';
import { usePortfolioQuery } from '../queries/portfolio.ts';
import { ObservationRow } from './ObservationsFeed.tsx';
import { Card, EmptyState, ErrorNote, Spinner } from './ui.tsx';

const SOURCES: { value: AlertSource | undefined; key: 'all' | AlertSource }[] = [
  { value: undefined, key: 'all' },
  { value: 'portfolio', key: 'portfolio' },
  { value: 'topics', key: 'topics' },
  { value: 'agents', key: 'agents' },
];

/**
 * What the user was told (decision 134): every finding pushed to Telegram, or
 * held back by quiet hours, from the main portfolio, topics and every agent.
 *
 * The source pills are the user's (2026-10-11): one list answers "what was I
 * told?", and a pill narrows it without a second place to look. A push the
 * channel could not deliver is listed and says so - hiding it would make "we
 * failed to tell you" look like "there was nothing to tell".
 */
export const AlertsList = observer(function AlertsList({
  source,
  onSourceChange,
}: {
  source: AlertSource | undefined;
  onSourceChange: (source: AlertSource | undefined) => void;
}) {
  const { t } = useTranslation();
  const alerts = useAlertsQuery(source);
  const baseCurrency = baseCurrencyOf(usePortfolioQuery().data);
  const items = loadedAlerts(alerts.data?.pages);
  const total = alerts.data?.pages[0]?.total ?? null;
  const isEmpty = alerts.status === 'success' && items.length === 0;
  const remaining = total === null ? 0 : total - items.length;

  return (
    <Card title={t('alerts.title')}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1" role="group" aria-label={t('alerts.source')}>
          {SOURCES.map((option) => (
            <button
              key={option.key}
              type="button"
              aria-pressed={source === option.value}
              onClick={() => onSourceChange(option.value)}
              className={`rounded-full px-3 py-1 text-xs ${
                source === option.value
                  ? 'bg-accent/15 text-accent'
                  : 'text-text-muted hover:bg-surface-hover hover:text-text-primary'
              }`}
            >
              {t(`alerts.sources.${option.key}`)}
            </button>
          ))}
        </div>
        {total !== null && (
          <span className="text-xs text-text-muted">
            {t('feed.shownOf', { shown: items.length, total })}
          </span>
        )}
      </div>

      {alerts.isPending && <Spinner label={t('alerts.loading')} />}
      {alerts.error && (
        <div className="mb-3">
          <ErrorNote
            message={errorMessage(alerts.error, t('alerts.loadFailed'))}
            onRetry={() => void alerts.refetch()}
          />
        </div>
      )}

      {isEmpty && source === undefined && (
        <EmptyState title={t('alerts.emptyTitle')} body={t('alerts.emptyBody')} />
      )}
      {isEmpty && source !== undefined && (
        <EmptyState
          title={t('alerts.noMatchTitle')}
          body={t('alerts.noMatchBody')}
          action={
            <button
              type="button"
              onClick={() => onSourceChange(undefined)}
              className="text-xs text-accent underline"
            >
              {t('feed.showAll')}
            </button>
          }
        />
      )}

      {items.length > 0 && (
        <ul className="space-y-3">
          {items.map((alert) => (
            <li key={alert.id}>
              <ObservationRow
                // An alert is an observation with its delivery beside it; the
                // row reads only what both carry.
                observation={alert as unknown as Observation}
                baseCurrency={baseCurrency}
                meta={<AlertMeta alert={alert} />}
              />
            </li>
          ))}
        </ul>
      )}

      {alerts.hasNextPage && (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            disabled={alerts.isFetchingNextPage}
            onClick={() => void alerts.fetchNextPage()}
            className="rounded border border-border-subtle px-3 py-1.5 text-xs text-text-primary hover:bg-surface-hover disabled:opacity-60"
          >
            {alerts.isFetchingNextPage
              ? t('common.loading')
              : t('feed.showMore', { count: Math.min(FEED_PAGE_SIZE, remaining || FEED_PAGE_SIZE) })}
          </button>
        </div>
      )}
    </Card>
  );
});

/** Who it came from, when it was not the main portfolio, and what became of it. */
function AlertMeta({ alert }: { alert: Alert }) {
  const { t } = useTranslation();
  const { delivery } = alert;
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
      {!alert.agent.isPrimary && (
        <span className="rounded bg-surface-hover px-1.5 py-0.5 text-text-primary">
          {t('alerts.agent', { name: alert.agent.name })}
        </span>
      )}
      {delivery.deferred ? (
        <span className="flex items-center gap-1">
          <Clock className="size-3.5" aria-hidden />
          {t('alerts.deferred')}
        </span>
      ) : delivery.delivered && delivery.sentAt !== null ? (
        <span title={formatExactTime(delivery.sentAt)}>
          {t('alerts.sent', { when: formatAge(delivery.sentAt) })}
        </span>
      ) : (
        <span className="flex items-center gap-1 text-warn">
          <BellOff className="size-3.5" aria-hidden />
          {t('alerts.notDelivered')}
        </span>
      )}
    </p>
  );
}
