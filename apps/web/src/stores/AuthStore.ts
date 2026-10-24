import { makeAutoObservable, reaction, runInAction } from 'mobx';

import type { SessionUser, UiLanguage } from '@traders/shared';

import { ApiRequestError, api } from '../api/client.ts';
import { onSessionEnded } from '../api/sessionEnded.ts';
import { setDisplayTimeZone } from '../lib/relativeTime.ts';
import { applyLanguage, signedOutLanguage, t } from '../i18n/index.ts';
import type { RootStore } from './RootStore.ts';

export class AuthStore {
  user: SessionUser | null = null;
  /** Null until the first session check resolves, so we can avoid a login flash. */
  initialised = false;
  submitting = false;
  error: string | null = null;
  /**
   * The session ended while the app was open - signed out from another device,
   * disabled, or run out (D261) - so the sign-in page says why it is showing.
   */
  sessionEndedNotice = false;

  constructor(private readonly root: RootStore) {
    makeAutoObservable(this, {}, { autoBind: true });
    onSessionEnded(this.sessionEnded);
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

  async login(email: string, password: string): Promise<void> {
    this.submitting = true;
    this.error = null;
    this.sessionEndedNotice = false;
    try {
      const user = await api.post<SessionUser>('/auth/login', { email, password });
      runInAction(() => {
        this.user = user;
      });
    } catch (error) {
      runInAction(() => {
        this.error = loginErrorMessage(error);
      });
    } finally {
      runInAction(() => {
        this.submitting = false;
      });
    }
  }

  /**
   * Change this account's password. The server ends every other session and
   * reissues this one, and the returned user no longer must change it, so the
   * one-time password screen gives way to the app. Throws for the form to show.
   */
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const user = await api.post<SessionUser>('/auth/password', { currentPassword, newPassword });
    runInAction(() => {
      this.user = user;
    });
  }

  /** A new sign-in address: the server reissues this session, as for a password change. */
  async changeEmail(email: string, currentPassword: string): Promise<void> {
    const user = await api.post<SessionUser>('/auth/email', { email, currentPassword });
    runInAction(() => {
      this.user = user;
    });
  }

  /** The account's own zone (D163); the display zone follows the returned user. */
  async changeTimeZone(timezone: string): Promise<void> {
    const user = await api.post<SessionUser>('/auth/timezone', { timezone });
    runInAction(() => {
      this.user = user;
    });
  }

  async logout(): Promise<void> {
    try {
      await api.post('/auth/logout');
    } finally {
      this.clearSession();
    }
  }

  /**
   * A request was refused for want of a session while one was held (D261):
   * this device was signed out from another, or the account was disabled. The
   * app leaves exactly as a sign-out does, and the sign-in page says why.
   */
  sessionEnded(): void {
    if (this.user === null) return;
    this.clearSession();
    this.sessionEndedNotice = true;
  }

  /** Everything one account's session left on screen goes with it. */
  private clearSession(): void {
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
  }
}

/** The server's refusal as a sentence in the user's language, by its code. */
function loginErrorMessage(error: unknown): string {
  if (!(error instanceof ApiRequestError)) return t('errors.loginFailed');
  if (error.status === 401) return t('login.errors.incorrect');
  if (error.code === 'account_pending') return t('login.errors.pending');
  if (error.code === 'account_not_active') return t('login.errors.notActive');
  return error.message;
}
