// @vitest-environment jsdom
/**
 * Signing in with an email and password (D159), the one-time password screen
 * (D162) and changing one's own password (D181): what is sent, and how each
 * refusal reads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { runInAction } from 'mobx';

import type { SessionUser } from '@traders/shared';

const post = vi.fn();
// The app behind the one-time screen loads its pages; they wait forever here.
const get = vi.fn(() => new Promise(() => {}));

vi.mock('../src/api/client.ts', () => {
  class ApiRequestError extends Error {
    constructor(
      message: string,
      readonly status = 500,
      readonly code = 'error',
    ) {
      super(message);
    }
  }
  return {
    api: { get, post, postForm: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    ApiRequestError,
    errorMessage: (error: unknown, fallback: string) =>
      error instanceof ApiRequestError ? error.message : fallback,
  };
});

const { ApiRequestError } = await import('../src/api/client.ts');
const { App } = await import('../src/App.tsx');
const { LoginPage } = await import('../src/pages/LoginPage.tsx');
const { EmailChange } = await import('../src/components/EmailChange.tsx');
const { PasswordChange } = await import('../src/components/PasswordChange.tsx');
const { renderWithServerState, testQueryClient } = await import('./serverStateHarness.tsx');
const { RootStore } = await import('../src/stores/RootStore.ts');

const USER: SessionUser = {
  id: 'u',
  email: 'dana@example.com',
  baseCurrency: 'USD',
  timezone: 'UTC',
  role: 'user',
  language: 'en',
  mustChangePassword: false,
};

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('the sign-in page', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('sends the email, trimmed, and the password as typed', async () => {
    post.mockResolvedValue(USER);
    const { root } = renderWithServerState(<LoginPage />);
    type('Email', '  dana@example.com ');
    type('Password', ' secret with spaces ');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(root.auth.user).toEqual(USER));
    expect(post).toHaveBeenCalledWith('/auth/login', {
      email: 'dana@example.com',
      password: ' secret with spaces ',
    });
  });

  it('says the email and password do not match, without the server\'s English', async () => {
    post.mockRejectedValue(new ApiRequestError('incorrect email or password', 401, 'unauthorized'));
    renderWithServerState(<LoginPage />);
    type('Email', 'dana@example.com');
    type('Password', 'wrong');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('That email and password do not match an account.')).toBeTruthy();
  });

  it('says an account that is not active is not active', async () => {
    post.mockRejectedValue(new ApiRequestError('this account is disabled', 403, 'account_not_active'));
    renderWithServerState(<LoginPage />);
    type('Email', 'dana@example.com');
    type('Password', 'right');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/This account is not active/)).toBeTruthy();
  });
});

describe('asking to join (D156, D185, D187)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  function openSignup() {
    renderWithServerState(<LoginPage />);
    fireEvent.click(screen.getByRole('button', { name: 'New here? Ask to join' }));
  }

  function fill(email: string, password: string, repeat = password) {
    type('Email', email);
    type('Password', password);
    type('Password, again', repeat);
    fireEvent.click(screen.getByRole('button', { name: 'Ask to join' }));
  }

  it("sends the email, the password, this browser's zone and the page's language", async () => {
    post.mockResolvedValue({ outcome: 'received' });
    openSignup();
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(screen.getByText(zone)).toBeTruthy();
    fill(' noa@example.com ', 'a long enough passphrase');
    expect(await screen.findByText('Request received')).toBeTruthy();
    expect(screen.getByText(/You can sign in once they approve/)).toBeTruthy();
    expect(post).toHaveBeenCalledWith('/auth/signup', {
      email: 'noa@example.com',
      password: 'a long enough passphrase',
      timezone: zone,
      language: 'en',
    });
  });

  it('says sign-up is closed when the server does', async () => {
    post.mockResolvedValue({ outcome: 'closed' });
    openSignup();
    fill('noa@example.com', 'a long enough passphrase');
    expect(await screen.findByText('Sign-up is closed right now')).toBeTruthy();
  });

  it('refuses a short password, two that differ, or no address, before asking the server', async () => {
    openSignup();
    fill('noa@example.com', 'short');
    expect(await screen.findByText('The new password needs at least 12 characters.')).toBeTruthy();
    fill('noa@example.com', 'a long enough passphrase', 'another long passphrase');
    expect(await screen.findByText('The two passwords are different.')).toBeTruthy();
    fill('Noa Levi', 'a long enough passphrase');
    expect(await screen.findByText('That is not an email address.')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it('goes back to signing in', () => {
    openSignup();
    fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  it('tells someone still waiting that their request is waiting', async () => {
    post.mockRejectedValue(new ApiRequestError('waiting', 403, 'account_pending'));
    renderWithServerState(<LoginPage />);
    type('Email', 'noa@example.com');
    type('Password', 'a long enough passphrase');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText("Your request is waiting for the admin's approval.")).toBeTruthy();
  });
});

describe('changing the email', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  function fill(email: string, password: string) {
    type('New email', email);
    type('Current password', password);
    fireEvent.click(screen.getByRole('button', { name: 'Change email' }));
  }

  function renderSignedIn() {
    const root = new RootStore(testQueryClient());
    runInAction(() => {
      root.auth.user = USER;
    });
    return renderWithServerState(<EmailChange />, root);
  }

  it('shows the current address, and refuses one that is not an address before asking the server', async () => {
    renderSignedIn();
    expect(screen.getByText('dana@example.com')).toBeTruthy();
    fill('Dana Levi', 'current password');
    expect(await screen.findByText('That is not an email address.')).toBeTruthy();
    fill(' DANA@example.com', 'current password');
    expect(await screen.findByText('That is already your email.')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it('sends the normalised address and the password, and shows the new one', async () => {
    post.mockResolvedValue({ ...USER, email: 'dana.levi@example.com' });
    const { root } = renderSignedIn();
    fill('  Dana.Levi@Example.com ', 'current password');
    expect(await screen.findByText(/Email changed/)).toBeTruthy();
    expect(post).toHaveBeenCalledWith('/auth/email', {
      email: 'dana.levi@example.com',
      currentPassword: 'current password',
    });
    expect(root.auth.user?.email).toBe('dana.levi@example.com');
    expect(screen.getByText('dana.levi@example.com')).toBeTruthy();
  });

  it.each([
    ['incorrect_password', 403, 'The current password is not right.'],
    ['email_taken', 409, 'Another account already uses this address.'],
  ])('says %s in the reader\'s words', async (code, status, sentence) => {
    post.mockRejectedValue(new ApiRequestError('refused', status, code));
    renderSignedIn();
    fill('new@example.com', 'current password');
    expect(await screen.findByText(sentence)).toBeTruthy();
  });
});

describe('the one-time password', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('shows nothing but the password change, and the app once it is changed', async () => {
    // jsdom has no layout; the router restores scroll once the app appears.
    window.scrollTo = () => {};
    const root = new RootStore(testQueryClient());
    runInAction(() => {
      root.auth.initialised = true;
      root.auth.user = { ...USER, mustChangePassword: true };
    });
    renderWithServerState(<App />, root);
    expect(await screen.findByRole('heading', { name: 'Choose a new password' })).toBeTruthy();

    post.mockResolvedValue(USER);
    type('Current password', 'one-time-password');
    type('New password', 'a long new password');
    type('New password, again', 'a long new password');
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Choose a new password' })).toBeNull());
    expect(post).toHaveBeenCalledWith('/auth/password', {
      currentPassword: 'one-time-password',
      newPassword: 'a long new password',
    });
  });
});

describe('changing a password', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  function fill(current: string, next: string, repeat = next) {
    type('Current password', current);
    type('New password', next);
    type('New password, again', repeat);
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
  }

  it('refuses a short password and two different ones before asking the server', async () => {
    renderWithServerState(<PasswordChange />);
    fill('current password', 'short');
    expect(await screen.findByText('The new password needs at least 12 characters.')).toBeTruthy();
    fill('current password', 'a long new password', 'a different one, also long');
    expect(await screen.findByText('The two new passwords are different.')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it('says the current password is wrong when the server says so', async () => {
    post.mockRejectedValue(new ApiRequestError('the current password is incorrect', 403, 'incorrect_password'));
    renderWithServerState(<PasswordChange />);
    fill('not it', 'a long new password');
    expect(await screen.findByText('The current password is not right.')).toBeTruthy();
  });
});
