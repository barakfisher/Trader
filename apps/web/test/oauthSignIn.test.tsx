// @vitest-environment jsdom
/** Sign-in through Google and GitHub in the web (D262, D263): the buttons, the outcome, and Settings. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, configure, fireEvent, screen } from '@testing-library/react';

configure({ asyncUtilTimeout: 5_000 });

const get = vi.fn();
const del = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>('../src/api/client.ts');
  return { ...actual, api: { get, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: del, postForm: vi.fn() } };
});

const { ApiRequestError } = await import('../src/api/client.ts');
const { LoginPage } = await import('../src/pages/LoginPage.tsx');
const { LinkedProviders } = await import('../src/components/OAuthSignIn.tsx');
const { renderWithServerState } = await import('./serverStateHarness.tsx');
const { applyLanguage } = await import('../src/i18n/index.ts');

function serve(routes: Record<string, unknown>) {
  get.mockImplementation(async (path: string) => {
    if (path in routes) return routes[path];
    if (path === '/auth/session') return { authenticated: false };
    throw new Error(`unexpected GET ${path}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  cleanup();
  window.history.replaceState(null, '', '/');
  await act(() => applyLanguage('en'));
});

describe('the sign-in page', () => {
  it('offers each configured provider, leaving for its start with this page as the origin', async () => {
    serve({ '/auth/oauth/providers': { providers: ['google', 'github'] } });
    renderWithServerState(<LoginPage />);
    const google = (await screen.findByRole('link', { name: 'Continue with Google' })) as HTMLAnchorElement;
    const url = new URL(google.href);
    expect(url.pathname).toBe('/api/auth/oauth/google/start');
    expect(url.searchParams.get('origin')).toBe(window.location.origin);
    expect(url.searchParams.get('intent')).toBe('signin');
    expect(screen.getByRole('link', { name: 'Continue with GitHub' })).toBeTruthy();
  });

  it('offers nothing where no provider is configured', async () => {
    serve({ '/auth/oauth/providers': { providers: [] } });
    renderWithServerState(<LoginPage />);
    await screen.findByRole('button', { name: 'Sign in' });
    expect(screen.queryByText(/Continue with/)).toBeNull();
  });

  it("says where the provider's sign-in ended, once, and takes it out of the address bar", async () => {
    serve({ '/auth/oauth/providers': { providers: ['google'] } });
    window.history.replaceState(null, '', '/?oauth=unverified_email');
    renderWithServerState(<LoginPage />);
    expect(await screen.findByText(/not verified with the provider/)).toBeTruthy();
    expect(window.location.search).toBe('');
  });

  it("tells a member to link from Settings without calling the account the admin's", async () => {
    serve({ '/auth/oauth/providers': { providers: ['google'] } });
    window.history.replaceState(null, '', '/?oauth=link_from_settings');
    renderWithServerState(<LoginPage />);
    const notice = await screen.findByText(/already has an account/);
    expect(notice.textContent).not.toMatch(/admin/i);
  });

  it('tells the admin that the admin account links from Settings (D314)', async () => {
    serve({ '/auth/oauth/providers': { providers: ['google'] } });
    window.history.replaceState(null, '', '/?oauth=admin_link_from_settings');
    renderWithServerState(<LoginPage />);
    expect(await screen.findByText(/belongs to the admin account/)).toBeTruthy();
  });

  it('reads an outcome it does not know as a failure, never as anything else', async () => {
    serve({ '/auth/oauth/providers': { providers: [] } });
    window.history.replaceState(null, '', '/?oauth=<script>');
    renderWithServerState(<LoginPage />);
    expect(await screen.findByText(/did not work/)).toBeTruthy();
  });
});

describe('Settings: sign in with (D263)', () => {
  it('lists linked providers with Unlink, and offered ones with Link', async () => {
    serve({
      '/auth/identities': {
        identities: [{ provider: 'google', email: 'noa@example.com', linkedAt: '2026-10-26T10:00:00Z' }],
        available: ['google', 'github'],
      },
    });
    renderWithServerState(<LinkedProviders />);
    expect(await screen.findByText('noa@example.com')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unlink' })).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Link' }) as HTMLAnchorElement;
    expect(new URL(link.href).pathname).toBe('/api/auth/oauth/github/start');
    expect(new URL(link.href).searchParams.get('intent')).toBe('link');
  });

  it("says why the account's only way in cannot be unlinked", async () => {
    serve({
      '/auth/identities': { identities: [{ provider: 'google', email: null, linkedAt: '2026-10-26T10:00:00Z' }], available: ['google'] },
    });
    del.mockRejectedValue(new ApiRequestError('set a password or link another provider before unlinking this one', 409, 'last_sign_in_method'));
    renderWithServerState(<LinkedProviders />);
    fireEvent.click(await screen.findByRole('button', { name: 'Unlink' }));
    expect(await screen.findByText(/needs a password or another linked provider/)).toBeTruthy();
  });
});
