/**
 * MobX store root. One store per concern, all reachable from here, so any
 * component can pull exactly what it needs and nothing has to thread props.
 */

import { AuthStore } from './AuthStore.ts';
import { ImportStore } from './ImportStore.ts';
import { NavigationStore } from './NavigationStore.ts';
import { ObservationsStore } from './ObservationsStore.ts';
import { PortfolioStore } from './PortfolioStore.ts';
import { ProposalsStore } from './ProposalsStore.ts';
import { SettingsStore } from './SettingsStore.ts';

export class RootStore {
  readonly auth = new AuthStore(this);
  readonly portfolio = new PortfolioStore(this);
  readonly observations = new ObservationsStore(this);
  readonly import = new ImportStore(this);
  readonly proposals = new ProposalsStore(this);
  readonly settings = new SettingsStore(this);
  readonly navigation = new NavigationStore(this);
}
