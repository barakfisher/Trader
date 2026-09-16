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
      if (this.user) {
        void this.root.portfolio.load();
        void this.root.observations.load();
      }
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
      await this.root.portfolio.load();
      void this.root.observations.load();
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
        this.root.portfolio.reset();
        this.root.observations.reset();
      });
    }
  }
}
