// @vitest-environment jsdom
/**
 * Every view has an address: a reload or a link lands on it, the header's
 * links go to it, and signing out returns to the top.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';

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

const USER = { id: 'u', baseCurrency: 'USD', timezone: 'Asia/Jerusalem' };

/** The app at `path`, signed in unless told otherwise. Reads never answer: this is about addresses. */
function renderAt(path: string, { signedIn = true } = {}) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  const result = renderWithServerState(<App router={router} />);
  act(() => {
    result.root.auth.user = signedIn ? (USER as never) : null;
    result.root.auth.initialised = true;
  });
  return { ...result, router };
}

describe('page addresses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    get.mockReturnValue(new Promise(() => {}));
    // jsdom has no layout; the router restores scroll on navigation.
    window.scrollTo = () => {};
  });
  afterEach(cleanup);

  it('renders the view at its address, so a reload stays where it was', async () => {
    renderAt('/settings');
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy();
  });

  it('goes to a view through a real link', async () => {
    const { router } = renderAt('/');
    const topics = await screen.findByRole('link', { name: /Topics/ });
    expect(topics.getAttribute('href')).toBe('/topics');

    fireEvent.click(topics);
    expect(await screen.findByRole('heading', { name: 'Topics' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/topics');
  });

  it('treats an unknown address as the portfolio', async () => {
    renderAt('/no-such-page');
    expect(await screen.findByRole('heading', { name: 'Portfolio' })).toBeTruthy();
  });

  it('keeps the address through sign-in, and lands on the view that was asked for', async () => {
    const { root, router } = renderAt('/settings', { signedIn: false });
    expect(screen.getByRole('heading', { name: 'Traders' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/settings');

    act(() => {
      root.auth.user = USER as never;
    });
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy();
  });

  it('signs out to the sign-in screen, at the top', async () => {
    const { router } = renderAt('/?from=somewhere');
    post.mockResolvedValue(undefined);

    fireEvent.click(await screen.findByRole('button', { name: 'Account' }));
    fireEvent.click(screen.getByRole('button', { name: /Sign out/ }));
    await vi.waitFor(() => expect(screen.getByRole('heading', { name: 'Traders' })).toBeTruthy());
    expect(router.state.location.pathname).toBe('/');
  });
});
