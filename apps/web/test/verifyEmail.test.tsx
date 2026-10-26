// @vitest-environment jsdom
/**
 * Email verification in the web (D259, D301): the page a mailed link opens,
 * and a sign-in to an address never confirmed, with its new link.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, configure, fireEvent, screen, waitFor } from '@testing-library/react';

configure({ asyncUtilTimeout: 5_000 });

const get = vi.fn();
const post = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>('../src/api/client.ts');
  return { ...actual, api: { get, post, put: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() } };
});

const { ApiRequestError, RATE_LIMITED } = await import('../src/api/client.ts');
const { EMAIL_UNVERIFIED } = await import('../src/stores/AuthStore.ts');
const { VerifyPage } = await import('../src/pages/VerifyPage.tsx');
const { LoginPage } = await import('../src/pages/LoginPage.tsx');
const { renderWithServerState } = await import('./serverStateHarness.tsx');
const { applyLanguage } = await import('../src/i18n/index.ts');

function openLink(hash: string) {
  window.history.replaceState(null, '', `/verify${hash}`);
  return renderWithServerState(<VerifyPage />);
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue({ authenticated: false });
});

afterEach(async () => {
  cleanup();
  window.history.replaceState(null, '', '/');
  await act(() => applyLanguage('en'));
});

describe('the page a verification link opens', () => {
  it.each([
    ['activated', 'Email confirmed', /Your account is ready/],
    ['awaiting_approval', 'Email confirmed', /with the installation's admin/],
    ['email_changed', 'New address confirmed', /Every other device was signed out/],
    ['email_taken', 'Address already in use', /has not changed/],
    ['expired', 'This link has expired', /get a new one/],
    ['used', 'This link was already used', /Nothing more to do/],
    ['invalid', 'This link does not work', /newer link replaced it/],
  ] as const)('says %s', async (outcome, title, body) => {
    post.mockResolvedValue({ outcome });
    openLink('#token=the-token');
    expect(await screen.findByText(title)).toBeTruthy();
    expect(screen.getByText(body)).toBeTruthy();
    expect(post).toHaveBeenCalledWith('/auth/verify', { token: 'the-token' });
  });

  it('posts the token once, and clears it from the address bar at once', async () => {
    post.mockResolvedValue({ outcome: 'activated' });
    openLink('#token=the-token');
    await screen.findByText('Email confirmed');
    expect(post).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/verify');
  });

  it('calls a link with no token invalid without asking the server', async () => {
    openLink('');
    expect(await screen.findByText('This link does not work')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it('says it is checking until the server answers', () => {
    post.mockImplementation(() => new Promise(() => {}));
    openLink('#token=the-token');
    expect(screen.getByRole('status').textContent).toContain('Checking the link');
  });

  it('says the link could not be checked, and checks it again on request - with the same token', async () => {
    post.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ outcome: 'activated' });
    openLink('#token=the-token');
    expect(await screen.findByText(/Could not check the link/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Email confirmed')).toBeTruthy();
    expect(post).toHaveBeenLastCalledWith('/auth/verify', { token: 'the-token' });
  });

  it('is in Hebrew in Hebrew', async () => {
    post.mockResolvedValue({ outcome: 'expired' });
    openLink('#token=the-token');
    await act(() => applyLanguage('he'));
    expect(await screen.findByText('תוקף הקישור פג')).toBeTruthy();
  });
});

describe('signing in before the address is confirmed (D301)', () => {
  async function signIn() {
    const result = renderWithServerState(<LoginPage />);
    const [email] = screen.getAllByRole('textbox');
    fireEvent.change(email!, { target: { value: 'noa@example.com' } });
    fireEvent.change(document.querySelector('input[type="password"]')!, { target: { value: 'a long enough passphrase' } });
    post.mockRejectedValueOnce(new ApiRequestError('confirm your email address first', 403, EMAIL_UNVERIFIED));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    });
    return result;
  }

  it('says to confirm the email first, at the address typed, and sends a new link with the same email and password', async () => {
    await signIn();
    expect(await screen.findByText(/Confirm your email first/)).toBeTruthy();
    expect(screen.getByText('noa@example.com')).toBeTruthy();
    post.mockResolvedValueOnce({ sent: true });
    fireEvent.click(screen.getByRole('button', { name: 'Send the link again' }));
    expect(await screen.findByText(/Sent\. Check your inbox/)).toBeTruthy();
    expect(post).toHaveBeenLastCalledWith('/auth/verify/resend', {
      email: 'noa@example.com',
      password: 'a long enough passphrase',
    });
  });

  it('says a new link could not be sent, in the rate limit\'s own words when that is why', async () => {
    await signIn();
    post.mockRejectedValueOnce(new ApiRequestError('Too many attempts - try again in 1 minute.', 429, RATE_LIMITED));
    fireEvent.click(await screen.findByRole('button', { name: 'Send the link again' }));
    expect(await screen.findByText('Too many attempts - try again in 1 minute.')).toBeTruthy();
    post.mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Send the link again' }));
    await waitFor(() => expect(screen.getByText(/Could not send the link/)).toBeTruthy());
  });
});
