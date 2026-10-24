// @vitest-environment jsdom
/**
 * Signed-in devices (D261, D296): Settings' card in each of its states, and a
 * session that ends while the app is open taking the app back to sign-in with
 * a sentence saying why.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, configure, fireEvent, screen, waitFor } from '@testing-library/react';

import type { SessionDevice } from '@traders/shared';

configure({ asyncUtilTimeout: 5_000 });

const get = vi.fn();
const post = vi.fn();
const remove = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>('../src/api/client.ts');
  return { ...actual, api: { get, post, put: vi.fn(), patch: vi.fn(), delete: remove, postForm: vi.fn() } };
});

const { ApiRequestError, UNAUTHORIZED } = await import('../src/api/client.ts');
const { reportSessionEnded } = await import('../src/api/sessionEnded.ts');
const { DevicesCard } = await import('../src/components/DevicesCard.tsx');
const { LoginPage } = await import('../src/pages/LoginPage.tsx');
const { RootStore } = await import('../src/stores/RootStore.ts');
const { renderWithServerState, testQueryClient } = await import('./serverStateHarness.tsx');
const { applyLanguage } = await import('../src/i18n/index.ts');

const THIS: SessionDevice = {
  id: 'this-session',
  browser: 'Microsoft Edge',
  os: 'Windows',
  deviceType: 'desktop',
  signedInAt: '2026-10-20T08:00:00Z',
  lastSeenAt: new Date().toISOString(),
  expiresAt: '2026-10-27T08:00:00Z',
  ipAddress: '203.0.113.7',
  current: true,
};

const PHONE: SessionDevice = {
  ...THIS,
  id: 'phone-session',
  browser: 'Safari',
  os: 'iOS',
  deviceType: 'mobile',
  ipAddress: null,
  current: false,
};

const UNKNOWN: SessionDevice = { ...PHONE, id: 'unknown-session', browser: null, os: null, deviceType: null };

/** A device's name as the card writes it: each product name isolated (FSI..PDI). */
const named = (browser: string, os: string) => `\u2068${browser}\u2069 on \u2068${os}\u2069`;

function serve(sessions: SessionDevice[]) {
  get.mockImplementation((path: string) =>
    path === '/account/sessions' ? Promise.resolve({ sessions }) : new Promise(() => {}),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  cleanup();
  await act(() => applyLanguage('en'));
});

describe("Settings' signed-in devices", () => {
  it('says it is loading until the list arrives', () => {
    get.mockImplementation(() => new Promise(() => {}));
    renderWithServerState(<DevicesCard />);
    expect(screen.getByRole('status').textContent).toContain('Loading devices…');
  });

  it('shows only this device, with no sign-out of its own and nothing to sign out', async () => {
    serve([THIS]);
    renderWithServerState(<DevicesCard />);
    expect(await screen.findByText(named('Microsoft Edge', 'Windows'))).toBeTruthy();
    expect(screen.getByText('This device')).toBeTruthy();
    expect(screen.getByText('No other device is signed in.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out all other devices' })).toBeNull();
  });

  it('names a device it cannot read as unknown', async () => {
    serve([THIS, UNKNOWN]);
    renderWithServerState(<DevicesCard />);
    expect(await screen.findByText(named('Unknown browser', 'unknown system'))).toBeTruthy();
  });

  it('signs one other device out and reads the list again', async () => {
    serve([THIS, PHONE]);
    remove.mockResolvedValue(undefined);
    renderWithServerState(<DevicesCard />);
    await screen.findByText(named('Safari', 'iOS'));
    serve([THIS]);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('/account/sessions/phone-session'));
    await waitFor(() => expect(screen.queryByText(named('Safari', 'iOS'))).toBeNull());
  });

  it('signs out every other device at once, and says how many', async () => {
    serve([THIS, PHONE, UNKNOWN]);
    post.mockResolvedValue({ ended: 2 });
    renderWithServerState(<DevicesCard />);
    await screen.findByText(named('Safari', 'iOS'));
    serve([THIS]);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out all other devices' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/account/sessions/sign-out-others'));
    expect(await screen.findByText('Signed out 2 other devices.')).toBeTruthy();
    expect(await screen.findByText('No other device is signed in.')).toBeTruthy();
  });

  it('says a sign-out failed and keeps the row', async () => {
    serve([THIS, PHONE]);
    remove.mockRejectedValue(new Error('offline'));
    renderWithServerState(<DevicesCard />);
    await screen.findByText(named('Safari', 'iOS'));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('Could not sign that device out.')).toBeTruthy();
    expect(screen.getByText(named('Safari', 'iOS'))).toBeTruthy();
  });

  it('says the list could not be read, and reads it again on request', async () => {
    get.mockRejectedValueOnce(new Error('offline'));
    renderWithServerState(<DevicesCard />);
    expect(await screen.findByText('Could not load the signed-in devices.')).toBeTruthy();
    serve([THIS]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(named('Microsoft Edge', 'Windows'))).toBeTruthy();
  });

  it('is in Hebrew in Hebrew, keeping the product names in their order', async () => {
    serve([THIS, PHONE]);
    renderWithServerState(<DevicesCard />);
    await act(() => applyLanguage('he'));
    expect(await screen.findByText('\u2068Safari\u2069 ב-\u2068iOS\u2069')).toBeTruthy();
    expect(screen.getByText('המכשיר הזה')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'ניתוק כל שאר המכשירים' })).toBeTruthy();
  });
});

