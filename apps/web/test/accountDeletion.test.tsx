// @vitest-environment jsdom
/**
 * Deleting the account and exporting its data in the web (D264): the Settings
 * card for a password account, one that signs in only through a provider, and
 * the admin; the screen that says when the account goes; the banner after a
 * sign-in that cancelled a deletion, by password and through a provider; and
 * the export's download. The network is the mocked `api`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, configure, fireEvent, screen, waitFor } from '@testing-library/react';

import {
  ACCOUNT_DELETION_CONFIRMATION,
  ACCOUNT_DELETION_GRACE_DAYS,
  type AccountDeletionCheck,
  type SessionUser,
} from '@traders/shared';

configure({ asyncUtilTimeout: 5_000 });

const get = vi.fn();
const post = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>('../src/api/client.ts');
  return { ...actual, api: { get, post, put: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() } };
});

const { ApiRequestError } = await import('../src/api/client.ts');
const { AccountDeletionCard } = await import('../src/components/AccountDeletionCard.tsx');
const { AccountExportCard } = await import('../src/components/AccountExportCard.tsx');
const { DeletionCancelledBanner } = await import('../src/components/DeletionCancelledBanner.tsx');
const { App } = await import('../src/App.tsx');
const { RootStore } = await import('../src/stores/RootStore.ts');
const { renderWithServerState, testQueryClient } = await import('./serverStateHarness.tsx');
const { applyLanguage } = await import('../src/i18n/index.ts');

const USER: SessionUser = {
  id: 'u1',
  email: 'dana@example.com',
  baseCurrency: 'USD',
  timezone: 'Asia/Jerusalem',
  role: 'user',
  language: 'en',
  mustChangePassword: false,
  pendingEmail: null,
  legalAcceptanceRequired: null,
};

const WITH_PASSWORD: AccountDeletionCheck = {
  confirmWith: 'password',
  recentSignIn: false,
  recentSignInMinutes: 10,
  allowed: true,
  graceDays: ACCOUNT_DELETION_GRACE_DAYS,
};

const DUE = '2026-11-02T10:00:00.000Z';

function serve(check: AccountDeletionCheck) {
  get.mockImplementation(async (path: string) => {
    if (path === '/account/deletion') return check;
    if (path === '/auth/session') return { authenticated: true, user: USER };
    throw new Error(`unexpected GET ${path}`);
  });
}

/** A store signed in as USER. */
function signedIn() {
  const root = new RootStore(testQueryClient());
  root.auth.user = USER;
  root.auth.initialised = true;
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  cleanup();
  window.history.replaceState(null, '', '/');
  await act(() => applyLanguage('en'));
});

