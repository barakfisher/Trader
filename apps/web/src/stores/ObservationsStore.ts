import { makeAutoObservable, runInAction } from 'mobx';

import type { Observation, ObservationSeverity, ObservationsResponse } from '@traders/shared';

import { ApiRequestError, api } from '../api/client.ts';
import { severityRank } from '../lib/observationPresentation.ts';
import type { RootStore } from './RootStore.ts';

/** One page is a feed, not an archive; the engine emits few findings per run. */
export const OBSERVATIONS_PAGE_SIZE = 50;

export class ObservationsStore {
  observations: Observation[] = [];
  loading = false;
  /** Distinct from `loading`: a refresh keeps the current feed on screen. */
  refreshing = false;
  error: string | null = null;
  lastLoadedAt: Date | null = null;
  /** Ids the reader has opened the evidence for. Local to the session. */
  expanded = new Set<string>();

  constructor(private readonly root: RootStore) {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  /**
   * True only once a load has succeeded and returned nothing.
   *
   * An empty feed is the normal state of a quiet day, so the view must be able
   * to tell "the engine found nothing" apart from "we have not asked yet" and
   * from "the request failed". Conflating them turns a working system into
   * what looks like a broken one.
   */
  get isEmpty(): boolean {
    return this.lastLoadedAt !== null && this.error === null && this.observations.length === 0;
  }

  get highCount(): number {
    return this.observations.filter((observation) => observation.severity === 'high').length;
  }

  /** The severity of the loudest finding in the feed, for the header. */
  get topSeverity(): ObservationSeverity | null {
    let top: Observation | null = null;
    for (const observation of this.observations) {
      if (top === null || severityRank(observation.severity) > severityRank(top.severity)) {
        top = observation;
      }
    }
    return top?.severity ?? null;
  }

  /** The newest finding's time, which is what "as of" means for this feed. */
  get latestAt(): string | null {
    return this.observations[0]?.createdAt ?? null;
  }

  isExpanded(observationId: string): boolean {
    return this.expanded.has(observationId);
  }

  toggleEvidence(observationId: string): void {
    // A new Set, because MobX tracks the reference and components read it.
    const next = new Set(this.expanded);
    if (next.has(observationId)) next.delete(observationId);
    else next.add(observationId);
    this.expanded = next;
  }

  async load(options: { silent?: boolean } = {}): Promise<void> {
    if (options.silent) this.refreshing = true;
    else this.loading = true;
    this.error = null;
    try {
      const response = await api.get<ObservationsResponse>(
        `/observations?limit=${OBSERVATIONS_PAGE_SIZE}`,
      );
      runInAction(() => {
        // The API already returns newest first; trusting it keeps one ordering
        // rule in the system rather than two that can disagree.
        this.observations = response.observations ?? [];
        this.lastLoadedAt = new Date();
      });
    } catch (error) {
      runInAction(() => {
        // The previous findings stay on screen. A failed refresh must not read
        // as "nothing to report", which is a materially different statement.
        this.error =
          error instanceof ApiRequestError ? error.message : 'Could not load your observations.';
      });
    } finally {
      runInAction(() => {
        this.loading = false;
        this.refreshing = false;
      });
    }
  }

  reset(): void {
    this.observations = [];
    this.error = null;
    this.lastLoadedAt = null;
    this.expanded = new Set();
  }
}
