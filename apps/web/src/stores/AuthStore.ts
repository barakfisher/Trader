import { makeAutoObservable, reaction, runInAction } from 'mobx';

import type {
  AccountDeletionInput,
  AccountDeletionResponse,
  LegalAcceptanceInput,
  LoginResponse,
  ResendVerificationInput,
  SessionUser,
  UiLanguage,
} from '@traders/shared';

import { ApiRequestError, api } from '../api/client.ts';
import { onLegalAcceptanceRequired, onSessionEnded } from '../api/sessionEnded.ts';
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
   * The last sign-in was refused because the address was never confirmed
   * (D306): the page offers to send the link again with the same email and
   * password.
   */
  unverified = false;
  /**
   * The session ended while the app was open - signed out from another device,
   * disabled, or run out (D261) - so the sign-in page says why it is showing.
   */
  sessionEndedNotice = false;
  /**
   * The account was just closed at the user's request (D264): when it will be
   * erased, in the account's own zone and language - signed out, the display
   * zone is UTC and the language the browser's - for the screen that says so in place of the sign-in page.
   */
  closed: { deletionDueAt: string; timeZone: string; language: UiLanguage } | null = null;
  /** This sign-in reopened an account waiting to be deleted (D264): the app says so once. */
  deletionCancelled = false;

  constructor(private readonly root: RootStore) {
    makeAutoObservable(this, {}, { autoBind: true });
    onSessionEnded(this.sessionEnded);
    // A new legal version published while the page was open (D265): the
    // session says which, and the app gives way to the acceptance.
    onLegalAcceptanceRequired(() => void this.loadSession());
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
      // The closed screen (D264) is still the account's, so in its language.
      () => this.user?.language ?? this.closed?.language ?? signedOutLanguage(),
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
    this.unverified = false;
    this.sessionEndedNotice = false;
    this.closed = null;
    try {
      const { deletionCancelled, ...user } = await api.post<LoginResponse>('/auth/login', { email, password });
      runInAction(() => {
        this.user = user;
        this.deletionCancelled = deletionCancelled;
      });
    } catch (error) {
      runInAction(() => {
        this.unverified = error instanceof ApiRequestError && error.code === EMAIL_UNVERIFIED;
        this.error = this.unverified ? null : loginErrorMessage(error);
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

  /**
   * Ask for a new sign-in address (D259): the server stores it as pending and
   * mails it a link; the returned user still signs in with the current one.
   */
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

  /**
   * Accept the privacy policy and terms the page showed (D265). The returned
   * user no longer needs to, so the acceptance gives way to the app. Throws
   * for the page to show - a version replaced while it was open among them.
   */
  async acceptLegal(version: string): Promise<void> {
    const user = await api.post<SessionUser>('/auth/legal/accept', { version } satisfies LegalAcceptanceInput);
    runInAction(() => {
      this.user = user;
    });
  }

  /** A new confirmation link for an unverified sign-up (D306); throws for the page to say why not. */
  async resendVerification(email: string, password: string): Promise<void> {
    await api.post('/auth/verify/resend', { email, password } satisfies ResendVerificationInput);
  }

  /**
   * Close this account (D264). The server ends every session, this one too, so
   * the app leaves as a sign-out does and the closed screen says when the
   * account goes. Throws for the card to show.
   */
  async deleteAccount(input: AccountDeletionInput): Promise<void> {
    const { deletionDueAt } = await api.post<AccountDeletionResponse>('/account/deletion', input);
    runInAction(() => {
      const timeZone = this.user?.timezone ?? 'UTC';
      const language = this.user?.language ?? signedOutLanguage();
      // Set before the session clears, so the page never draws in another language between.
      this.closed = { deletionDueAt, timeZone, language };
      this.clearSession();
    });
  }

  /** The closed screen gives way to the sign-in page. */
  leaveClosedScreen(): void {
    this.closed = null;
  }

  /** A sign-in through Google or GitHub came back having cancelled a deletion (`?oauth=restored`). */
  noteDeletionCancelled(): void {
    this.deletionCancelled = true;
  }

  dismissDeletionCancelled(): void {
    this.deletionCancelled = false;
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
    this.deletionCancelled = false;
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

/** The server's code for a sign-in to an address never confirmed (D306). */
export const EMAIL_UNVERIFIED = 'email_unverified';

/** The server's refusal as a sentence in the user's language, by its code. */
function loginErrorMessage(error: unknown): string {
  if (!(error instanceof ApiRequestError)) return t('errors.loginFailed');
  if (error.status === 401) return t('login.errors.incorrect');
  if (error.code === 'account_pending') return t('login.errors.pending');
  if (error.code === 'account_not_active') return t('login.errors.notActive');
  return error.message;
}
