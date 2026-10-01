import { makeAutoObservable, runInAction } from 'mobx';

import type { TelegramConnectLink } from '@traders/shared';

import { ApiRequestError, api } from '../api/client.ts';
import { t } from '../i18n/index.ts';
import type { RootStore } from './RootStore.ts';

/**
 * How to connect a Telegram chat. Whether one is connected is server state,
 * in the query cache (`queries/telegram.ts`).
 *
 * The connect link is held in memory only and never persisted - not in
 * localStorage, and not in the query cache. It is a bearer credential - whoever
 * opens it binds their own chat to this account - so it should not outlive the
 * page that asked for it.
 */
export class TelegramStore {
  /** The last link minted, until the page is left. Null before one is asked for. */
  link: TelegramConnectLink | null = null;

  minting = false;
  /** Why the last link could not be minted. */
  error: string | null = null;
  /** True when this installation has no bot configured at all. */
  unavailable = false;

  constructor(private readonly root: RootStore) {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  /**
   * Mint a connect link.
   *
   * A new one each time it is asked for, rather than a cached one: the token
   * carries its own expiry, and a stale link that silently stops verifying is a
   * worse experience than a fresh one every time. Nothing is written when a
   * link is minted, so this costs a signature and no state.
   */
  async connect(): Promise<void> {
    this.minting = true;
    this.error = null;
    this.unavailable = false;
    try {
      const link = await api.post<TelegramConnectLink>('/telegram/bind-token');
      runInAction(() => {
        this.link = link;
      });
    } catch (error) {
      runInAction(() => {
        if (error instanceof ApiRequestError && error.status === 503) {
          // Not a failure the user can act on: no bot is configured here.
          this.unavailable = true;
          return;
        }
        this.error =
          error instanceof ApiRequestError ? error.message : t('telegram.mintFailed');
      });
    } finally {
      runInAction(() => {
        this.minting = false;
      });
    }
  }

  /** Drop the link from memory once it has been used or the page is left. */
  forgetLink(): void {
    this.link = null;
  }

  reset(): void {
    this.link = null;
    this.error = null;
    this.unavailable = false;
  }
}