describe('the Settings card (D264)', () => {
  it('says what closes now, what goes later and when, and asks for the word and the password', async () => {
    serve(WITH_PASSWORD);
    renderWithServerState(<AccountDeletionCard />, signedIn());
    expect(await screen.findByText(new RegExp(`permanently deleted ${ACCOUNT_DELETION_GRACE_DAYS} days later`))).toBeTruthy();
    expect(screen.getByText(/backups keep a deleted account for up to 56 days/)).toBeTruthy();
    const submit = screen.getByRole('button', { name: 'Delete my account' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(`Type ${ACCOUNT_DELETION_CONFIRMATION} to confirm`), {
      target: { value: ACCOUNT_DELETION_CONFIRMATION },
    });
    // The word alone is not enough while the account has a password.
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'my password' } });
    expect(submit.disabled).toBe(false);
  });

  it('closes the account and shows when it will be deleted, in place of the sign-in page', async () => {
    serve(WITH_PASSWORD);
    post.mockResolvedValue({ deletionDueAt: DUE });
    const root = signedIn();
    renderWithServerState(<AccountDeletionCard />, root);
    fireEvent.change(await screen.findByLabelText(`Type ${ACCOUNT_DELETION_CONFIRMATION} to confirm`), {
      target: { value: ACCOUNT_DELETION_CONFIRMATION },
    });
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'my password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));
    await waitFor(() => expect(root.auth.user).toBeNull());
    expect(post).toHaveBeenCalledWith('/account/deletion', { confirm: ACCOUNT_DELETION_CONFIRMATION, password: 'my password' });

    cleanup();
    renderWithServerState(<App />, root);
    expect(screen.getByText('Your account is closed')).toBeTruthy();
    // In the account's own zone: 10:00 UTC is 12:00 in Jerusalem in November.
    expect(screen.getByText(/permanently deleted on 2 November 2026 at 12:00/)).toBeTruthy();
    expect(screen.getByText(/Signing in before then restores it/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Go to sign in' }));
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  it('says so when the password is wrong, and keeps the account', async () => {
    serve(WITH_PASSWORD);
    post.mockRejectedValue(new ApiRequestError('the current password is incorrect', 403, 'incorrect_password'));
    const root = signedIn();
    renderWithServerState(<AccountDeletionCard />, root);
    fireEvent.change(await screen.findByLabelText(`Type ${ACCOUNT_DELETION_CONFIRMATION} to confirm`), {
      target: { value: ACCOUNT_DELETION_CONFIRMATION },
    });
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));
    expect(await screen.findByText("That is not this account's password.")).toBeTruthy();
    expect(root.auth.user).toEqual(USER);
    expect(root.auth.closed).toBeNull();
  });

  it('asks an account with no password to sign in again, and accepts a sign-in moments ago', async () => {
    serve({ ...WITH_PASSWORD, confirmWith: 'recent_sign_in', recentSignIn: false });
    renderWithServerState(<AccountDeletionCard />, signedIn());
    expect(await screen.findByText(/confirm by signing in again: sign out, sign in, and delete within 10 minutes/)).toBeTruthy();
    expect(screen.queryByLabelText('Your password')).toBeNull();
    fireEvent.change(screen.getByLabelText(`Type ${ACCOUNT_DELETION_CONFIRMATION} to confirm`), {
      target: { value: ACCOUNT_DELETION_CONFIRMATION },
    });
    expect((screen.getByRole('button', { name: 'Delete my account' }) as HTMLButtonElement).disabled).toBe(true);

    cleanup();
    serve({ ...WITH_PASSWORD, confirmWith: 'recent_sign_in', recentSignIn: true });
    renderWithServerState(<AccountDeletionCard />, signedIn());
    expect(await screen.findByText(/You signed in a moment ago/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(`Type ${ACCOUNT_DELETION_CONFIRMATION} to confirm`), {
      target: { value: ACCOUNT_DELETION_CONFIRMATION },
    });
    expect((screen.getByRole('button', { name: 'Delete my account' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("offers the admin no button, and says why", async () => {
    serve({ ...WITH_PASSWORD, allowed: false });
    renderWithServerState(<AccountDeletionCard />, signedIn());
    expect(await screen.findByText(/admin account cannot be deleted from Settings/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete my account' })).toBeNull();
  });

  it("keeps the closed screen in the account's language after the session ends", async () => {
    serve(WITH_PASSWORD);
    post.mockResolvedValue({ deletionDueAt: DUE });
    const root = signedIn();
    await act(async () => {
      root.auth.user = { ...USER, language: 'he' };
    });
    await act(() => root.auth.deleteAccount({ confirm: ACCOUNT_DELETION_CONFIRMATION, password: 'p' }));
    renderWithServerState(<App />, root);
    expect(await screen.findByText('החשבון שלכם סגור')).toBeTruthy();
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('writes Hebrew with its own plural and the word left to right', async () => {
    serve(WITH_PASSWORD);
    // The signed-in user's language is the page's (`AuthStore` follows it).
    const root = signedIn();
    await act(async () => {
      root.auth.user = { ...USER, language: 'he' };
      await applyLanguage('he');
    });
    renderWithServerState(<AccountDeletionCard />, root);
    expect(await screen.findByText(new RegExp(`אחרי ${ACCOUNT_DELETION_GRACE_DAYS} ימים`))).toBeTruthy();
    expect(screen.getByText(new RegExp(`⁨${ACCOUNT_DELETION_CONFIRMATION}⁩`))).toBeTruthy();
  });
});

describe('the sign-in that cancelled a deletion (D264)', () => {
  it('says so once after a password sign-in, and goes when dismissed', async () => {
    post.mockResolvedValue({ ...USER, deletionCancelled: true });
    const root = new RootStore(testQueryClient());
    await root.auth.login('dana@example.com', 'my password');
    renderWithServerState(<DeletionCancelledBanner />, root);
    expect(screen.getByText(/Signing in cancelled your account's deletion/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText(/Signing in cancelled/)).toBeNull();
  });

  it('says nothing after an ordinary sign-in', async () => {
    post.mockResolvedValue({ ...USER, deletionCancelled: false });
    const root = new RootStore(testQueryClient());
    await root.auth.login('dana@example.com', 'my password');
    expect(root.auth.user).toEqual(USER);
    renderWithServerState(<DeletionCancelledBanner />, root);
    expect(screen.queryByText(/Signing in cancelled/)).toBeNull();
  });

  it("says so after Google or GitHub came back with 'restored', and leaves other outcomes in the address", async () => {
    window.history.replaceState(null, '', '/?oauth=restored');
    renderWithServerState(<DeletionCancelledBanner />, signedIn());
    expect(await screen.findByText(/Signing in cancelled your account's deletion/)).toBeTruthy();
    expect(window.location.search).toBe('');

    cleanup();
    window.history.replaceState(null, '', '/settings?oauth=linked');
    renderWithServerState(<DeletionCancelledBanner />, signedIn());
    expect(screen.queryByText(/Signing in cancelled/)).toBeNull();
    expect(window.location.search).toBe('?oauth=linked');
  });
});

describe('the export (D264)', () => {
  it('downloads the file the server names, as it came', async () => {
    const body = '{"holdings": [{"quantity": "0.123456789012345678"}]}';
    const fetchMock = vi.fn(async () =>
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="traders-export-2026-10-26.json"' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const created: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob);
      return 'blob:export';
    });
    URL.revokeObjectURL = vi.fn();
    const clicked: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    });
    try {
      renderWithServerState(<AccountExportCard />, signedIn());
      fireEvent.click(screen.getByRole('button', { name: 'Download my data' }));
      await waitFor(() => expect(clicked).toEqual(['traders-export-2026-10-26.json']));
      expect(fetchMock).toHaveBeenCalledWith('/api/account/export', { credentials: 'include' });
      expect(await created[0]!.text()).toBe(body);
    } finally {
      click.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('says when to try again when the limit is spent, in the reader\'s language (D257)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'rate_limited', message: 'rate limited' }), {
            status: 429,
            headers: { 'retry-after': '120' },
          }),
      ),
    );
    try {
      renderWithServerState(<AccountExportCard />, signedIn());
      fireEvent.click(screen.getByRole('button', { name: 'Download my data' }));
      expect(await screen.findByText(/2 minutes/)).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
