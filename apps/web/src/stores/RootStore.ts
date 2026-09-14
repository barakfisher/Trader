/**
 * MobX store root. One store per concern, all reachable from here, so any
 * component can pull exactly what it needs and nothing has to thread props.
 */

import { AuthStore } from './AuthStore.ts';
import { ImportStore } from './ImportStore.ts';
import { PortfolioStore } from './PortfolioStore.ts';

export class RootStore {
  readonly auth = new AuthStore(this);
  readonly portfolio = new PortfolioStore(this);
  readonly import = new ImportStore(this);
}
