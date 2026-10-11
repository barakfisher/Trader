// @vitest-environment jsdom
/**
 * The Alerts tab, rendered (decision 134): each alert says which agent it came
 * from when it was not the main portfolio, and what became of it - sent, held
 * for the digest by quiet hours, or not delivered. A failed push is listed and
 * says so: hiding it would make "we failed to tell you" read as "nothing to tell".
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';

import type { Alert, AlertsResponse } from '@traders/shared';

const get = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>(
    '../src/api/client.ts',
  );
  return { ...actual, api: { get, post: vi.fn(), put: vi.fn(), delete: vi.fn(), postForm: vi.fn() } };
});

const { AlertsList } = await import('../src/components/AlertsList.tsx');
const { applyLanguage } = await import('../src/i18n/index.ts');
const { renderWithServerState } = await import('./serverStateHarness.tsx');

const MAIN = { id: 'a-main', name: 'Main portfolio', isPrimary: true };

function alert(id: string, overrides: Partial<Alert>): Alert {
  return {
    id,
    kind: 'drawdown',
    severity: 'high',
    subjectKind: 'instrument',
    subjectRef: 'instrument:SMR',
    headline: `headline ${id}`,
    explanation: 'explanation',
    evidence: {},
    conceptRefs: [],
    localized: {},
    narrationSource: 'template',
    fallbackReason: 'none',
    createdAt: '2026-10-09T14:00:00Z',
    agent: MAIN,
    delivery: { deferred: false, delivered: true, sentAt: '2026-10-09T14:00:05Z' },
    ...overrides,
  };
}

function serve(alerts: Alert[]) {
  get.mockImplementation((path: string) =>
    path.startsWith('/notifications/alerts')
      ? Promise.resolve({ alerts, total: alerts.length, nextCursor: null } satisfies AlertsResponse)
      : new Promise(() => {}),
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  cleanup();
  await act(() => applyLanguage('en'));
});

it('names the agent and says what became of each alert', async () => {
  serve([
    alert('sent', {}),
    alert('trade', {
      kind: 'agent_trade',
      agent: { id: 'a-test', name: 'Test agent', isPrimary: false },
    }),
    alert('quiet', { delivery: { deferred: true, delivered: false, sentAt: null } }),
    alert('failed', { delivery: { deferred: false, delivered: false, sentAt: null } }),
  ]);

  renderWithServerState(<AlertsList source={undefined} onSourceChange={() => {}} />);

  expect(await screen.findByText('headline sent')).toBeTruthy();
  // The main portfolio is the default, so only another agent is named.
  expect(screen.getAllByText(/^Agent:/).map((node) => node.textContent)).toEqual([
    'Agent: Test agent',
  ]);
  expect(screen.getAllByText(/^Sent /)).toHaveLength(2);
  expect(screen.getByText('Held for the digest (quiet hours)')).toBeTruthy();
  expect(screen.getByText('Not delivered')).toBeTruthy();
});

it('says nothing was sent only after the read succeeded, and in Hebrew too', async () => {
  serve([]);

  renderWithServerState(<AlertsList source={undefined} onSourceChange={() => {}} />);
  await act(() => applyLanguage('he'));

  expect(await screen.findByText('לא נשלח דבר')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'סוכנים' })).toBeTruthy();
});
