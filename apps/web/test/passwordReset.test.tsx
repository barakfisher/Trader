// @vitest-environment jsdom
/**
 * A forgotten password in the web (D260, D312): asking for a link from the
 * sign-in page, and the page the link opens.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, configure, fireEvent, screen } from '@testing-library/react';

configure({ asyncUtilTimeout: 5_000 });

const get = vi.fn();
const post = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>('../src/api/client.ts');
  return { ...actual, api: { get, post, put: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() } };
});

const { ApiRequestError } = await import('../src/api/client.ts');
const { ResetPage } = await import('../src/pages/ResetPage.tsx');
const { LoginPage } = await import('../src/pages/LoginPage.tsx');
const { renderWithServerState } = await import('./serverStateHarness.tsx');
const { applyLanguage } = await import('../src/i18n/index.ts');

const NEW_PASSWORD = 'a brand new passphrase';

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue({ authenticated: false });
});

afterEach(async () => {
  cleanup();
  window.history.replaceState(null, '', '/');
  await act(() => applyLanguage('en'));
});

describe('asking for a reset link from the sign-in page', () => {
  async function openForm() {
    renderWithServerState(<LoginPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Forgot your password?' }));
  }

  it('sends the typed address and answers the same whatever it is', async () => {
    post.mockResolvedValue({ sent: true });
    await openForm();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: ' noa@example.com ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send the link' }));
    expect(await screen.findByText(/If an account uses that address/)).toBeTruthy();
    expect(post).toHaveBeenCalledWith('/auth/reset/request', { email: 'noa@example.com' });
  });

  it('refuses an address the rule refuses without asking the server', async () => {
    await openForm();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'not an address' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send the link' }));
    expect(post).not.toHaveBeenCalled();
  });

  it('says when the installation cannot send mail, and what to do instead', async () => {
    post.mockRejectedValue(new ApiRequestError('this installation cannot send mail', 503, 'email_unavailable'));
    await openForm();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'noa@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send the link' }));
    expect(await screen.findByText(/Ask its admin to set a one-time password/)).toBeTruthy();
  });
});

describe('the page a reset link opens', () => {
  function openLink(hash: string) {
    window.history.replaceState(null, '', `/reset${hash}`);
    return renderWithServerState(<ResetPage />);
  }

  function choose(password: string, repeat = password) {
    const [first, second] = Array.from(document.querySelectorAll('input[type="password"]'));
    fireEvent.change(first!, { target: { value: password } });
    fireEvent.change(second!, { target: { value: repeat } });
    fireEvent.click(screen.getByRole('button', { name: 'Save the new password' }));
  }

  it('sends nothing on opening, clears the token at once, and sets the password on save', async () => {
    post.mockResolvedValue({ outcome: 'reset' });
    openLink('#token=the-token');
    expect(await screen.findByText('Choose a new password')).toBeTruthy();
    expect(window.location.hash).toBe('');
    expect(post).not.toHaveBeenCalled();
    choose(NEW_PASSWORD);
    expect(await screen.findByText('Password changed')).toBeTruthy();
    expect(post).toHaveBeenCalledWith('/auth/reset', { token: 'the-token', newPassword: NEW_PASSWORD });
  });

  it('checks the two passwords match before sending', async () => {
    openLink('#token=the-token');
    await screen.findByText('Choose a new password');
    choose(NEW_PASSWORD, 'something else entirely');
    expect(await screen.findByText(/different/)).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    ['expired', 'This link has expired'],
    ['used', 'This link was already used'],
    ['invalid', 'This link does not work'],
  ] as const)('says %s', async (outcome, title) => {
    post.mockResolvedValue({ outcome });
    openLink('#token=the-token');
    await screen.findByText('Choose a new password');
    choose(NEW_PASSWORD);
    expect(await screen.findByText(title)).toBeTruthy();
  });

  it('calls a link with no token invalid without asking the server', async () => {
    openLink('');
    expect(await screen.findByText('This link does not work')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it('is in Hebrew in Hebrew', async () => {
    openLink('#token=the-token');
    await act(() => applyLanguage('he'));
    expect(await screen.findByText('בחירת סיסמה חדשה')).toBeTruthy();
  });
});
