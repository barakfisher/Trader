import { makeAutoObservable, runInAction } from 'mobx';

import type { SessionUser } from '@traders/shared';

import { ApiRequestError, api } from '../api/client.ts';
import type { RootStore } from './RootStore.ts';

export class AuthStore {
  user: SessionUser | null = null;
  /** Null until the first session check resolves, so we can avoid a login flash. */
  initialised = false;
  submitting = false;
  error: string | null = null;

  constructor(private readonly root: RootStore) {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  get isAuthenticated(): boolean {
    return this.user !== null;
  }

  async loadSession(): Promise<void> {
    try {
      const response = await api.get<{ authenticated: boolean; user?: SessionUser }>('/auth/session');
      runInAction(() => {
        this.user = response.authenticated ? (response.user ?? null) : null;
      });
      // Nothing is loaded here: the portfolio, the feed, the narration badge
      // and the proposals count are fetched by the dashboard's queries when it
      // mounts, on a fresh sign-in and a reload alike.
    } catch {
      runInAction(() => {
        this.user = null;
      });
    } finally {
      runInAction(() => {
        this.initialised = true;
      });
    }
  }

  async login(passphrase: string): Promise<void> {
    this.submitting = true;
    this.error = null;
    try {
      const user = await api.post<SessionUser>('/auth/login', { passphrase });
      runInAction(() => {
        this.user = user;
      });
    } catch (error) {
      runInAction(() => {
        this.error =
          error instanceof ApiRequestError ? error.message : 'Login failed. Please try again.';
      });
    } finally {
      runInAction(() => {
        this.submitting = false;
      });
    }
  }

  async logout(): Promise<void> {
    try {
      await api.post('/auth/logout');
    } finally {
      runInAction(() => {
        this.user = null;
        // Every cached server response is one account's. Cleared, not
        // invalidated: an invalidated query would refetch - as nobody - and
        // keep showing the previous account's numbers until it failed.
        this.root.queryClient.clear();
        this.root.observations.reset();
        // Settings are one account's, so they leave with the session rather
        // than waiting on screen for whoever signs in next.
        this.root.proposals.reset();
        this.root.settings.reset();
        this.root.targets.reset();
        this.root.topics.reset();
        this.root.telegram.reset();
        // The corpus is shared reference material rather than one account's, so
        // dropping the cache costs a refetch and protects nothing. It is reset
        // anyway so that signing out cannot leave a dialog open over the login
        // screen, and so this list stays exhaustive rather than selective.
        this.root.concepts.reset();
      });
    }
  }
}
