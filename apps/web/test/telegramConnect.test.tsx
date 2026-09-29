// @vitest-environment jsdom
/** The Telegram card, rendered from the binding the server reports. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';

const get = vi.fn();

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
    api: { get, post: vi.fn(), postForm: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    ApiRequestError,
    errorMessage: (error: unknown, fallback: string) =>
      error instanceof ApiRequestError ? error.message : fallback,
  };
});

const { ApiRequestError } = await import('../src/api/client.ts');
const { TelegramConnect } = await import('../src/components/TelegramConnect.tsx');
const { renderWithServerState } = await import('./serverStateHarness.tsx');

describe('TelegramConnect', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('says which chat is connected', async () => {
    get.mockResolvedValue({ connected: true, username: 'someone', boundAt: '2026-09-17T10:00:00Z' });
    renderWithServerState(<TelegramConnect />);
    expect(await screen.findByText(/Connected as @someone/)).toBeTruthy();
    expect(get).toHaveBeenCalledWith('/telegram/binding');
  });

  it('offers to connect when no chat is', async () => {
    get.mockResolvedValue({ connected: false, username: null, boundAt: null });
    renderWithServerState(<TelegramConnect />);
    expect(await screen.findByRole('button', { name: 'Connect Telegram' })).toBeTruthy();
  });

  it('reports a failed check rather than offering to connect a chat that may be connected', async () => {
    get.mockRejectedValue(new ApiRequestError('Cannot reach the server.', 0, 'network_error'));
    renderWithServerState(<TelegramConnect />);
    expect(await screen.findByText('Cannot reach the server.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect Telegram' })).toBeNull();
  });
});
