// @vitest-environment jsdom
/**
 * The Insights page (UX3, decision 134): Alerts, Proposals, the daily digest and
 * All findings as four tabs whose choice lives in the address, none of them on
 * the dashboard, and old links - the dashboard's filtered feed, `/proposals` -
 * still landing where they meant.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
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

it('opens on Alerts, and every other tab is a tab away with its own address', async () => {
  const { router } = renderAt('/insights');
  expect(await screen.findByRole('heading', { name: 'Insights' })).toBeTruthy();
  expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
    'Alerts',
    'Proposals',
    'Daily digest',
    'All findings',
  ]);
  expect(selected('Alerts')).toBe('true');
  expect(screen.getByRole('heading', { name: 'Alerts' })).toBeTruthy();

  fireEvent.click(screen.getByRole('tab', { name: 'Daily digest' }));
  expect(await screen.findByRole('heading', { name: 'Daily digest' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Alerts' })).toBeNull();
  expect(router.state.location.search).toEqual({ tab: 'digest' });

  fireEvent.click(screen.getByRole('tab', { name: 'All findings' }));
  expect(await screen.findByRole('heading', { name: 'Observations' })).toBeTruthy();
  expect(router.state.location.search).toEqual({ tab: 'observations' });
});

it('opens an unknown tab on Alerts rather than failing', async () => {
  renderAt('/insights?tab=news');
  await screen.findByRole('heading', { name: 'Alerts' });
  expect(selected('Alerts')).toBe('true');
});

it('sends /proposals to the Proposals tab, which holds the inbox', async () => {
  const { router } = renderAt('/proposals');
  expect(await screen.findByRole('heading', { name: 'Insights' })).toBeTruthy();
  expect(router.state.location.pathname).toBe('/insights');
  expect(router.state.location.search).toEqual({ tab: 'proposals' });
  expect(selected('Proposals')).toBe('true');
  expect(get).toHaveBeenCalledWith(expect.stringMatching(/^\/proposals\?state=open/));
});

it('keeps the source pill in the address, and asks the server for that source', async () => {
  const { router } = renderAt('/insights?tab=alerts');
  await screen.findByRole('heading', { name: 'Alerts' });
  expect(get).toHaveBeenCalledWith('/notifications/alerts?limit=10');

  fireEvent.click(screen.getByRole('button', { name: 'Agents' }));
  await waitFor(() =>
    expect(get).toHaveBeenCalledWith('/notifications/alerts?limit=10&source=agents'),
  );
  expect(router.state.location.search).toEqual({ tab: 'alerts', source: 'agents' });
  expect(screen.getByRole('button', { name: 'Agents' }).getAttribute('aria-pressed')).toBe('true');
});

it('treats an unknown source as All', async () => {
  renderAt('/insights?tab=alerts&source=everything');
  await screen.findByRole('heading', { name: 'Alerts' });
  expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');
  expect(get).toHaveBeenCalledWith('/notifications/alerts?limit=10');
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
