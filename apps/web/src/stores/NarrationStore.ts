import { makeAutoObservable, runInAction } from 'mobx';

import type { NarrationHealthResponse } from '@traders/shared';

import { api } from '../api/client.ts';
import type { RootStore } from './RootStore.ts';

/**
 * Whether the explanations in the feed were written by a model.
 *
 * Loaded once when the dashboard opens rather than polled. The state changes
 * when a scan runs, which is every thirty minutes at most, and a badge that
 * polls to tell you nothing has changed spends requests to say so.
 *
 * A failure to load leaves `health` null and the badge renders nothing. This is
 * an indicator *about* reliability; an indicator that reports its own outage as
 * a product fault would be the most misleading thing on the page.
 */
export class NarrationStore {
  health: NarrationHealthResponse | null = null;
  loading = false;

  constructor(private readonly root: RootStore) {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  /**
   * Whether the badge is worth showing at all.
   *
   * `narrating` on a paid model is the expected state and says nothing a reader
   * needs - a badge that is always present stops being read. Every other state
   * is either a cost the reader is paying in quality, or a fact about the bill.
   */
  get isNoteworthy(): boolean {
    if (this.health === null) return false;
    return this.health.state !== 'narrating' || this.health.tier !== 'paid';
  }

  async load(): Promise<void> {
    this.loading = true;
    try {
      const health = await api.get<NarrationHealthResponse>('/narration');
      runInAction(() => {
        this.health = health;
      });
    } catch {
      // Deliberately silent: see the class comment. Nothing on the page depends
      // on this having succeeded.
      runInAction(() => {
        this.health = null;
      });
    } finally {
      runInAction(() => {
        this.loading = false;
      });
    }
  }

  reset(): void {
    this.health = null;
  }
}
