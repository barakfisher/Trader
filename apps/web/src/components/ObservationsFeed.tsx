import { observer } from 'mobx-react-lite';
import { ChevronDown, ChevronRight } from 'lucide-react';

import type { Observation } from '@traders/shared';

import {
  conceptLabel,
  kindLabel,
  severityStyle,
  subjectLabel,
} from '../lib/observationPresentation.ts';
import { formatAge, formatExactTime } from '../lib/relativeTime.ts';
import { errorMessage } from '../api/client.ts';
import { useTranslation } from '../i18n/index.ts';
import { baseCurrencyOf } from '../lib/portfolioView.ts';
import { observationText } from '../lib/observationText.ts';
import { MIRROR_IN_RTL } from '../lib/textDirection.ts';
import {
  FEED_PAGE_SIZE,
  loadedFindings,
  useFeedQuery,
  type FeedFilters,
} from '../queries/observations.ts';
import { usePortfolioQuery } from '../queries/portfolio.ts';
import { useStore } from '../stores/context.tsx';
import { Card, EmptyState, ErrorNote, Spinner } from './ui.tsx';
import { EvidenceDrawer } from './EvidenceDrawer.tsx';

/** The severity choices, as "at least this severe". */
const SEVERITY_OPTIONS: { value: FeedFilters['severity']; key: 'all' | 'notable' | 'high' }[] = [
  { value: undefined, key: 'all' },
  { value: 'notable', key: 'notable' },
  { value: 'high', key: 'high' },
];

/**
 * The feed, a page at a time, filtered by severity and symbol.
 *
 * The filters are props rather than read from the address here, so the
 * component renders the same in a test as on the Insights page, which keeps
 * them in its URL (`?severity=high&symbol=NVDA`) - a filtered view has an
 * address too.
 */
export const ObservationsFeed = observer(function ObservationsFeed({
  filters = {},
  onFiltersChange,
}: {
  filters?: FeedFilters;
  onFiltersChange?: (filters: FeedFilters) => void;
}) {
  const feed = useFeedQuery(filters);
  const { t } = useTranslation();
  const portfolio = usePortfolioQuery().data;
  const baseCurrency = baseCurrencyOf(portfolio);
  // A failed refresh keeps the previous findings on screen: it must not read as
  // "nothing to report", which is a materially different statement.
  const items = loadedFindings(feed.data?.pages);
  const total = feed.data?.pages[0]?.total ?? null;
  const latestAt = items[0]?.createdAt ?? null;
  const filtered = filters.severity !== undefined || filters.symbol !== undefined;
  // True only once a load has succeeded and returned nothing. An empty feed is
  // the normal state of a quiet day, so the view must be able to tell "the
  // engine found nothing" apart from "we have not asked yet" and from "the
  // request failed" - `status` is 'success' only when the last fetch was.
  const isEmpty = feed.status === 'success' && items.length === 0;
  const symbols = symbolChoices(portfolio?.holdings.map((holding) => holding.instrument.symbol), filters.symbol);
  const remaining = total === null ? 0 : total - items.length;

  return (
    <Card
      title={t('feed.title')}
      action={
        <span className="text-xs text-text-muted">
          {feed.isFetching && !feed.isPending && !feed.isFetchingNextPage
            ? t('feed.refreshing')
            : latestAt
              ? t('feed.latest', { age: formatAge(latestAt) })
              : null}
        </span>
      }
    >
      {onFiltersChange && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1" role="group" aria-label={t('feed.severity')}>
            {SEVERITY_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                aria-pressed={filters.severity === option.value}
                onClick={() => onFiltersChange({ ...filters, severity: option.value })}
                className={`rounded px-2 py-1 text-xs ${
                  filters.severity === option.value
                    ? 'bg-surface-hover text-text-primary'
                    : 'text-text-muted hover:text-text-primary'
                }`}
              >
                {t(`feed.severityOptions.${option.key}`)}
              </button>
            ))}
          </div>
          <select
            aria-label={t('feed.symbol')}
            value={filters.symbol ?? ''}
            onChange={(event) =>
              onFiltersChange({ ...filters, symbol: event.target.value || undefined })
            }
            className="rounded border border-border-subtle bg-surface px-2 py-1 text-xs"
          >
            <option value="">{t('feed.allSymbols')}</option>
            {symbols.map((symbol) => (
              <option key={symbol} value={symbol}>
                {symbol}
              </option>
            ))}
          </select>
          {total !== null && (
            <span className="text-xs text-text-muted">
              {t('feed.shownOf', { shown: items.length, total })}
            </span>
          )}
        </div>
      )}

      {feed.isPending && <Spinner label={t('feed.loading')} />}

      {feed.error && (
        <div className="mb-3">
          <ErrorNote
            message={errorMessage(feed.error, t('feed.loadFailed'))}
            onRetry={() => void feed.refetch()}
          />
        </div>
      )}

      {/* A quiet day is the normal result, so the empty state states a finding
          rather than apologising for one. A filter that matches nothing is a
          different statement, and says so. */}
      {isEmpty && !filtered && (
        <EmptyState
          title={t('feed.quietTitle')}
          body={t('feed.quietBody')}
        />
      )}
      {isEmpty && filtered && (
        <EmptyState
          title={t('feed.noMatchTitle')}
          body={t('feed.noMatchBody')}
          action={
            onFiltersChange && (
              <button
                type="button"
                onClick={() => onFiltersChange({})}
                className="text-xs text-accent underline"
              >
                {t('feed.showAll')}
              </button>
            )
          }
        />
      )}

      {items.length > 0 && (
        <ul className="space-y-3">
          {items.map((observation) => (
            <li key={observation.id}>
              <ObservationRow observation={observation} baseCurrency={baseCurrency} />
            </li>
          ))}
        </ul>
      )}

      {feed.hasNextPage && (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            disabled={feed.isFetchingNextPage}
            onClick={() => void feed.fetchNextPage()}
            className="rounded border border-border-subtle px-3 py-1.5 text-xs text-text-primary hover:bg-surface-hover disabled:opacity-60"
          >
            {feed.isFetchingNextPage
              ? t('common.loading')
              : t('feed.showMore', { count: Math.min(FEED_PAGE_SIZE, remaining || FEED_PAGE_SIZE) })}
          </button>
        </div>
      )}
    </Card>
  );
});