describe('a session that ends while the app is open (D261)', () => {
  function signedIn() {
    const root = new RootStore(testQueryClient());
    act(() => {
      root.auth.user = { id: 'u', baseCurrency: 'USD', timezone: 'Asia/Jerusalem', language: 'en' } as never;
      root.auth.initialised = true;
    });
    return root;
  }

  it('signs this device out, as signing out does, and the sign-in page says why', async () => {
    const root = signedIn();
    const clear = vi.spyOn(root.queryClient, 'clear');
    act(() => reportSessionEnded());
    expect(root.auth.user).toBeNull();
    expect(clear).toHaveBeenCalled();
    renderWithServerState(<LoginPage />, root);
    expect(screen.getByRole('status').textContent).toContain('You were signed out on this device');
  });

  it("is reported by the client for a 401 'unauthorized', and only for that", async () => {
    vi.doUnmock('../src/api/client.ts');
    vi.resetModules();
    const listener = vi.fn();
    const { onSessionEnded } = await import('../src/api/sessionEnded.ts');
    const { api } = await import('../src/api/client.ts');
    onSessionEnded(listener);
    const answer = (status: number, error: string) =>
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ error, message: 'm' }), { status }));
    answer(403, 'password_change_required');
    await expect(api.get('/settings')).rejects.toBeInstanceOf(Error);
    expect(listener).not.toHaveBeenCalled();
    answer(401, UNAUTHORIZED);
    await expect(api.get('/settings')).rejects.toBeInstanceOf(Error);
    expect(listener).toHaveBeenCalledOnce();
    onSessionEnded(null);
    vi.restoreAllMocks();
  });

  it('means nothing while signed out: a wrong password is the same refusal', () => {
    const root = new RootStore(testQueryClient());
    act(() => reportSessionEnded());
    expect(root.auth.sessionEndedNotice).toBe(false);
  });

  it('clears the notice once the user signs in again', async () => {
    const root = signedIn();
    act(() => reportSessionEnded());
    post.mockResolvedValue({ id: 'u', baseCurrency: 'USD', timezone: 'Asia/Jerusalem', language: 'en' });
    await act(() => root.auth.login('dana@example.com', 'a password here'));
    expect(root.auth.sessionEndedNotice).toBe(false);
  });

  it('keeps a refused sign-in as a refusal, not a session that ended', async () => {
    const root = new RootStore(testQueryClient());
    post.mockRejectedValue(new ApiRequestError('incorrect', 401, UNAUTHORIZED));
    await act(() => root.auth.login('dana@example.com', 'wrong'));
    expect(root.auth.sessionEndedNotice).toBe(false);
    expect(root.auth.error).toBe('That email and password do not match an account.');
  });
});
