// @vitest-environment jsdom
/**
 * The privacy policy and terms in the web (D265): the text the build ships,
 * the two pages signed out and in either language, the acceptance an account
 * must give before anything else, and the box sign-up asks for. The network
 * is the mocked `api`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';

import {
  LEGAL_DOCUMENTS,
  LEGAL_TEXT_PENDING_MARKER,
  LEGAL_VERSION,
  LEGAL_VERSION_PATTERN,
  UI_LANGUAGES,
  writtenLanguage,
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
const { App } = await import('../src/App.tsx');
const { SignupForm } = await import('../src/components/SignupForm.tsx');
const { RootStore } = await import('../src/stores/RootStore.ts');
const { legalSource, legalText } = await import('../src/legal/legalText.ts');
const { renderWithServerState, testQueryClient } = await import('./serverStateHarness.tsx');
const { applyLanguage } = await import('../src/i18n/index.ts');

const VERSION = '2026-11-01';

const USER: SessionUser = {
  id: 'u1',
  email: 'dana@example.com',
  baseCurrency: 'USD',
  timezone: 'Asia/Jerusalem',
  role: 'user',
  language: 'en',
  mustChangePassword: false,
  pendingEmail: null,
  legalAcceptanceRequired: VERSION,
};

function store(user: SessionUser | null) {
  const root = new RootStore(testQueryClient());
  root.auth.user = user;
  root.auth.initialised = true;
  return root;
}

function openAt(path: string, user: SessionUser | null = null) {
  window.history.replaceState(null, '', path);
  const root = store(user);
  renderWithServerState(<App />, root);
  return root;
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

describe('the text this build ships', () => {
  it.each(UI_LANGUAGES.flatMap((language) => LEGAL_DOCUMENTS.map((document) => [language, document] as const)))(
    'has its own %s %s file, pending exactly while no version is set',
    (language, document) => {
      const source = legalSource(language, document);
      expect(source, 'one file per document and language, never a fallback').toBeTruthy();
      expect(source!.includes(LEGAL_TEXT_PENDING_MARKER)).toBe(LEGAL_VERSION === null);
      // Each language's file is written in it: the Hebrew is its own text, not the English.
      expect(writtenLanguage(legalText(language, document))).toBe(language);
    },
  );
});

it('names a real publication date as its version, once there is one', () => {
  if (LEGAL_VERSION === null) return;
  expect(LEGAL_VERSION).toMatch(LEGAL_VERSION_PATTERN);
  expect(new Date(`${LEGAL_VERSION}T00:00:00Z`).toISOString().slice(0, 10)).toBe(LEGAL_VERSION);
});

describe('the pages, signed out (D265)', () => {
  it('opens the privacy policy before any sign-in, with the terms a link away', async () => {
    openAt('/privacy');
    expect(screen.getByRole('heading', { level: 1, name: 'Privacy policy' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Terms of use' }).getAttribute('href')).toBe('/terms?lang=en');
    expect(screen.getByRole('link', { name: 'Privacy policy' }).getAttribute('aria-current')).toBe('page');
    // The marker is for the build's check, never the reader.
    expect(document.body.innerHTML).not.toContain('legal-text-pending');
  });

  it("switches to the other language's own text, marked with its language and direction", async () => {
    openAt('/terms');
    fireEvent.click(screen.getByRole('button', { name: 'עברית' }));
    const article = screen.getByRole('article');
    expect(article.getAttribute('lang')).toBe('he');
    expect(article.getAttribute('dir')).toBe('rtl');
    expect(within(article).getByRole('heading', { level: 1, name: 'תנאי שימוש' })).toBeTruthy();
    // The other document keeps the choice.
    expect(screen.getByRole('link', { name: 'Privacy policy' }).getAttribute('href')).toBe('/privacy?lang=he');
  });

  it('opens in the language a link asked for', async () => {
    openAt('/privacy?lang=he');
    expect(screen.getByRole('article').getAttribute('lang')).toBe('he');
  });

  it("opens in the interface's language: Hebrew for a Hebrew account", async () => {
    openAt('/privacy', { ...USER, language: 'he' });
    expect(screen.getByRole('article').getAttribute('lang')).toBe('he');
    expect(screen.getByRole('link', { name: 'חזרה לאפליקציה' })).toBeTruthy();
  });

  it('opens signed in as well, before the acceptance asks for anything', async () => {
    openAt('/terms', USER);
    expect(screen.getByRole('heading', { level: 1, name: 'Terms of use' })).toBeTruthy();
  });

  it('is linked from the sign-in page', async () => {
    openAt('/');
    expect(screen.getByRole('link', { name: 'Privacy policy' }).getAttribute('href')).toBe('/privacy');
    expect(screen.getByRole('link', { name: 'Terms of use' }).getAttribute('href')).toBe('/terms');
  });
});

describe('an account that has not accepted the current version', () => {
  it('sees nothing but the acceptance, with both documents to read', async () => {
    openAt('/', USER);
    expect(screen.getByText('Before you continue')).toBeTruthy();
    // The date read whole, left to right, whatever the sentence around it.
    const version = screen.getByText(VERSION);
    expect(version.tagName).toBe('BDI');
    expect(version.getAttribute('dir')).toBe('ltr');
    for (const name of ['Privacy policy', 'Terms of use']) {
      expect(screen.getByRole('link', { name }).getAttribute('target')).toBe('_blank');
    }
    expect(screen.queryByRole('navigation', { name: /main/i })).toBeNull();
  });

  it('accepts the version it was shown, and the app takes its place', async () => {
    post.mockResolvedValue({ ...USER, legalAcceptanceRequired: null });
    // The dashboard that follows reads nothing here: its panels show their errors.
    get.mockRejectedValue(new ApiRequestError('offline', 0, 'network_error'));
    const root = openAt('/', USER);
    fireEvent.click(screen.getByRole('button', { name: 'I have read them and accept' }));
    await waitFor(() => expect(root.auth.user?.legalAcceptanceRequired).toBeNull());
    expect(post).toHaveBeenCalledWith('/auth/legal/accept', { version: VERSION });
    expect(screen.queryByText('Before you continue')).toBeNull();
  });

  it('says so when a newer version replaced it while the page was open', async () => {
    post.mockRejectedValue(new ApiRequestError('stale', 409, 'legal_version_stale'));
    openAt('/', USER);
    fireEvent.click(screen.getByRole('button', { name: 'I have read them and accept' }));
    expect(await screen.findByText(/A newer version was published/)).toBeTruthy();
  });

  it('can sign out instead', async () => {
    post.mockResolvedValue({ ok: true });
    const root = openAt('/', USER);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(root.auth.user).toBeNull());
    expect(post).toHaveBeenCalledWith('/auth/logout');
  });

  it('is asked again when the server refuses a request for a version published while the app was open', async () => {
    const root = store({ ...USER, legalAcceptanceRequired: null });
    get.mockResolvedValue({ authenticated: true, user: USER });
    const { reportLegalAcceptanceRequired } = await import('../src/api/sessionEnded.ts');
    reportLegalAcceptanceRequired();
    await waitFor(() => expect(root.auth.user?.legalAcceptanceRequired).toBe(VERSION));
    expect(get).toHaveBeenCalledWith('/auth/session');
  });
});

describe('signing up (D265)', () => {
  const fill = () => {
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'noa@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a long enough passphrase' } });
    fireEvent.change(screen.getByLabelText('Password, again'), { target: { value: 'a long enough passphrase' } });
  };

  it('asks for the box once a version exists, and sends the version it agreed to', async () => {
    post.mockResolvedValue({ outcome: 'received' });
    renderWithServerState(<SignupForm onBack={() => undefined} legalVersion={VERSION} />, store(null));
    fill();
    const submit = screen.getByRole('button', { name: 'Ask to join' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const box = screen.getByRole('checkbox', { name: /I have read and accept the privacy policy and the terms of use/ });
    expect(screen.getByRole('link', { name: 'privacy policy' }).getAttribute('href')).toBe('/privacy');
    fireEvent.click(box);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/auth/signup', expect.objectContaining({ acceptedLegalVersion: VERSION })),
    );
  });

  it('asks for nothing while the text is pending', async () => {
    post.mockResolvedValue({ outcome: 'received' });
    renderWithServerState(<SignupForm onBack={() => undefined} legalVersion={null} />, store(null));
    fill();
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ask to join' }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0]![1]).not.toHaveProperty('acceptedLegalVersion');
  });
});
