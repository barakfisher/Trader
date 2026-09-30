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
import { baseCurrencyOf } from '../lib/portfolioView.ts';
import { useObservationsQuery } from '../queries/observations.ts';
import { usePortfolioQuery } from '../queries/portfolio.ts';
import { useStore } from '../stores/context.tsx';
import { Card, EmptyState, ErrorNote, Spinner } from './ui.tsx';
import { EvidenceDrawer } from './EvidenceDrawer.tsx';

export const ObservationsFeed = observer(function ObservationsFeed() {
  const feed = useObservationsQuery();
  const baseCurrency = baseCurrencyOf(usePortfolioQuery().data);
  // A failed refresh keeps the previous findings on screen: it must not read as
  // "nothing to report", which is a materially different statement.
  const items = feed.data ?? [];
  const latestAt = items[0]?.createdAt ?? null;
  // True only once a load has succeeded and returned nothing. An empty feed is
  // the normal state of a quiet day, so the view must be able to tell "the
  // engine found nothing" apart from "we have not asked yet" and from "the
  // request failed" - `status` is 'success' only when the last fetch was.
  const isEmpty = feed.status === 'success' && items.length === 0;

  return (
    <Card
      title="Observations"
      action={
        <span className="text-xs text-text-muted">
          {feed.isFetching && !feed.isPending
            ? 'refreshing…'
            : latestAt
              ? `latest ${formatAge(latestAt)}`
              : null}
        </span>
      }
    >
      {feed.isPending && <Spinner label="Loading observations…" />}

      {feed.error && (
        <div className="mb-3">
          <ErrorNote
            message={errorMessage(feed.error, 'Could not load your observations.')}
            onRetry={() => void feed.refetch()}
          />
        </div>
      )}

      {/* A quiet day is the normal result, so the empty state states a finding
          rather than apologising for one. */}
      {isEmpty && (
        <EmptyState
          title="Nothing to report"
          body="The last scan found no price move, unusual move, drawdown or allocation drift above your thresholds. That is the ordinary outcome on a calm day, not a missing result."
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
    </Card>
  );
});

/** One finding with its evidence drawer: the feed's row, and a holding page's. */
export const ObservationRow = observer(function ObservationRow({
  observation,
  baseCurrency,
}: {
  observation: Observation;
  baseCurrency: string;
}) {
  const { observations, concepts } = useStore();
  const severity = severityStyle(observation.severity);
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
          <span title={`Recorded ${formatExactTime(observation.createdAt)}`}>
            {formatAge(observation.createdAt)}
          </span>
        </div>

        <p className="mt-1 text-sm font-medium text-text-primary">{observation.headline}</p>
        <p className="mt-1 text-sm text-text-muted">{observation.explanation}</p>

        {observation.conceptRefs.length > 0 && (
          <p className="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-text-muted">
            <span className="uppercase tracking-wide">Concepts</span>
            {observation.conceptRefs.map((slug) => (
              <button
                key={slug}
                type="button"
                onClick={() => concepts.open(slug)}
                title={`What is ${conceptLabel(slug).toLowerCase()}?`}
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
            <ChevronRight className="size-3.5" aria-hidden />
          )}
          {open ? 'Hide evidence' : 'Show evidence'}
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
