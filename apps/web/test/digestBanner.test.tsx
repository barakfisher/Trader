// @vitest-environment jsdom
/**
 * The digest banner on the dashboard (UX4): shown while the last digest is
 * unseen, gone after a dismiss or after opening the digest - and "seen" is
 * what the server says, so the banner follows the account, not the browser.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';

import type { DigestEntry, DigestResponse } from '@traders/shared';

const get = vi.fn();
const post = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>(
    '../src/api/client.ts',
  );
  return { ...actual, api: { get, post, put: vi.fn(), delete: vi.fn(), postForm: vi.fn() } };
});

const { App } = await import('../src/App.tsx');
const { createAppRouter } = await import('../src/router.tsx');
const { renderWithServerState } = await import('./serverStateHarness.tsx');

const SENT = '2026-10-08T08:42:40.736Z';

const entry = (observationId: string | null): DigestEntry => ({
  observationId,
  headline: observationId === null ? null : 'SMR is -30.6% from its 30-day high',
  localized: {},
  severity: observationId === null ? null : 'high',
  subjectRef: observationId === null ? null : 'instrument:SMR',
  reason: 'quiet_hours',
  createdAt: '2026-10-08T00:51:41.000Z',
});

/** What the server holds: the digest, and whether this account has seen it. */
let seen: boolean;

function digest(): DigestResponse {
  return {
    next: { entries: [] },
    last: { sentAt: SENT, entries: [entry('o-1'), entry('o-2'), entry(null)], seen },
  };
}

function renderAt(path: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  const result = renderWithServerState(<App router={router} />);
  act(() => {
    result.root.auth.user = { id: 'u', baseCurrency: 'USD', timezone: 'Asia/Jerusalem' } as never;
    result.root.auth.initialised = true;
  });
  return { ...result, router };
}

beforeEach(() => {
  vi.clearAllMocks();
  seen = false;
  get.mockImplementation((path: string) =>
    path === '/notifications/digest' ? Promise.resolve(digest()) : new Promise(() => {}),
  );
  post.mockImplementation((path: string) => {
    if (path !== '/notifications/digest/seen') return new Promise(() => {});
    seen = true;
    return Promise.resolve({ seenAt: SENT });
  });
  window.scrollTo = () => {};
});
afterEach(cleanup);

const banner = () => screen.queryByText(/Your daily digest is ready/);

it('announces an unseen digest with its findings, not its notices', async () => {
  renderAt('/');
  expect((await screen.findByText(/Your daily digest is ready/)).textContent).toMatch(/^Your daily digest is ready: 2 findings, sent /);
  expect(screen.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/insights?tab=digest');
});

it('says nothing about a digest already seen', async () => {
  seen = true;
  renderAt('/');
  await screen.findByRole('heading', { name: 'Portfolio' });
  await waitFor(() => expect(get).toHaveBeenCalledWith('/notifications/digest'));
  expect(banner()).toBeNull();
});

it('goes on dismiss, and tells the server which digest was dismissed', async () => {
  renderAt('/');
  fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
  await waitFor(() => expect(banner()).toBeNull());
  expect(post).toHaveBeenCalledWith('/notifications/digest/seen', { sentAt: SENT });
});

it('goes once the digest is opened, by the link or any other way', async () => {
  const { router } = renderAt('/');
  fireEvent.click(await screen.findByRole('link', { name: 'Open' }));
  await waitFor(() => expect(router.state.location.pathname).toBe('/insights'));
  await waitFor(() => expect(post).toHaveBeenCalledWith('/notifications/digest/seen', { sentAt: SENT }));
  expect(post).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole('link', { name: 'Portfolio' }));
  await screen.findByRole('heading', { name: 'Portfolio' });
  expect(banner()).toBeNull();
});

it('does not mark it again and again when the server will not record it', async () => {
  post.mockImplementation(() => Promise.reject(new Error('down')));
  renderAt('/insights?tab=digest');
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  // The failed write re-reads `seen: false`; the tab must not try again in a loop.
  await waitFor(() => expect(get.mock.calls.filter(([path]) => path === '/notifications/digest').length).toBeGreaterThan(1));
  expect(post).toHaveBeenCalledTimes(1);
});
