/**
 * MobX store root. One store per concern, all reachable from here, so any
 * component can pull exactly what it needs and nothing has to thread props.
 *
 * It also owns the query client, the cache of server state, so that a store can
 * invalidate what its write changed and sign-out can clear every account's
 * response in one call.
 */

import type { QueryClient } from '@tanstack/react-query';

import type { PortfolioResponse, TargetWeight, TopicsResponse, UserSettings } from '@traders/shared';

import { CacheMirror } from '../queries/cacheMirror.ts';
import { createQueryClient } from '../queries/queryClient.ts';
import { queryKeys } from '../queries/queryKeys.ts';

import { AskStore } from './AskStore.ts';
import { AuthStore } from './AuthStore.ts';
import { ConceptStore } from './ConceptStore.ts';
import { ImportStore } from './ImportStore.ts';
import { ObservationsStore } from './ObservationsStore.ts';
import { ProposalsStore } from './ProposalsStore.ts';
import { SettingsStore } from './SettingsStore.ts';
import { TelegramStore } from './TelegramStore.ts';
import { TargetsStore } from './TargetsStore.ts';
import { TopicsStore } from './TopicsStore.ts';

export class RootStore {
  /** The cached portfolio, for stores whose logic is computed from it. Read-only. */
  readonly portfolioCache: CacheMirror<PortfolioResponse>;
  /** The stored settings and targets, which their forms' edits are compared against. */
  readonly settingsCache: CacheMirror<UserSettings>;
  readonly targetsCache: CacheMirror<TargetWeight[]>;
  /** The topics and their limits, which the confirm screen's rules read. */
  readonly topicsCache: CacheMirror<TopicsResponse>;

  constructor(readonly queryClient: QueryClient = createQueryClient()) {
    this.portfolioCache = new CacheMirror(queryClient, queryKeys.portfolio);
    this.settingsCache = new CacheMirror(queryClient, queryKeys.settings);
    this.targetsCache = new CacheMirror(queryClient, queryKeys.targets);
    this.topicsCache = new CacheMirror(queryClient, queryKeys.topics);
  }

  readonly auth = new AuthStore(this);
  readonly observations = new ObservationsStore(this);
  readonly import = new ImportStore(this);
  readonly proposals = new ProposalsStore(this);
  readonly settings = new SettingsStore(this);
  readonly targets = new TargetsStore(this);
  readonly topics = new TopicsStore(this);
  readonly telegram = new TelegramStore(this);
  readonly concepts = new ConceptStore(this);
  readonly ask = new AskStore(this);
}
