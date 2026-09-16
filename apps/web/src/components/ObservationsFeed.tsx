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
import { useStore } from '../stores/context.tsx';
import { Card, EmptyState, ErrorNote, Spinner } from './ui.tsx';
import { EvidenceDrawer } from './EvidenceDrawer.tsx';

export const ObservationsFeed = observer(function ObservationsFeed() {
  const { observations, portfolio } = useStore();
  const items = observations.observations;

  return (
    <Card
      title="Observations"
      action={
        <span className="text-xs text-text-muted">
          {observations.refreshing
            ? 'refreshing…'
            : observations.latestAt
              ? `latest ${formatAge(observations.latestAt)}`
              : null}
        </span>
      }
    >
      {observations.loading && items.length === 0 && <Spinner label="Loading observations…" />}

      {observations.error && (
        <div className="mb-3">
          <ErrorNote
            message={observations.error}
            onRetry={() => void observations.load({ silent: items.length > 0 })}
          />
        </div>
      )}

      {/* A quiet day is the normal result, so the empty state states a finding
          rather than apologising for one. */}
      {observations.isEmpty && (
        <EmptyState
          title="Nothing to report"
          body="The last scan found no price move, unusual move, drawdown or allocation drift above your thresholds. That is the ordinary outcome on a calm day, not a missing result."
        />
      )}

      {items.length > 0 && (
        <ul className="space-y-3">
          {items.map((observation) => (
            <li key={observation.id}>
              <ObservationRow observation={observation} baseCurrency={portfolio.baseCurrency} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
});

const ObservationRow = observer(function ObservationRow({
  observation,
  baseCurrency,
}: {
  observation: Observation;
  baseCurrency: string;
}) {
  const { observations } = useStore();
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
            {subjectLabel(observation.subjectRef)}
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
              <span
                key={slug}
                title={slug}
                className="rounded bg-surface-hover px-1.5 py-0.5 text-text-primary"
              >
                {conceptLabel(slug)}
              </span>
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
