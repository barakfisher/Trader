/**
 * Connecting a Telegram chat from the settings page.
 *
 * The link this mints is a bearer credential: whoever opens it binds *their*
 * chat to this account and can then answer proposals. So the properties worth
 * pinning are about its handling rather than its rendering - it is never
 * persisted, it is minted fresh rather than cached, and an installation with no
 * bot is told so instead of being shown an error it cannot act on.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const postForm = vi.fn();
const patch = vi.fn();
const put = vi.fn();
const del = vi.fn();

vi.mock('../src/api/client.ts', () => ({
  api: { get, post, postForm, patch, put, delete: del },
  ApiRequestError: class ApiRequestError extends Error {
    constructor(
      message: string,
      readonly status = 500,
      readonly code = 'error',
    ) {
      super(message);
    }
  },
}));

const { RootStore } = await import('../src/stores/RootStore.ts');
const { ApiRequestError } = await import('../src/api/client.ts');

const LINK = { url: 'https://t.me/bot?start=tok', expiresAt: '2026-09-17T18:00:00.000Z' };

describe('TelegramStore', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports a chat that is connected, and one that is not', async () => {
    const root = new RootStore();
    get.mockResolvedValueOnce({ connected: true, username: 'someone', boundAt: '2026-09-17T10:00:00Z' });
    await root.telegram.load();
    expect(root.telegram.connected).toBe(true);

    const other = new RootStore();
    get.mockResolvedValueOnce({ connected: false, username: null, boundAt: null });
    await other.telegram.load();
    expect(other.telegram.connected).toBe(false);
  });

  it('mints a fresh link every time rather than reusing one', async () => {
    // The token carries its own expiry. A cached link stops verifying silently,
    // which is a worse experience than paying for a signature again.
    const root = new RootStore();
    post.mockResolvedValue(LINK);
    await root.telegram.connect();
    await root.telegram.connect();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('keeps the link in memory only', async () => {
    const root = new RootStore();
    post.mockResolvedValueOnce(LINK);
    await root.telegram.connect();
    expect(root.telegram.link).toEqual(LINK);
    // Signing out must not leave a credential behind for whoever is next.
    root.telegram.reset();
    expect(root.telegram.link).toBeNull();
  });

  it('says an installation has no bot rather than showing an error', async () => {
    // A 503 here is not something the reader did or can fix, and an error note
    // inviting them to retry would be a lie about what retrying would achieve.
    const root = new RootStore();
    post.mockRejectedValueOnce(new ApiRequestError('no bot', 503, 'telegram_not_configured'));
    await root.telegram.connect();
    expect(root.telegram.unavailable).toBe(true);
    expect(root.telegram.error).toBeNull();
  });

  it('surfaces a real failure as an error the reader can retry', async () => {
    const root = new RootStore();
    post.mockRejectedValueOnce(new ApiRequestError('Cannot reach the server.', 0, 'network_error'));
    await root.telegram.connect();
    expect(root.telegram.unavailable).toBe(false);
    expect(root.telegram.error).toBe('Cannot reach the server.');
  });
});
