// @vitest-environment jsdom
/** The Admin page's tabs (M10 decision 20) and its Keys card (D251, D288): status, never values. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

import type { InstallationKeysView } from '@traders/shared';

const get = vi.fn();
const post = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>('../src/api/client.ts');
  return { ...actual, api: { get, post, put: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() } };
});

const { AdminKeysCard } = await import('../src/components/AdminKeysCard.tsx');
const { ADMIN_TABS, adminTabFrom } = await import('../src/pages/AdminPage.tsx');
const { renderPage } = await import('./serverStateHarness.tsx');

const KEYS: InstallationKeysView = {
  keys: [
    {
      name: 'OPENROUTER_API_KEY',
      provider: 'OpenRouter',
      isSet: true,
      serves: ['llm', 'embeddings'],
      unused: null,
      testable: true,
      lastError: { at: '2026-10-22T09:00:00Z', message: 'HTTP 429: rate limited' },
    },
    { name: 'POLYGON_API_KEY', provider: 'Polygon', isSet: true, serves: [], unused: 'no_adapter', testable: false, lastError: null },
    { name: 'TELEGRAM_BOT_TOKEN', provider: 'Telegram', isSet: false, serves: [], unused: null, testable: false, lastError: null },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  get.mockImplementation(async (path: string) => (path === '/admin/keys' ? KEYS : new Promise(() => {})));
  post.mockResolvedValue({ ok: false, detail: 'HTTP 401: invalid', checkedAt: '2026-10-23T12:00:00Z' });
});
afterEach(cleanup);

describe('the tab in the address', () => {
  it('opens the tab a link names, and Users for anything else', () => {
    for (const tab of ADMIN_TABS) expect(adminTabFrom({ tab })).toBe(tab);
    expect(adminTabFrom({ tab: 'nonsense' })).toBe('users');
    expect(adminTabFrom(undefined)).toBe('users');
  });
});

describe('the Keys card', () => {
  it('says what each key does here, including one nothing uses and one not set', async () => {
    renderPage(<AdminKeysCard />);
    await screen.findByText('OpenRouter');
    expect(screen.getByText(/Set, in use · serves model calls, search embeddings/)).toBeTruthy();
    expect(screen.getByText('Set, but nothing in this installation uses it')).toBeTruthy();
    expect(screen.getByText('Not set')).toBeTruthy();
    expect(screen.getByText('HTTP 429: rate limited')).toBeTruthy();
  });

  it('offers a test only where one exists, and says what the provider answered', async () => {
    renderPage(<AdminKeysCard />);
    await screen.findByText('OpenRouter');
    expect(screen.getAllByRole('button', { name: /^Test the/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Test the OpenRouter key' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/keys/OPENROUTER_API_KEY/test', {}));
    expect(await screen.findByText(/The provider refused the key/)).toBeTruthy();
  });
});
