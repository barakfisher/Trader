// @vitest-environment jsdom
/**
 * A phone's bottom bar (D382): five places, one tap each, the current one marked
 * on the pages that belong to it, and nothing about it waiting on data. On a
 * wide screen it does not exist and the header keeps its row.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
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
const { BOTTOM_BAR_QUERY } = await import('../src/lib/viewport.ts');
const { queryKeys } = await import('../src/queries/queryKeys.ts');
const { t } = await import('../src/i18n/index.ts');
const { renderWithServerState } = await import('./serverStateHarness.tsx');

const USER = { id: 'u', baseCurrency: 'USD', timezone: 'Asia/Jerusalem' };
const PLACES = [t('nav.portfolio'), t('nav.insights'), t('nav.agents'), t('nav.research'), t('nav.ask')];

/** Only the bar's query matches, so the test also proves which query it reads. */
function screenBelowBottomBarWidth() {
  window.matchMedia = ((query: string) => ({
    matches: query === BOTTOM_BAR_QUERY,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

function renderAt(path: string, user: object = USER) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  const result = renderWithServerState(<App router={router} />);
  act(() => {
    result.root.auth.user = user as never;
    result.root.auth.initialised = true;
  });
  return { ...result, router };
}

const insightsLink = (nav: HTMLElement) => nav.querySelector<HTMLAnchorElement>('a[href="/insights"]')!;

const bar = () => screen.findByRole('navigation', { name: t('nav.places') });

beforeEach(() => {
  vi.clearAllMocks();
  // Reads never answer unless a test says so: this is the loading state.
  get.mockReturnValue(new Promise(() => {}));
  window.scrollTo = () => {};
  screenBelowBottomBarWidth();
});
afterEach(() => {
  cleanup();
  // jsdom has none; leaving one behind would make every later test a phone.
  delete (window as { matchMedia?: unknown }).matchMedia;
});

it('holds the five places in order, before any data has answered', async () => {
  renderAt('/');
  const links = within(await bar()).getAllByRole('link');
  expect(links.map((link) => link.textContent)).toEqual(PLACES);
  expect(within(await bar()).queryByRole('status')).toBeNull();
});

it.each([
  ['/', 'portfolio'],
  ['/holdings/h-1', 'portfolio'],
  ['/targets', 'portfolio'],
  ['/insights', 'insights'],
  ['/proposals/p-1', 'insights'],
  ['/agents/a-1', 'agents'],
  ['/research', 'research'],
  ['/ask', 'ask'],
] as const)('at %s it marks %s and nothing else', async (path, place) => {
  renderAt(path);
  const marked = within(await bar())
    .getAllByRole('link')
    .filter((link) => link.getAttribute('aria-current') === 'page');
  expect(marked.map((link) => link.textContent)).toEqual([t(`nav.${place}`)]);
});

it.each(['/settings', '/admin'])('marks nothing at %s, which is not on the bar', async (path) => {
  renderAt(path);
  const links = within(await bar()).getAllByRole('link');
  expect(links.filter((link) => link.getAttribute('aria-current'))).toEqual([]);
});

it('goes to a place in one tap', async () => {
  const { router } = renderAt('/');
  fireEvent.click(within(await bar()).getByRole('link', { name: t('nav.agents') }));
  await vi.waitFor(() => expect(router.state.location.pathname).toBe('/agents'));
});

it('shows open proposals and unread findings on Insights', async () => {
  get.mockImplementation((path: string) => {
    if (path === '/proposals?state=open') return Promise.resolve({ proposals: [{ id: 'p', state: 'pending' }] });
    if (path.startsWith('/proposals')) return Promise.resolve({ proposals: [] });
    if (path === '/observations/days') return Promise.resolve({ days: [{ unread: 2 }] });
    return new Promise(() => {});
  });
  renderAt('/');
  const insights = insightsLink(await bar());
  await vi.waitFor(() => expect(within(insights).getByText('1')).toBeTruthy());
  await vi.waitFor(() => expect(within(insights).getByRole('status', { name: t('nav.unread') })).toBeTruthy());
});

it('keeps a clean slot when there is nothing open and nothing new', async () => {
  get.mockImplementation((path: string) => {
    if (path.startsWith('/proposals')) return Promise.resolve({ proposals: [] });
    if (path === '/observations/days') return Promise.resolve({ days: [{ unread: 0 }] });
    return new Promise(() => {});
  });
  const { root } = renderAt('/');
  const nav = await bar();
  await vi.waitFor(() => {
    expect(root.queryClient.getQueryState(queryKeys.proposals)?.status).toBe('success');
    expect(root.queryClient.getQueryState(queryKeys.insightsDays)?.status).toBe('success');
  });
  expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(PLACES);
  expect(within(nav).queryByRole('status')).toBeNull();
});

it('keeps every place, says nothing about the failure, and still navigates when its reads fail', async () => {
  get.mockRejectedValue(new Error('down'));
  const { root, router } = renderAt('/');
  const nav = await bar();
  await vi.waitFor(() => {
    expect(root.queryClient.getQueryState(queryKeys.proposals)?.status).toBe('error');
    expect(root.queryClient.getQueryState(queryKeys.insightsDays)?.status).toBe('error');
  });
  expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(PLACES);
  expect(within(nav).queryByRole('status')).toBeNull();

  fireEvent.click(within(nav).getByRole('link', { name: t('nav.research') }));
  await vi.waitFor(() => expect(router.state.location.pathname).toBe('/research'));
});

it('says the place before its count to a screen reader', async () => {
  get.mockImplementation((path: string) => {
    if (path === '/proposals?state=open') return Promise.resolve({ proposals: [{ id: 'p', state: 'pending' }] });
    if (path.startsWith('/proposals')) return Promise.resolve({ proposals: [] });
    return new Promise(() => {});
  });
  renderAt('/');
  const insights = insightsLink(await bar());
  await vi.waitFor(() => expect(insights.textContent).toBe(`${t('nav.insights')}1`));
});

it('keeps a page clear of the bar with a spacer in the flow', async () => {
  renderAt('/');
  const spacer = (await bar()).previousElementSibling!;
  expect(spacer.className).toContain('--bottom-bar-height');
});

it('appears and goes when the screen crosses the width', async () => {
  let matches = true;
  const listeners = new Set<() => void>();
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query === BOTTOM_BAR_QUERY && matches;
    },
    media: query,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  })) as unknown as typeof window.matchMedia;
  renderAt('/agents');
  await bar();

  matches = false;
  act(() => listeners.forEach((listener) => listener()));
  await vi.waitFor(() => expect(screen.queryByRole('navigation', { name: t('nav.places') })).toBeNull());

  matches = true;
  act(() => listeners.forEach((listener) => listener()));
  expect(await bar()).toBeTruthy();
});

