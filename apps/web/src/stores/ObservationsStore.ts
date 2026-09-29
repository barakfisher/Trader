import { makeAutoObservable } from 'mobx';

import type { RootStore } from './RootStore.ts';

/**
 * What the reader has done to the feed in this session: which findings have
 * their evidence open. The findings themselves are server state and live in
 * the query cache (`queries/observations.ts`).
 */
export class ObservationsStore {
  /** Ids the reader has opened the evidence for. Local to the session. */
  expanded = new Set<string>();

  constructor(private readonly root: RootStore) {
    makeAutoObservable(this, {}, { autoBind: true });
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

  reset(): void {
    this.expanded = new Set();
  }
}
