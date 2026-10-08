// @vitest-environment jsdom
/**
 * The daily digest on the dashboard: what the next one will carry and why each
 * finding was held back, and what the last one delivered - and which empty an
 * empty card is.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';

import type { DigestEntry, DigestResponse } from '@traders/shared';

const get = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>(
    '../src/api/client.ts',
  );
  return { ...actual, api: { get, post: vi.fn(), put: vi.fn(), delete: vi.fn(), postForm: vi.fn() } };
});

const { ApiRequestError } = await import('../src/api/client.ts');
const { DigestCard } = await import('../src/components/DigestCard.tsx');
const { renderWithServerState } = await import('./serverStateHarness.tsx');

const entry = (overrides: Partial<DigestEntry> = {}): DigestEntry => ({
  observationId: 'o-1',
  headline: 'SMR is -30.6% from its 30-day high',
  localized: {},
  severity: 'high',
  subjectRef: 'instrument:SMR',
  reason: 'quiet_hours',
  createdAt: '2026-09-30T00:51:41.000Z',
  ...overrides,
});

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

it('says what the next digest holds and why, and what the last one delivered', async () => {
  const response: DigestResponse = {
    next: {
      entries: [
        entry(),
        entry({ observationId: 'o-2', headline: 'VOO drifted', reason: 'below_floor' }),
        // A narration notice rides along but is not a finding.
        entry({ observationId: null, headline: null, severity: null, subjectRef: null }),
      ],
    },
    last: {
      sentAt: '2026-09-30T06:45:29.305Z',
      entries: [entry({ reason: 'below_floor' })],
      seen: true,
    },
  };
  get.mockResolvedValue(response);
  renderWithServerState(<DigestCard />);

  expect(
    await screen.findByText('Next digest: 2 findings - 1 held during quiet hours, 1 below your alert threshold.'),
  ).toBeTruthy();
  expect(screen.getByText('VOO drifted')).toBeTruthy();
  expect(screen.getByText(/^Last delivered .*: 1 finding - 1 below your alert threshold$/)).toBeTruthy();
  expect(get).toHaveBeenCalledWith('/notifications/digest');
});

it('says which empty an empty digest is', async () => {
  get.mockResolvedValue({ next: { entries: [] }, last: null } satisfies DigestResponse);
  renderWithServerState(<DigestCard />);

  expect(await screen.findByText('Nothing is waiting for the next digest.')).toBeTruthy();
  expect(screen.getByText('No digest has been delivered yet.')).toBeTruthy();
});

it('reports a failed read as a failure, never as an empty digest', async () => {
  get.mockRejectedValue(new ApiRequestError('Cannot reach the server.', 0, 'network_error'));
  renderWithServerState(<DigestCard />);

  expect(await screen.findByText('Cannot reach the server.')).toBeTruthy();
  expect(screen.queryByText('Nothing is waiting for the next digest.')).toBeNull();
});
