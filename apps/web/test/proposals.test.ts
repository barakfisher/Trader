/**
 * The approvals inbox store, and the deadline arithmetic behind each card.
 *
 * The store tests are about not lying to the user: a decision is applied to the
 * server before anything on screen changes, and a refusal reloads rather than
 * leaving a stale row beside a message explaining it is stale.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>(
    '../src/api/client.ts',
  );
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), postForm: vi.fn() } };
});

const { ApiRequestError, api } = await import('../src/api/client.ts');
const { ProposalsStore, SNOOZE_HOURS } = await import('../src/stores/ProposalsStore.ts');
const { isUrgent, snoozeDescription, timeLeft } = await import(
  '../src/lib/proposalCountdown.ts'
);

const NOW = new Date('2026-09-17T12:00:00.000Z');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proposal-1',
    observationId: 'observation-1',
    kind: 'rebalance',
    payload: {},
    state: 'pending',
    storedState: 'pending',
    severity: 'high',
    subjectRef: 'portfolio',
    headline: 'VOO is 12pp above target',
    explanation: 'The position has drifted.',
    evidence: { drift: '0.12' },
    expiresAt: at(120),
    snoozedUntil: null,
    decidedAt: null,
    decidedVia: null,
    createdAt: at(-10),
    ...overrides,
  };
}

const store = () => new ProposalsStore({} as never);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.get).mockResolvedValue({ proposals: [] } as never);
  vi.mocked(api.post).mockResolvedValue({
    outcome: 'applied',
    state: 'approved',
    intentId: 'intent-1',
  } as never);
});

describe('loading the inbox', () => {
  it('counts only proposals that are still open', async () => {
    // The badge is what tells a user a question is waiting, so it must not
    // count questions that are already answered or dead.
    vi.mocked(api.get).mockResolvedValueOnce({
      proposals: [
        proposal({ id: 'a' }),
        proposal({ id: 'b', state: 'snoozed', snoozedUntil: at(30) }),
        proposal({ id: 'c', state: 'expired' }),
        proposal({ id: 'd', state: 'approved' }),
      ],
    } as never);

    const inbox = store();
    await inbox.load();
    expect(inbox.openCount).toBe(2);
    expect(inbox.open.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('reports a load failure instead of showing an empty inbox', async () => {
    // "Nothing waiting on you" and "we could not ask" must not look the same:
    // one of them means a deadline may be passing unseen.
    vi.mocked(api.get).mockRejectedValueOnce(new ApiRequestError('offline', 0, 'network_error'));
    const inbox = store();
    await inbox.load();
    expect(inbox.error).toBe('offline');
  });
});

describe('deciding', () => {
  it('applies the state the server reports, not the one that was asked for', async () => {
    // No optimistic rendering: an approval is a ledger row, and a screen that
    // claims one happened when the server refused is the most expensive wrong
    // answer this product can give.
    vi.mocked(api.get).mockResolvedValueOnce({ proposals: [proposal()] } as never);
    const inbox = store();
    await inbox.load();

    await inbox.decide('proposal-1', 'approve');
    expect(api.post).toHaveBeenCalledWith('/proposals/proposal-1/decision', { action: 'approve' });
    expect(inbox.proposals[0]!.state).toBe('approved');
  });

  it('sends a snooze as an absolute instant, not a duration', async () => {
    // The server compares it against a deadline it wrote; a duration would be
    // resolved against a different clock from the one the user is reading.
    vi.mocked(api.get).mockResolvedValueOnce({ proposals: [proposal()] } as never);
    const inbox = store();
    await inbox.load();
    vi.mocked(api.post).mockResolvedValueOnce({
      outcome: 'applied',
      state: 'snoozed',
      intentId: null,
    } as never);

    await inbox.decide('proposal-1', 'snooze');
    const [, body] = vi.mocked(api.post).mock.calls[0]!;
    const sent = (body as { snoozeUntil: string }).snoozeUntil;
    const hours = (new Date(sent).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(SNOOZE_HOURS - 0.1);
    expect(hours).toBeLessThan(SNOOZE_HOURS + 0.1);
  });

  it('treats an unchanged result as a success', async () => {
    // Somebody already answered - possibly this user, on their phone. Showing
    // an error would punish them for a decision that was in fact made.
    vi.mocked(api.get).mockResolvedValueOnce({ proposals: [proposal()] } as never);
    const inbox = store();
    await inbox.load();
    vi.mocked(api.post).mockResolvedValueOnce({
      outcome: 'unchanged',
      state: 'approved',
      intentId: null,
    } as never);

    await inbox.decide('proposal-1', 'approve');
    expect(inbox.error).toBeNull();
    expect(inbox.proposals[0]!.state).toBe('approved');
  });

  it('reloads after a refusal, so the screen stops describing a stale world', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ proposals: [proposal()] } as never);
    const inbox = store();
    await inbox.load();

    vi.mocked(api.post).mockRejectedValueOnce(
      new ApiRequestError('this proposal has expired', 422, 'expired', { state: 'expired' }),
    );
    vi.mocked(api.get).mockResolvedValueOnce({ proposals: [] } as never);

    await inbox.decide('proposal-1', 'approve');
    expect(inbox.refusal).toEqual({
      proposalId: 'proposal-1',
      message: 'this proposal has expired',
    });
    // Reloaded: the refused proposal is gone rather than sitting there beside a
    // message explaining that it is gone.
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(inbox.proposals).toHaveLength(0);
  });

  it('does not treat a refusal as a page-level error', async () => {
    // A refusal concerns one card. Setting `error` would replace a usable inbox
    // with an error state over a single expired row.
    vi.mocked(api.get).mockResolvedValue({ proposals: [proposal()] } as never);
    const inbox = store();
    await inbox.load();
    vi.mocked(api.post).mockRejectedValueOnce(
      new ApiRequestError('already decided', 422, 'already_decided'),
    );

    await inbox.decide('proposal-1', 'approve');
    expect(inbox.error).toBeNull();
  });

  it('ignores a second click while a decision is in flight', async () => {
    // Otherwise a double click sends two decisions; the server is idempotent,
    // but spending a round trip to be told so is avoidable here.
    vi.mocked(api.get).mockResolvedValueOnce({ proposals: [proposal()] } as never);
    const inbox = store();
    await inbox.load();

    let release: (value: unknown) => void = () => {};
    vi.mocked(api.post).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }) as never,
    );

    const first = inbox.decide('proposal-1', 'approve');
    expect(inbox.isDeciding('proposal-1')).toBe(true);
    await inbox.decide('proposal-1', 'approve');
    expect(api.post).toHaveBeenCalledTimes(1);

    release({ outcome: 'applied', state: 'approved', intentId: 'i' });
    await first;
    expect(inbox.isDeciding('proposal-1')).toBe(false);
  });
});

describe('reset', () => {
  it('clears one account’s questions so the next sign-in does not see them', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ proposals: [proposal()] } as never);
    const inbox = store();
    await inbox.load();
    inbox.reset();
    expect(inbox.proposals).toHaveLength(0);
    expect(inbox.openCount).toBe(0);
  });
});

describe('timeLeft', () => {
  it('counts down in days, hours and minutes as the deadline approaches', () => {
    expect(timeLeft(at(60 * 24 * 3), NOW)).toBe('3d left');
    expect(timeLeft(at(150), NOW)).toBe('2h left');
    expect(timeLeft(at(45), NOW)).toBe('45m left');
  });

  it('rounds down, never up', () => {
    // "3h left" at two hours fifty-nine sends someone back three hours later to
    // find the question gone. Understating the time available costs nothing.
    expect(timeLeft(at(179), NOW)).toBe('2h left');
  });

  it('says a deadline within the minute is imminent rather than showing 0m', () => {
    expect(timeLeft(at(0.5), NOW)).toBe('expiring now');
  });

  it('returns null once the deadline has passed', () => {
    // The caller renders the expired state; a negative countdown is not a thing
    // to show anybody.
    expect(timeLeft(at(-1), NOW)).toBeNull();
    expect(timeLeft(NOW.toISOString(), NOW)).toBeNull();
  });

  it('returns null for a timestamp it cannot read', () => {
    expect(timeLeft('not a date', NOW)).toBeNull();
  });
});

describe('isUrgent', () => {
  it('marks a deadline inside the hour', () => {
    expect(isUrgent(at(30), NOW)).toBe(true);
  });

  it('does not mark one further out, or one already passed', () => {
    expect(isUrgent(at(90), NOW)).toBe(false);
    expect(isUrgent(at(-1), NOW)).toBe(false);
  });
});

describe('snoozeDescription', () => {
  it('says when a snoozed proposal comes back', () => {
    expect(snoozeDescription(at(90), NOW)).toBe('snoozed, back in 1h');
  });

  it('says nothing when there is no snooze', () => {
    expect(snoozeDescription(null, NOW)).toBeNull();
  });

  it('says a snooze that has already elapsed is waking', () => {
    // effectiveState reads it as pending on the server; the card should not
    // claim it is still asleep in the meantime.
    expect(snoozeDescription(at(-5), NOW)).toBe('waking now');
  });
});
