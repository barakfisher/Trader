// @vitest-environment jsdom
/**
 * The admin page: linked from the dashboard for an admin only, and a
 * non-admin who reaches its address is told so without a request being made.
 * The server's refusal is what protects the data (orchestrator
 * `adminGuard.test.ts`); these are about not offering a door that is locked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';

const get = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>(
    '../src/api/client.ts',
  );
  return {
    ...actual,
    api: { get, post: vi.fn(), put: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  };
});

const { App } = await import('../src/App.tsx');
const { createAppRouter } = await import('../src/router.tsx');
const { renderWithServerState } = await import('./serverStateHarness.tsx');
const { duration } = await import('../src/pages/AdminPage.tsx');

const ADMIN = { id: 'u', baseCurrency: 'USD', timezone: 'Asia/Jerusalem', role: 'admin' };
const USER = { ...ADMIN, role: 'user' };

function renderAt(path: string, user: typeof ADMIN) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  const result = renderWithServerState(<App router={router} />);
  act(() => {
    result.root.auth.user = user as never;
    result.root.auth.initialised = true;
  });
  return result;
}

describe('the admin page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    get.mockImplementation((path: string) =>
      path === '/admin/runs'
        ? Promise.resolve({
            runs: [
              {
                id: 'r1',
                userId: null,
                kind: 'backfill',
                runKey: 'backfill:k8s:2026-09-30',
                trigger: 'cron',
                status: 'ok',
                startedAt: '2026-09-30T06:45:00Z',
                finishedAt: '2026-09-30T06:45:12Z',
              },
            ],
          })
        : path === '/admin/universe'
          ? Promise.resolve({
              lastLoad: {
                loadedAt: '2026-09-30T21:47:00Z',
                snapshotAsOf: '2026-09-24T12:04:35Z',
                source: 'yahoo',
                manifestCounts: { kept: 5294 },
              },
              database: { profiles: 5223, equities: 2534, etfs: 2689, embedded: 5223, etfHoldings: 16363 },
              reconciliation: [
                {
                  what: 'etf_holdings',
                  inSnapshot: 16396,
                  inDatabase: 16360,
                  explained: [{ reason: 'weight is not a fraction of the fund', count: 19 }],
                  unexplained: 17,
                },
              ],
            })
        : path === '/admin/gaps'
          ? Promise.resolve({
              gaps: [
                {
                  id: 'g1',
                  kind: 'universe_gap_missing_ticker',
                  userId: 'u',
                  detail: { symbol: 'TINY', source: 'import', gap: 'not_in_universe', rule: null },
                  occurrences: 3,
                  firstSeenAt: '2026-10-01T06:00:00Z',
                  lastSeenAt: '2026-10-01T07:00:00Z',
                },
              ],
            })
        : path === '/admin/audit'
          ? Promise.resolve({
              entries: [
                {
                  id: '1',
                  adminUserId: 'u',
                  action: 'POST /admin/universe/rescreen',
                  detail: {},
                  ipAddress: '10.0.0.7',
                  requestId: 'r',
                  occurredAt: '2026-10-01T06:00:00Z',
                },
              ],
            })
          : new Promise(() => {}),
    );
    window.scrollTo = () => {};
  });
  afterEach(cleanup);

  it('is linked from the dashboard for an admin', async () => {
    renderAt('/', ADMIN);
    const link = await screen.findByRole('link', { name: /Admin/ });
    expect(link.getAttribute('href')).toBe('/admin');
  });

  it('is not linked for anyone else', async () => {
    renderAt('/', USER);
    await screen.findByRole('link', { name: /Settings/ });
    expect(screen.queryByRole('link', { name: /Admin/ })).toBeNull();
  });

  it('shows every run to an admin', async () => {
    renderAt('/admin', ADMIN);
    expect(await screen.findByText('backfill:k8s:2026-09-30')).toBeTruthy();
    expect(screen.getByText('12 s')).toBeTruthy();
  });

  it('names each difference in the universe and flags only what is unexplained', async () => {
    renderAt('/admin', ADMIN);
    expect(await screen.findByText(/ETF holdings: 16,396 in the snapshot, 16,360 in the database/)).toBeTruthy();
    expect(screen.getByText('19: weight is not a fraction of the fund')).toBeTruthy();
    expect(screen.getByText('17 missing from the database, unexplained')).toBeTruthy();
  });

  it('shows a universe gap, counted, with why it is one', async () => {
    renderAt('/admin', ADMIN);
    expect(await screen.findByText('TINY')).toBeTruthy();
    expect(screen.getByText(/below the size floor or listed since the snapshot/)).toBeTruthy();
    expect(screen.getByText(/3×/)).toBeTruthy();
  });

  it('shows what administrators have done, and from where', async () => {
    renderAt('/admin', ADMIN);
    expect(await screen.findByText('POST /admin/universe/rescreen')).toBeTruthy();
    expect(screen.getByText(/from 10\.0\.0\.7/)).toBeTruthy();
  });

  it('asks the server for nothing when the account is not an admin', async () => {
    renderAt('/admin', USER);
    expect(await screen.findByText('Administrators only')).toBeTruthy();
    expect(get).not.toHaveBeenCalledWith('/admin/runs');
    expect(get).not.toHaveBeenCalledWith('/admin/audit');
    expect(get).not.toHaveBeenCalledWith('/admin/gaps');
    expect(get).not.toHaveBeenCalledWith('/admin/universe');
  });

  it('says a run is still going rather than giving it a duration', () => {
    expect(duration({ startedAt: '2026-09-30T06:45:00Z', finishedAt: null })).toBe('still running');
    expect(duration({ startedAt: '2026-09-30T06:45:00Z', finishedAt: '2026-09-30T06:50:00Z' })).toBe(
      '5 min',
    );
  });
});
