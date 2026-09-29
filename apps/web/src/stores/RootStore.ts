/**
 * MobX store root. One store per concern, all reachable from here, so any
 * component can pull exactly what it needs and nothing has to thread props.
 *
 * It also owns the query client, the cache of server state, so that a store can
 * invalidate what its write changed and sign-out can clear every account's
 * response in one call.
 */

import type { QueryClient } from '@tanstack/react-query';

import type { PortfolioResponse } from '@traders/shared';

import { CacheMirror } from '../queries/cacheMirror.ts';
import { createQueryClient } from '../queries/queryClient.ts';
import { queryKeys } from '../queries/queryKeys.ts';

import { AuthStore } from './AuthStore.ts';
import { ConceptStore } from './ConceptStore.ts';
import { ImportStore } from './ImportStore.ts';
import { NarrationStore } from './NarrationStore.ts';
import { NavigationStore } from './NavigationStore.ts';
import { ObservationsStore } from './ObservationsStore.ts';
import { ProposalsStore } from './ProposalsStore.ts';
import { SettingsStore } from './SettingsStore.ts';
import { TelegramStore } from './TelegramStore.ts';
import { TargetsStore } from './TargetsStore.ts';
import { TopicsStore } from './TopicsStore.ts';

export class RootStore {
  /** The cached portfolio, for stores whose logic is computed from it. Read-only. */
  readonly portfolioCache: CacheMirror<PortfolioResponse>;

  constructor(readonly queryClient: QueryClient = createQueryClient()) {
    this.portfolioCache = new CacheMirror(queryClient, queryKeys.portfolio);
  }

  readonly auth = new AuthStore(this);
  readonly observations = new ObservationsStore(this);
  readonly import = new ImportStore(this);
  readonly proposals = new ProposalsStore(this);
  readonly narration = new NarrationStore(this);
  readonly settings = new SettingsStore(this);
  readonly targets = new TargetsStore(this);
  readonly topics = new TopicsStore(this);
  readonly telegram = new TelegramStore(this);
  readonly concepts = new ConceptStore(this);
  readonly navigation = new NavigationStore(this);
}
