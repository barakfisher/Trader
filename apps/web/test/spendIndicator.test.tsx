// @vitest-environment jsdom
/**
 * The top bar's spend indicator and the daily reminder (D246-D250, D281): an
 * *Add key* chip with no key, the ratio against the binding limit, a popover a tap
 * opens, the warning, a reminder dismissed for the day - and nothing for the admin.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, configure, fireEvent, screen, waitFor } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';

import { SPEND_WARNING_DAYS, type KeySpend } from '@traders/shared';

configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 15_000 });

const get = vi.fn();

/** "$used / $limit" as the indicator writes it: each amount in a bidi isolate (ratioText). */
function ratio(used: string, limit: string): string {
  const iso = '[\\u2066-\\u2069]*';
  return `${iso}\\$${used.replace('.', '\\.')}${iso} \\/ ${iso}${limit.startsWith('Unlimited') ? limit : `\\$${limit.replace('.', '\\.')}`}${iso}`;
}

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>('../src/api/client.ts');
  return { ...actual, api: { get, post: vi.fn(), put: vi.fn(), delete: vi.fn(), postForm: vi.fn() } };
});

const { App } = await import('../src/App.tsx');
const { createAppRouter } = await import('../src/router.tsx');
const { renderWithServerState } = await import('./serverStateHarness.tsx');

const DOLLAR = 1_000_000;
const WORKING: KeySpend = {
  key: 'valid',
  failure: null,
  reading: { usedMicroUsd: 12 * DOLLAR, limitMicroUsd: 50 * DOLLAR, period: 'month', readAt: '2026-10-22T11:55:00Z' },
  safetyLimit: null,
  binding: 'key',
  dailyPaceMicroUsd: 2 * DOLLAR,
  daysLeft: 19,
  warning: false,
};

function serve(spend: KeySpend | null) {
  get.mockImplementation((path: string) =>
    path === '/settings/llm-usage' ? Promise.resolve({ spend }) : new Promise(() => {}),
  );
}

function renderAt(path: string, role: 'user' | 'admin' = 'user') {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  const result = renderWithServerState(<App router={router} />);
  act(() => {
    result.root.auth.user = { id: 'u', baseCurrency: 'USD', timezone: 'Asia/Jerusalem', role } as never;
    result.root.auth.initialised = true;
  });
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.scrollTo = () => {};
  window.localStorage.clear();
});
afterEach(cleanup);

describe('the spend indicator', () => {
  it('asks a user with no key to add one', async () => {
    serve({ ...WORKING, key: 'none', reading: null, binding: null, dailyPaceMicroUsd: null, daysLeft: null });
    renderAt('/topics');
    const chip = await screen.findByRole('link', { name: /Add key/ });
    expect(chip.getAttribute('href')).toBe('/settings');
  });

  it('shows the ratio, and a tap opens the pace and the days left', async () => {
    serve(WORKING);
    renderAt('/topics');
    const chip = await screen.findByRole('button', { name: new RegExp(`Spend on your OpenRouter key: ${ratio('12.00', '50.00')}`) });
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(chip);
    expect(await screen.findByText(/This week's pace on this key: \$2\.00 a day/)).toBeTruthy();
    expect(screen.getByText('About 19 days left at this pace.')).toBeTruthy();
    expect(screen.getByText(new RegExp(`On this key: ${ratio('12.00', '50.00')} this month`))).toBeTruthy();
  });

  it('says Unlimited for a key without a limit, and projects nothing', async () => {
    serve({
      ...WORKING,
      reading: { ...WORKING.reading!, limitMicroUsd: null },
      binding: null,
      daysLeft: null,
    });
    renderAt('/topics');
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(ratio('12.00', 'Unlimited')) }));
    expect(await screen.findByText(/No limit on this key, so nothing is projected/)).toBeTruthy();
  });

  it('is absent for the admin, who is never asked about', async () => {
    serve(WORKING);
    renderAt('/topics', 'admin');
    await screen.findByRole('link', { name: /Portfolio/ });
    expect(get).not.toHaveBeenCalledWith('/settings/llm-usage');
    expect(screen.queryByRole('button', { name: /Spend on your OpenRouter key/ })).toBeNull();
  });
});

describe('the daily reminder (D246)', () => {
  const WARNING: KeySpend = { ...WORKING, daysLeft: SPEND_WARNING_DAYS - 2, warning: true };

  it('shows when the warning starts, and stays dismissed for the day', async () => {
    serve(WARNING);
    const first = renderAt('/topics');
    expect(await screen.findByText(/about 3 days of spend left at this week's pace/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss for today' }));
    await waitFor(() => expect(screen.queryByText(/days of spend left/)).toBeNull());
    first.unmount();

    serve(WARNING);
    renderAt('/topics');
    await screen.findByRole('button', { name: /Spend on your OpenRouter key/ });
    expect(screen.queryByText(/days of spend left/)).toBeNull();
  });

  it('names the safety limit when that is what binds', async () => {
    serve({
      ...WARNING,
      binding: 'safety',
      safetyLimit: { limitMicroUsd: 20 * DOLLAR, spentMicroUsd: 14 * DOLLAR, resetsOn: '2026-11-01' },
    });
    renderAt('/topics');
    expect(await screen.findByText(/Your safety limit will be reached in about 3 days/)).toBeTruthy();
    expect(screen.getByRole('button', { name: new RegExp(ratio('14.00', '20.00')) })).toBeTruthy();
  });

  it('is not shown without a warning', async () => {
    serve(WORKING);
    renderAt('/topics');
    await screen.findByRole('button', { name: /Spend on your OpenRouter key/ });
    expect(screen.queryByText(/days of spend left/)).toBeNull();
  });
});
