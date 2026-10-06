import { makeAutoObservable, reaction, runInAction } from 'mobx';

import type { SessionUser, UiLanguage } from '@traders/shared';

import { ApiRequestError, api } from '../api/client.ts';
import { setDisplayTimeZone } from '../lib/relativeTime.ts';
import { applyLanguage, signedOutLanguage, t } from '../i18n/index.ts';
import type { RootStore } from './RootStore.ts';

export class AuthStore {
  user: SessionUser | null = null;
  /** Null until the first session check resolves, so we can avoid a login flash. */
  initialised = false;
  submitting = false;
  error: string | null = null;

  constructor(private readonly root: RootStore) {
    makeAutoObservable(this, {}, { autoBind: true });
    // Every time on screen is shown in the signed-in user's timezone. Followed
    // by reaction rather than set in `login` and `loadSession`, so however the
    // user changes - a sign-in, a reload, a sign-out - the zone follows it
    // before anything renders with the old one.
    reaction(
      () => this.user?.timezone ?? null,
      (zone) => setDisplayTimeZone(zone),
      { fireImmediately: true },
    );
    // And in the user's language, by the same reasoning: `App` draws nothing
    // until the session is known, so the first screen is already in it. Signed
    // out - the sign-in page - the account's setting is unknown, so the
    // browser's language stands in for it.
    reaction(
      () => this.user?.language ?? signedOutLanguage(),
      (language) => applyLanguage(language),
      { fireImmediately: true },
    );
  }

  /** A saved language change, so the page follows it without a reload. */
  adoptLanguage(language: UiLanguage): void {
    if (this.user !== null) this.user = { ...this.user, language };
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
          error instanceof ApiRequestError ? error.message : t('errors.loginFailed');
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
        // Questions about one account's holdings are that account's.
        this.root.ask.reset();
      });
    }
  }
}
