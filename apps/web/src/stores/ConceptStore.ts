import { makeAutoObservable } from 'mobx';

import type { RootStore } from './RootStore.ts';

/**
 * Which concept's explanation is open. The documents themselves are server
 * state, in the query cache (`queries/concepts.ts`), read once a session.
 */
export class ConceptStore {
  /** Slug currently being shown, or null when nothing is open. */
  openSlug: string | null = null;

  constructor(private readonly root: RootStore) {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  open(slug: string): void {
    this.openSlug = slug;
  }

  close(): void {
    this.openSlug = null;
  }

  reset(): void {
    this.close();
  }
}
