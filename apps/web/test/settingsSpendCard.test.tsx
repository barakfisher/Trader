// @vitest-environment jsdom
/**
 * The Settings card for the monthly LLM cap (D157, D158): a capped user reads
 * their month; the admin, who has no cap, sees no card.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';

import type { MonthlySpendResponse, UserSettingsResponse } from '@traders/shared';

const get = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>('../src/api/client.ts');
  return { ...actual, api: { get, post: vi.fn(), put: vi.fn(), delete: vi.fn(), postForm: vi.fn() } };
});

const { App } = await import('../src/App.tsx');
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

function serve(spend: MonthlySpendResponse) {
  get.mockImplementation((path: string) =>
    path === '/settings'
      ? Promise.resolve(SETTINGS)
      : path === '/settings/llm-spend'
        ? Promise.resolve(spend)
        : new Promise(() => {}),
  );
}

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
    serve({ spend: { capMicroUsd: 5_000_000, spentMicroUsd: 280_462, resetsOn: '2026-11-01' } });
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
  });
});
