import { makeAutoObservable, runInAction } from 'mobx';

import type { ConceptDocument } from '@traders/shared';

import { api, ApiRequestError } from '../api/client.ts';
import type { RootStore } from './RootStore.ts';

/**
 * The explanation behind a concept chip (FR-16: any term is one click from an
 * explanation).
 *
 * **Fetched documents are cached for the session and never refetched.** The
 * corpus is curated prose that changes when somebody edits a file and re-runs
 * the ingester, not with the market - so a reader who opens `drawdown` on three
 * different observations should pay for one request, not three. This is the one
 * thing in the app where a stale read is harmless: a definition that is five
 * minutes out of date is still the definition.
 *
 * **A missing concept is a state, not an error.** An environment that has not
 * ingested the corpus answers 404 for every slug, and that has to read as "no
 * explanation available" rather than as a broken page - otherwise the first
 * thing a new installation shows is a fault that is really just an unloaded
 * fixture. `notFound` is therefore kept distinct from `error`.
 */
export class ConceptStore {
  /** Slug currently being shown, or null when nothing is open. */
  openSlug: string | null = null;
  loading = false;
  /** Set when the corpus has no such concept, which is not a failure. */
  notFound = false;
  error: string | null = null;

  private readonly cache = new Map<string, ConceptDocument>();

  constructor(private readonly root: RootStore) {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  /** The document on screen, or null while it is loading or absent. */
  get current(): ConceptDocument | null {
    if (this.openSlug === null) return null;
    return this.cache.get(this.openSlug) ?? null;
  }

  async open(slug: string): Promise<void> {
    this.openSlug = slug;
    this.notFound = false;
    this.error = null;

    // Already read this session: show it without a request. See the class
    // comment for why a cached definition is safe indefinitely.
    if (this.cache.has(slug)) return;

    this.loading = true;
    try {
      const document = await api.get<ConceptDocument>(`/concepts/${encodeURIComponent(slug)}`);
      runInAction(() => {
        this.cache.set(slug, document);
      });
    } catch (error) {
      runInAction(() => {
        if (error instanceof ApiRequestError && error.status === 404) {
          this.notFound = true;
        } else {
          this.error =
            error instanceof Error ? error.message : 'The explanation could not be loaded.';
        }
      });
    } finally {
      runInAction(() => {
        this.loading = false;
      });
    }
  }

  close(): void {
    this.openSlug = null;
    this.notFound = false;
    this.error = null;
  }

  /**
   * Retry the open slug. Drops any cached copy first, so a retry after a
   * transient failure is a real request rather than a re-read of nothing.
   */
  async retry(): Promise<void> {
    const slug = this.openSlug;
    if (slug === null) return;
    this.cache.delete(slug);
    await this.open(slug);
  }

  reset(): void {
    this.cache.clear();
    this.close();
  }
}
