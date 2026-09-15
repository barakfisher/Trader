import { makeAutoObservable, runInAction } from 'mobx';

import type { HoldingInput, PortfolioResponse } from '@traders/shared';

import { ApiRequestError, api } from '../api/client.ts';
import type { RootStore } from './RootStore.ts';

export class PortfolioStore {
  data: PortfolioResponse | null = null;
  loading = false;
  /** Distinct from `loading`: a refresh keeps the current numbers on screen. */
  refreshing = false;
  error: string | null = null;
  lastLoadedAt: Date | null = null;
  mutating = false;
  mutationError: string | null = null;

  constructor(private readonly root: RootStore) {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  get isEmpty(): boolean {
    return this.data !== null && this.data.holdings.length === 0;
  }

  /**
   * The oldest observation time among priced holdings, as an ISO string.
   *
   * This is what the header should show, and it is not the same thing as
   * `lastLoadedAt`. Quotes come from a delayed feed and are dated to the
   * provider's observation window, so a portfolio "refreshed" seconds ago can be
   * built entirely from prices that were true twenty minutes ago. Reporting the
   * fetch time as though it were the price time is the same misrepresentation
   * the backend used to make when it stamped every quote with `now()`.
   */
  get pricesAsOf(): string | null {
    const times = (this.data?.holdings ?? [])
      .map((holding) => holding.quote?.asOf)
      .filter((asOf): asOf is string => Boolean(asOf));
    if (times.length === 0) return null;
    return times.reduce((oldest, current) => (current < oldest ? current : oldest));
  }

  /** True when any displayed price came from a cached last-known-good value. */
  get hasStaleQuotes(): boolean {
    return (this.data?.holdings ?? []).some((holding) => holding.quote?.stale === true);
  }

  get baseCurrency(): string {
    return this.data?.summary.baseCurrency ?? this.root.auth.user?.baseCurrency ?? 'USD';
  }

  async load(options: { silent?: boolean } = {}): Promise<void> {
    if (options.silent) this.refreshing = true;
    else this.loading = true;
    this.error = null;
    try {
      const data = await api.get<PortfolioResponse>('/portfolio');
      runInAction(() => {
        this.data = data;
        this.lastLoadedAt = new Date();
      });
    } catch (error) {
      runInAction(() => {
        this.error =
          error instanceof ApiRequestError ? error.message : 'Could not load your portfolio.';
      });
    } finally {
      runInAction(() => {
        this.loading = false;
        this.refreshing = false;
      });
    }
  }

  async addHolding(input: HoldingInput): Promise<boolean> {
    this.mutating = true;
    this.mutationError = null;
    try {
      await api.post('/holdings', input);
      await this.load({ silent: true });
      return true;
    } catch (error) {
      runInAction(() => {
        this.mutationError =
          error instanceof ApiRequestError ? error.message : 'Could not add that holding.';
      });
      return false;
    } finally {
      runInAction(() => {
        this.mutating = false;
      });
    }
  }

  async updateQuantity(holdingId: string, quantity: string): Promise<boolean> {
    this.mutationError = null;
    try {
      await api.patch(`/holdings/${holdingId}`, { quantity });
      await this.load({ silent: true });
      return true;
    } catch (error) {
      runInAction(() => {
        this.mutationError =
          error instanceof ApiRequestError ? error.message : 'Could not update that holding.';
      });
      return false;
    }
  }

  async removeHolding(holdingId: string): Promise<void> {
    this.mutationError = null;
    try {
      await api.delete(`/holdings/${holdingId}`);
      await this.load({ silent: true });
    } catch (error) {
      runInAction(() => {
        this.mutationError =
          error instanceof ApiRequestError ? error.message : 'Could not remove that holding.';
      });
    }
  }

  reset(): void {
    this.data = null;
    this.error = null;
    this.lastLoadedAt = null;
  }
}
