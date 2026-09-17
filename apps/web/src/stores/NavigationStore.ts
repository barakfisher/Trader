/**
 * Which full-page view the app is showing.
 *
 * Not a router, deliberately. A routing table earns its dependency when a view
 * is worth a URL - one you can send to someone, or reload back into - and both
 * views here are one private account's dashboard behind a session cookie. The
 * cost of that choice is real and worth naming: the settings page cannot be
 * linked to, and a reload lands back on the portfolio. When the first genuinely
 * addressable view arrives (a single proposal, which a Telegram message will
 * need to link at), this store is the one place that changes.
 */

import { makeAutoObservable } from 'mobx';

import type { RootStore } from './RootStore.ts';

export type AppView = 'portfolio' | 'settings' | 'proposals';

export class NavigationStore {
  view: AppView = 'portfolio';

  constructor(private readonly root: RootStore) {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  show(view: AppView): void {
    this.view = view;
  }

  /** Signing out returns to the portfolio, so the next sign-in starts at the top. */
  reset(): void {
    this.view = 'portfolio';
  }
}