it('moves the header to the name and the account button', async () => {
  renderAt('/agents');
  const header = await screen.findByRole('navigation', { name: t('nav.label') });
  const logo = within(header).getByRole('link', { name: t('nav.brand') });
  expect(logo.getAttribute('href')).toBe('/');
  expect(within(header).getAllByRole('link')).toHaveLength(1);

  fireEvent.click(within(header).getByRole('button', { name: t('nav.account') }));
  expect(within(header).getByRole('link', { name: t('nav.settings') })).toBeTruthy();
  expect(within(header).queryByRole('link', { name: t('nav.admin') })).toBeNull();
  expect(within(header).getByRole('button', { name: t('nav.signOut') })).toBeTruthy();
});

it('offers Admin in the account menu only to the admin', async () => {
  renderAt('/', { ...USER, role: 'admin' });
  fireEvent.click(await screen.findByRole('button', { name: t('nav.account') }));
  expect(screen.getByRole('link', { name: new RegExp(`^${t('nav.admin')}`) })).toBeTruthy();
});

it.each([
  [1, true],
  [0, false],
])('with %i sign-ups waiting, the account button flags it: %s', async (pending, flagged) => {
  get.mockImplementation((path: string) =>
    path === '/admin/signups/count' ? Promise.resolve({ pending }) : new Promise(() => {}),
  );
  const { root } = renderAt('/', { ...USER, role: 'admin' });
  const button = await screen.findByRole('button', { name: t('nav.account') });
  await vi.waitFor(() =>
    expect(root.queryClient.getQueryState(queryKeys.adminSignupCount)?.status).toBe('success'),
  );
  await vi.waitFor(() => expect(button.querySelector('.bg-accent') !== null).toBe(flagged));
});

it('does not exist on a wide screen, where the header keeps its row', async () => {
  delete (window as { matchMedia?: unknown }).matchMedia;
  renderAt('/');
  const header = await screen.findByRole('navigation', { name: t('nav.label') });
  expect(screen.queryByRole('navigation', { name: t('nav.places') })).toBeNull();
  expect(within(header).getByRole('link', { name: t('nav.portfolio') })).toBeTruthy();
  expect(within(header).getByRole('link', { name: t('nav.agents') })).toBeTruthy();
  expect(within(header).getByRole('link', { name: t('nav.portfolio') }).getAttribute('aria-current')).toBe('page');
});

it('does not exist behind the sign-in gate', async () => {
  const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }));
  const result = renderWithServerState(<App router={router} />);
  act(() => {
    result.root.auth.initialised = true;
  });
  await screen.findAllByRole('button');
  expect(screen.queryByRole('navigation', { name: t('nav.places') })).toBeNull();
});

it.each([
  ['a forced password change', { mustChangePassword: true }],
  ['a legal version to accept', { legalAcceptanceRequired: '2026-01-01' }],
])('does not exist behind %s', async (_, gate) => {
  renderAt('/', { ...USER, ...gate });
  await screen.findAllByRole('button');
  expect(screen.queryByRole('navigation', { name: t('nav.places') })).toBeNull();
});

it.each(['/privacy', '/verify', '/reset'])('does not exist at %s, which renders outside the router', async (path) => {
  window.history.replaceState(null, '', path);
  try {
    renderAt('/');
    await act(async () => {});
    expect(screen.queryByRole('navigation', { name: t('nav.places') })).toBeNull();
  } finally {
    window.history.replaceState(null, '', '/');
  }
});