/** The held symbols, sorted, plus a filtered symbol no longer held - so the select can show it. */
export function symbolChoices(held: string[] | undefined, current: string | undefined): string[] {
  const set = new Set(held ?? []);
  if (current) set.add(current);
  return [...set].sort();
}

/** One finding with its evidence drawer: the feed's row, and a holding page's. */
export const ObservationRow = observer(function ObservationRow({
  observation,
  baseCurrency,
}: {
  observation: Observation;
  baseCurrency: string;
}) {
  const { observations, concepts } = useStore();
  const { t, i18n } = useTranslation();
  const severity = severityStyle(observation.severity);
  const text = observationText(observation, i18n.language);
  const open = observations.isExpanded(observation.id);
  const drawerId = `evidence-${observation.id}`;

  return (
    <article className="flex gap-3 rounded-lg border border-border-subtle bg-surface-raised/60 p-3">
      {/* The rail carries severity at a glance; the chip names it for anyone who
          cannot rely on colour alone. */}
      <span className={`w-1 shrink-0 rounded-full ${severity.railClassName}`} aria-hidden />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
          <span className={`rounded px-1.5 py-0.5 text-[10px] ${severity.chipClassName}`}>
            {severity.label}
          </span>
          <span className="font-medium text-text-primary">
            {subjectLabel(observation.subjectRef, observation.evidence)}
          </span>
          <span aria-hidden>·</span>
          <span>{kindLabel(observation.kind)}</span>
          <span aria-hidden>·</span>
          <span title={t('feed.recorded', { when: formatExactTime(observation.createdAt) })}>
            {formatAge(observation.createdAt)}
          </span>
        </div>

        <p {...text.attributes} className="mt-1 text-sm font-medium text-text-primary">{text.headline}</p>
        <p {...text.attributes} className="mt-1 text-sm text-text-muted">{text.explanation}</p>

        {observation.conceptRefs.length > 0 && (
          <p className="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-text-muted">
            <span className="uppercase tracking-wide">{t('feed.concepts')}</span>
            {observation.conceptRefs.map((slug) => (
              <button
                key={slug}
                type="button"
                onClick={() => concepts.open(slug)}
                title={t('feed.whatIs', { concept: conceptLabel(slug).toLowerCase() })}
                className="rounded bg-surface-hover px-1.5 py-0.5 text-text-primary hover:bg-border hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              >
                {conceptLabel(slug)}
              </button>
            ))}
          </p>
        )}

        <button
          type="button"
          onClick={() => observations.toggleEvidence(observation.id)}
          aria-expanded={open}
          aria-controls={drawerId}
          className="mt-2 flex items-center gap-1 text-xs text-accent hover:underline"
        >
          {open ? (
            <ChevronDown className="size-3.5" aria-hidden />
          ) : (
            <ChevronRight className={`size-3.5 ${MIRROR_IN_RTL}`} aria-hidden />
          )}
          {open ? t('feed.hideEvidence') : t('feed.showEvidence')}
        </button>

        {open && (
          <EvidenceDrawer
            evidence={observation.evidence}
            baseCurrency={baseCurrency}
            id={drawerId}
          />
        )}
      </div>
    </article>
  );
});
