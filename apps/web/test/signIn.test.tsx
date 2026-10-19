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
const { PasswordChange } = await import('../src/components/PasswordChange.tsx');
const { renderWithServerState, testQueryClient } = await import('./serverStateHarness.tsx');
const { RootStore } = await import('../src/stores/RootStore.ts');

const USER: SessionUser = {
  id: 'u',
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
