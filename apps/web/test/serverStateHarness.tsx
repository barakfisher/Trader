/**
 * Render a component the way the app does: a real query client and a real root
 * store, with only the network (`api`) substituted by the test file's mock.
 *
 * Tests used to mock `api` and call `store.load()`; server state now lives in
 * the query cache, so the honest test renders the component and lets its query
 * fetch through the mock.
 */

import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';

import { RootStore } from '../src/stores/RootStore.ts';
import { StoreProvider } from '../src/stores/context.tsx';

/** No retries, so a mocked failure is reported at once rather than after backoff. */
export function testQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

export function renderWithServerState(
  ui: ReactElement,
  root = new RootStore(testQueryClient()),
): RenderResult & { root: RootStore } {
  const result = render(
    <QueryClientProvider client={root.queryClient}>
      <StoreProvider store={root}>{ui}</StoreProvider>
    </QueryClientProvider>,
  );
  return { ...result, root };
}

/**
 * The same, for a page that links elsewhere: `Link` needs a router around it.
 * One route, rendering `ui`, on a memory history - the app's own routes are
 * `routing.test.tsx`'s subject, not this.
 */
export function renderPage(
  ui: ReactElement,
  root = new RootStore(testQueryClient()),
): RenderResult & { root: RootStore } {
  // jsdom has no layout; the router restores scroll on navigation.
  window.scrollTo = () => {};
  const router = createRouter({
    routeTree: createRootRoute({ component: () => ui }),
    history: createMemoryHistory(),
  });
  return renderWithServerState(<RouterProvider router={router} />, root);
}
