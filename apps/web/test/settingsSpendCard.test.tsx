// @vitest-environment jsdom
/**
 * The Settings cards for a user's own OpenRouter key and their own-key month
 * (D206, D245, D250): the key every model call of theirs runs on, what this app
 * spent on it, and the optional monthly safety limit. The admin, on the
 * installation's key, sees neither.
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

const MONTH = { ownKeySpentMicroUsd: 280_462, safetyLimitMicroUsd: null, resetsOn: '2026-11-01' };

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

describe('the own-key month and the safety limit (D250)', () => {
  it("shows what this app spent on the user's key, with no limit set", async () => {
    serve({ spend: MONTH }, { available: true, key: SAVED_KEY });
    renderSettings();

    expect(await screen.findByText('Model spending')).toBeTruthy();
    expect(screen.getByText(/On your own key this month: \$0\.2805/)).toBeTruthy();
    expect(screen.queryByText(/of your .* limit/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove limit' })).toBeNull();
  });

  it('shows a limit against the month, and says when it is reached', async () => {
    serve({ spend: { ...MONTH, safetyLimitMicroUsd: 20_000_000 } }, { available: true, key: SAVED_KEY });
    const { unmount } = renderSettings();
    expect(await screen.findByText('This month: $0.2805 of your $20.00 limit; it resets on 1 November 2026.')).toBeTruthy();
    unmount();

    serve({ spend: { ...MONTH, ownKeySpentMicroUsd: 20_000_000, safetyLimitMicroUsd: 20_000_000 } }, { available: true, key: SAVED_KEY });
    renderSettings();
    expect(await screen.findByText(/^Reached: \$20\.00 of your \$20\.00 limit this month/)).toBeTruthy();
  });

  it('saves a limit in dollars and cents as micro-USD, and removes it with null', async () => {
    serve({ spend: { ...MONTH, safetyLimitMicroUsd: 5_000_000 } }, { available: true, key: SAVED_KEY });
    put.mockResolvedValue({ limitMicroUsd: 12_340_000 });
    renderSettings();

    const field = (await screen.findByLabelText('Limit per month (USD)')) as HTMLInputElement;
    expect(field.value).toBe('5.00');
    fireEvent.change(field, { target: { value: '12.34' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limit' }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/settings/llm-safety-limit', { limitMicroUsd: 12_340_000 }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove limit' }));
    await waitFor(() => expect(put).toHaveBeenLastCalledWith('/settings/llm-safety-limit', { limitMicroUsd: null }));
  });

  it('will not save a limit it cannot send', async () => {
    serve({ spend: MONTH }, { available: true, key: SAVED_KEY });
    renderSettings();

    const field = await screen.findByLabelText('Limit per month (USD)');
    for (const wrong of ['0', '0.00', '1.234', 'ten', '1000.01']) {
      fireEvent.change(field, { target: { value: wrong } });
      expect((screen.getByRole('button', { name: 'Save limit' }) as HTMLButtonElement).disabled, wrong).toBe(true);
    }
  });

  it('is absent for the admin, who runs on the installation key', async () => {
    serve({ spend: null });
    renderSettings();

    expect(await screen.findByText('Language')).toBeTruthy();
    await waitFor(() => expect(get).toHaveBeenCalledWith('/settings/llm-spend'));
    expect(screen.queryByText('Model spending')).toBeNull();
    // The admin is refused the key routes; the page does not ask.
    expect(get).not.toHaveBeenCalledWith('/settings/llm-key');
  });
});

describe("the user's own OpenRouter key (D206, D245)", () => {
  it('says scans and questions cannot run with no key saved, and promises no fallback', async () => {
    serve({ spend: MONTH });
    renderSettings();

    expect(await screen.findByText(/No key is saved, so scans and questions can't run/)).toBeTruthy();
    expect(screen.queryByText(/installation's account/)).toBeNull();
    expect(screen.queryByText(/monthly limit\./)).toBeNull();
  });

  it('shows a working key and points to both limits on its spend', async () => {
    serve({ spend: { ...MONTH, ownKeySpentMicroUsd: 1_500_000 } }, { available: true, key: SAVED_KEY });
    renderSettings();

    expect(await screen.findByText(/Key ending c0de/)).toBeTruthy();
    expect(screen.getByText(/On your own key this month: \$1\.50/)).toBeTruthy();
    // D211, D250: OpenRouter's limit on the key, or the app's safety limit.
    expect(screen.getByText(/set a credit limit on the key in your OpenRouter account, or a monthly safety limit/)).toBeTruthy();
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

  it('explains a key OpenRouter refused since, and that work is stopped until it is saved again', async () => {
    serve(
      { spend: MONTH },
      {
        available: true,
        key: { ...SAVED_KEY, status: 'failed', failure: 'no_credit', failedAt: '2026-10-21T08:00:00Z' },
      },
    );
    renderSettings();

    expect(
      await screen.findByText(/has no credit left: your account ran out, or the key reached the credit limit/),
    ).toBeTruthy();
    expect(screen.getByText(/Scans and questions are stopped until you add credit/)).toBeTruthy();
    expect(screen.queryByText(/installation's account/)).toBeNull();
  });

  it('offers no form where the installation cannot use own keys', async () => {
    serve({ spend: MONTH }, { available: false, key: null });
    renderSettings();

    expect(await screen.findByText("This installation isn't set up to use your own key.")).toBeTruthy();
    expect(screen.queryByLabelText('API key')).toBeNull();
  });
});
