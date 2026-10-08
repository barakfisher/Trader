// @vitest-environment jsdom
/**
 * The bar every page shares (UX2): rendered once on every route, the current
 * place marked, and its menus usable from the keyboard - Escape closes one and
 * hands focus back to the button that opened it.
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
  // Reads never answer: this is about the bar, not what the pages show.
  get.mockReturnValue(new Promise(() => {}));
  // jsdom has no layout; the router restores scroll on navigation.
  window.scrollTo = () => {};
});
afterEach(cleanup);

it.each([
  '/',
  '/insights',
  '/insights?tab=digest',
  '/agents',
  '/agents/a-1',
  '/topics',
  '/ask',
  '/proposals',
  '/proposals/p-1',
  '/targets',
  '/settings',
  '/holdings/h-1',
  '/no-such-page',
])('renders the bar once at %s', async (path) => {
  renderAt(path);
  expect(await screen.findAllByRole('navigation', { name: 'Main' })).toHaveLength(1);
  expect(screen.getAllByRole('banner').filter((header) => header.querySelector('nav'))).toHaveLength(1);
});

it('marks the current place, and keeps it marked below it', async () => {
  renderAt('/agents/a-1');
  const nav = await screen.findByRole('navigation', { name: 'Main' });
  expect(within(nav).getByRole('link', { name: 'Agents' }).getAttribute('aria-current')).toBe('page');
  expect(within(nav).getByRole('link', { name: 'Topics' }).getAttribute('aria-current')).toBeNull();
  expect(within(nav).getByRole('link', { name: 'Portfolio' }).getAttribute('aria-current')).toBeNull();
});

it('opens the menu, ends it with Sign out, and closes it with Escape back onto its button', async () => {
  renderAt('/');
  const button = await screen.findByRole('button', { name: 'Menu' });
  expect(button.getAttribute('aria-expanded')).toBe('false');

  fireEvent.click(button);
  expect(button.getAttribute('aria-expanded')).toBe('true');
  const panel = document.getElementById(button.getAttribute('aria-controls')!)!;
  const items = within(panel).getAllByRole('listitem');
  expect(within(items.at(-1)!).getByRole('button', { name: 'Sign out' })).toBeTruthy();
  expect(within(panel).getByRole('link', { name: 'Settings' })).toBeTruthy();
  expect(within(panel).queryByRole('link', { name: 'Admin' })).toBeNull();

  fireEvent.keyDown(document, { key: 'Escape' });
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(button);
});

it('closes the menu when one of its links is followed', async () => {
  const { router } = renderAt('/');
  const button = await screen.findByRole('button', { name: 'Menu' });
  fireEvent.click(button);
  const panel = document.getElementById(button.getAttribute('aria-controls')!)!;

  fireEvent.click(within(panel).getByRole('link', { name: 'Topics' }));
  await vi.waitFor(() => expect(router.state.location.pathname).toBe('/topics'));
  expect(button.getAttribute('aria-expanded')).toBe('false');
});
