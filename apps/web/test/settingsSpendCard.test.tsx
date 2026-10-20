// @vitest-environment jsdom
/**
 * The Settings card for the monthly LLM cap (D157, D158): a capped user reads
 * their month; the admin, who has no cap, sees no card.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';

import type { MonthlySpendResponse, OwnLlmKeyResponse, UserSettingsResponse } from '@traders/shared';

const get = vi.fn();
const put = vi.fn();
const remove = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>('../src/api/client.ts');
  return { ...actual, api: { get, post: vi.fn(), put, delete: remove, postForm: vi.fn() } };
});

const { App } = await import('../src/App.tsx');
const { ApiRequestError } = await import('../src/api/client.ts');
const { createAppRouter } = await import('../src/router.tsx');
const { renderWithServerState } = await import('./serverStateHarness.tsx');

const SETTINGS: UserSettingsResponse = {
  settings: {
    proposalSeverity: 'high',
    proposalTtlHours: 24,
    notifySeverity: 'high',
    quietHoursStart: null,
    quietHoursEnd: null,
    mutedUntil: null,
    language: 'en',
  },
};

const NO_KEY: OwnLlmKeyResponse = { available: true, key: null };
const KEY = 'sk-or-v1-test-not-a-real-key-c0de';
const SAVED_KEY = {
  lastFour: 'c0de',
  status: 'valid' as const,
  savedAt: '2026-10-20T12:00:00Z',
  failedAt: null,
  failure: null,
};

function serve(spend: MonthlySpendResponse, ownKey: OwnLlmKeyResponse = NO_KEY) {
  get.mockImplementation((path: string) =>
    path === '/settings'
      ? Promise.resolve(SETTINGS)
      : path === '/settings/llm-spend'
        ? Promise.resolve(spend)
        : path === '/settings/llm-key'
          ? Promise.resolve(ownKey)
          : new Promise(() => {}),
  );
}

const MONTH = { capMicroUsd: 5_000_000, spentMicroUsd: 280_462, ownKeySpentMicroUsd: 0, resetsOn: '2026-11-01' };

function renderSettings() {
  const router = createAppRouter(createMemoryHistory({ initialEntries: ['/settings'] }));
  const result = renderWithServerState(<App router={router} />);
  act(() => {
    result.root.auth.user = { id: 'u', baseCurrency: 'USD', timezone: 'Asia/Jerusalem' } as never;
    result.root.auth.initialised = true;
  });
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.scrollTo = () => {};
});
afterEach(cleanup);

describe('the monthly spend card', () => {
  it("shows a capped user's month: spent, cap and the reset date", async () => {
    serve({ spend: MONTH });
    renderSettings();

    expect(await screen.findByText('Model spending')).toBeTruthy();
    expect(screen.getByText('This month: $0.2805 of $5.00, resets on 1 November 2026.')).toBeTruthy();
  });

  it('is absent for a user without a cap', async () => {
    serve({ spend: null });
    renderSettings();

    expect(await screen.findByText('Language')).toBeTruthy();
    await waitFor(() => expect(get).toHaveBeenCalledWith('/settings/llm-spend'));
    expect(screen.queryByText('Model spending')).toBeNull();
    // The admin is refused the key routes; the page does not ask.
    expect(get).not.toHaveBeenCalledWith('/settings/llm-key');
  });
});

describe("the user's own OpenRouter key (D206)", () => {
  it('says the cap does not apply while a working key is saved, and what the key spent', async () => {
    serve({ spend: { ...MONTH, ownKeySpentMicroUsd: 1_500_000 } }, { available: true, key: SAVED_KEY });
    renderSettings();

    expect(await screen.findByText(/Your own OpenRouter key pays for your model calls/)).toBeTruthy();
    expect(screen.queryByText(/This month: /)).toBeNull();
    expect(screen.getByText(/On your own key this month: \$1\.50/)).toBeTruthy();
    expect(screen.getByText(/Key ending c0de/)).toBeTruthy();
  });

  it('saves a key, sends it once, and empties the field', async () => {
    serve({ spend: MONTH });
    put.mockResolvedValueOnce({ available: true, key: SAVED_KEY });
    renderSettings();

    const field = (await screen.findByLabelText('API key')) as HTMLInputElement;
    expect(field.type).toBe('password');
    fireEvent.change(field, { target: { value: ` ${KEY} ` } });
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));

    await waitFor(() => expect(put).toHaveBeenCalledWith('/settings/llm-key', { apiKey: KEY }));
    expect(field.value).toBe('');
  });

  it("says why a key was not saved, by the server's code", async () => {
    serve({ spend: MONTH });
    put.mockRejectedValueOnce(new ApiRequestError('OpenRouter refused this key', 422, 'key_rejected'));
    renderSettings();

    fireEvent.change(await screen.findByLabelText('API key'), { target: { value: KEY } });
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));

    expect(await screen.findByText("OpenRouter didn't accept that key. Check it and try again.")).toBeTruthy();
  });

  it('explains a key OpenRouter refused since, and that the cap applies again', async () => {
    serve(
      { spend: MONTH },
      {
        available: true,
        key: { ...SAVED_KEY, status: 'failed', failure: 'no_credit', failedAt: '2026-10-21T08:00:00Z' },
      },
    );
    renderSettings();

    expect(await screen.findByText(/Your OpenRouter account ran out of credit/)).toBeTruthy();
    expect(screen.getByText('This month: $0.2805 of $5.00, resets on 1 November 2026.')).toBeTruthy();
  });

  it('offers no form where the installation cannot use own keys', async () => {
    serve({ spend: MONTH }, { available: false, key: null });
    renderSettings();

    expect(await screen.findByText("This installation isn't set up to use your own key.")).toBeTruthy();
    expect(screen.queryByLabelText('API key')).toBeNull();
  });
});
