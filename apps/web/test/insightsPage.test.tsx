// @vitest-environment jsdom
/**
 * The Insights page (UX3): the observations feed and the daily digest as two
 * tabs whose choice lives in the address, neither on the dashboard any more,
 * and an old link to the dashboard's filtered feed still landing on that feed.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';

const get = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>(
    '../src/api/client.ts',
  );
  return { ...actual, api: { get, post: vi.fn(), put: vi.fn(), delete: vi.fn(), postForm: vi.fn() } };
});

const { App } = await import('../src/App.tsx');
const { createAppRouter } = await import('../src/router.tsx');
const { renderWithServerState } = await import('./serverStateHarness.tsx');

const USER = { id: 'u', baseCurrency: 'USD', timezone: 'Asia/Jerusalem' };

function renderAt(path: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  const result = renderWithServerState(<App router={router} />);
  act(() => {
    result.root.auth.user = USER as never;
    result.root.auth.initialised = true;
  });
  return { ...result, router };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reads never answer: this is about which cards are where, not what they hold.
  get.mockReturnValue(new Promise(() => {}));
  // jsdom has no layout; the router restores scroll on navigation.
  window.scrollTo = () => {};
});
afterEach(cleanup);

const selected = (name: string) => screen.getByRole('tab', { name }).getAttribute('aria-selected');

it('opens on the observations feed, and the digest is a tab away with its own address', async () => {
  const { router } = renderAt('/insights');
  expect(await screen.findByRole('heading', { name: 'Insights' })).toBeTruthy();
  expect(selected('Observations')).toBe('true');
  expect(screen.getByRole('heading', { name: 'Observations' })).toBeTruthy();

  fireEvent.click(screen.getByRole('tab', { name: 'Daily digest' }));
  expect(await screen.findByRole('heading', { name: 'Daily digest' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Observations' })).toBeNull();
  expect(router.state.location.search).toEqual({ tab: 'digest' });
});

it('lands on the tab a link names', async () => {
  renderAt('/insights?tab=digest');
  expect(await screen.findByRole('heading', { name: 'Daily digest' })).toBeTruthy();
  expect(selected('Daily digest')).toBe('true');
});

it('reads the feed filters from the address', async () => {
  renderAt('/insights?tab=observations&severity=high&symbol=NVDA');
  await screen.findByRole('heading', { name: 'Observations' });
  expect(get).toHaveBeenCalledWith(expect.stringMatching(/severity=high/));
  expect(get).toHaveBeenCalledWith(expect.stringMatching(/symbol=NVDA/));
});

it('shows neither the feed nor the digest on the dashboard', async () => {
  renderAt('/');
  expect(await screen.findByRole('heading', { name: 'Portfolio' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Observations' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Daily digest' })).toBeNull();
});

it("sends an old link to the dashboard's filtered feed to the same feed here", async () => {
  const { router } = renderAt('/?severity=high&symbol=nvda');
  expect(await screen.findByRole('heading', { name: 'Insights' })).toBeTruthy();
  expect(router.state.location.pathname).toBe('/insights');
  // Filters are cleaned on the way, as the feed would have read them.
  expect(router.state.location.search).toEqual({ tab: 'observations', severity: 'high', symbol: 'NVDA' });
});

it('links Insights from the bar', async () => {
  renderAt('/');
  const link = await screen.findByRole('link', { name: 'Insights' });
  expect(link.getAttribute('href')).toBe('/insights');
});
