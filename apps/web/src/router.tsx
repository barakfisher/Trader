/**
 * Every view has an address.
 *
 * Until M6 the app had one URL: a reload landed on the portfolio, a view could
 * not be bookmarked or sent, and the browser's back button left the app. The
 * routes are declared in code rather than generated from files: nine routes do
 * not need a build step, and code keeps them in one place a reader can see.
 *
 * The router only renders once the session is known (`App.tsx`), so a signed-out
 * visitor to `/settings` sees the sign-in screen at `/settings`, and lands on
 * settings after signing in.
 */

import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
} from '@tanstack/react-router';

import { ConceptDialog } from './components/ConceptDialog.tsx';
import { AgentPage } from './pages/AgentPage.tsx';
import { AgentsPage } from './pages/AgentsPage.tsx';
import { AdminPage } from './pages/AdminPage.tsx';
import { AskPage } from './pages/AskPage.tsx';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { HoldingPage } from './pages/HoldingPage.tsx';
import { ProposalPage } from './pages/ProposalPage.tsx';
import { ProposalsPage } from './pages/ProposalsPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { TargetsPage } from './pages/TargetsPage.tsx';
import { TopicsPage } from './pages/TopicsPage.tsx';

const rootRoute = createRootRoute({
  component: () => (
    <>
      <Outlet />
      {/* Mounted beside the routes rather than inside the feed: it is an
          overlay, and a concept opened from one view must not be unmounted by
          navigating to another. It renders nothing while no concept is open. */}
      <ConceptDialog />
    </>
  ),
  // An address the app does not know is not an error page worth building for
  // a one-account app: it is the portfolio.
  notFoundComponent: DashboardPage,
});

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: DashboardPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/holdings/$holdingId',
    component: HoldingPage,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: '/ask', component: AskPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/proposals', component: ProposalsPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/proposals/$proposalId',
    component: ProposalPage,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: '/targets', component: TargetsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/agents', component: AgentsPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/agents/$agentId',
    component: AgentPage,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: '/topics', component: TopicsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/admin', component: AdminPage }),
]);

/** `history` is for tests, which render at an address without a browser. */
export function createAppRouter(history?: RouterHistory) {
  return createRouter({ routeTree, history });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
