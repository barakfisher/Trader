/**
 * A MobX-observable, read-only view of one query's cached response.
 *
 * For stores whose client-side logic is computed from server state - the
 * targets form compares what is typed against the weights actually held. The
 * store reads `mirror.data` inside its computeds and they recompute when the
 * cache changes, whoever changed it.
 *
 * It is not a copy the store has to keep fresh. It never fetches and never
 * writes; the cache pushes every change to it. A component is still what
 * causes a fetch, through the query's hook.
 *
 * It listens to the whole cache rather than attaching a `QueryObserver`,
 * because `queryClient.clear()` at sign-out removes the query itself: an
 * observer stays bound to the removed query and would never see the next
 * account's portfolio, while the cache announces both the removal and the
 * query that replaces it.
 */

import { hashKey, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { makeObservable, observable, runInAction } from 'mobx';

export class CacheMirror<T> {
  data: T | undefined = undefined;

  constructor(client: QueryClient, queryKey: QueryKey) {
    makeObservable(this, { data: observable.ref });
    const hash = hashKey(queryKey);
    const read = () => client.getQueryData<T>(queryKey);
    this.data = read();
    // Lives as long as the client: one app, one root store, one subscription.
    client.getQueryCache().subscribe((event) => {
      if (event.query.queryHash !== hash) return;
      const next = read();
      if (next !== this.data) runInAction(() => (this.data = next));
    });
  }
}
