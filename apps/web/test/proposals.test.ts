/**
 * The approvals inbox, and the deadline arithmetic behind each card.
 *
 * The inbox tests are about not lying to the user: a decision is applied to the
 * server before anything on screen changes, and a refusal re-reads rather than
 * leaving a stale row beside a message explaining it is stale.
 *
 * The list lives in a real query cache here, read by an active observer - what
 * the mounted inbox page is - so invalidation refetches as it does in the app.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';

import type { Proposal } from '@traders/shared';

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>(
    '../src/api/client.ts',
  );
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), postForm: vi.fn() } };
});

const { ApiRequestError, api } = await import('../src/api/client.ts');
const { SNOOZE_HOURS } = await import('../src/stores/ProposalsStore.ts');
const { RootStore } = await import('../src/stores/RootStore.ts');
const { queryKeys } = await import('../src/queries/queryKeys.ts');
const {
  REFRESH_INTERVAL_MS,
  inboxRefetchInterval,
  openProposals,
  proposalsQuery,
  recentlyApproved,
} = await import('../src/queries/proposals.ts');
const { isUrgent, snoozeDescription, timeLeft } = await import(
  '../src/lib/proposalCountdown.ts'
);
const { undoSecondsLeft } = await import('../src/lib/undoWindow.ts');

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
    undoableUntil: null,
    createdAt: at(-10),
    ...overrides,
  };
}

/** A root store whose inbox is open: the proposals query has an active reader. */
async function openInbox() {
  const root = new RootStore(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  new QueryObserver(root.queryClient, proposalsQuery).subscribe(() => {});
  await root.queryClient.fetchQuery(proposalsQuery);
  const list = () => root.queryClient.getQueryData<Proposal[]>(queryKeys.proposals) ?? [];
  return { root, inbox: root.proposals, list };
}

/** Route both reads: the open questions, and the recent approvals. */
function serve(open: unknown[], approved: unknown[] = []) {
  vi.mocked(api.get).mockImplementation(async (url: string) =>
    (url.includes('state=approved') ? { proposals: approved } : { proposals: open }) as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  serve([]);
  vi.mocked(api.post).mockResolvedValue({
    outcome: 'applied',
    state: 'approved',
    intentId: 'intent-1',
  } as never);
});

describe('reading the inbox', () => {
  it('counts only proposals that are still open', async () => {
    // The badge is what tells a user a question is waiting, so it must not
    // count questions that are already answered or dead.
    serve([
      proposal({ id: 'a' }),
      proposal({ id: 'b', state: 'snoozed', snoozedUntil: at(30) }),
      proposal({ id: 'c', state: 'expired' }),
      proposal({ id: 'd', state: 'approved' }),
    ]);
    const { list } = await openInbox();
    expect(openProposals(list()).map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('keeps recent approvals in reach, apart from the open questions', async () => {
    serve([proposal()], [proposal({ id: 'p-2', state: 'approved', storedState: 'approved' })]);
    const { list } = await openInbox();
    expect(openProposals(list()).map((p) => p.id)).toEqual(['proposal-1']);
    expect(recentlyApproved(list()).map((p) => p.id)).toEqual(['p-2']);
  });

  it('lists a proposal once even when both reads return it', async () => {
    serve([proposal()], [proposal()]);
    const { list } = await openInbox();
    expect(list()).toHaveLength(1);
  });
});

describe('deciding', () => {
  it('applies the state the server reports, and fetches its undo window at once', async () => {
    // No optimistic rendering: an approval is a ledger row, and a screen that
    // claims one happened when the server refused is the most expensive wrong
    // answer this product can give.
    serve([proposal()]);
    const { inbox, list } = await openInbox();

    // The re-read an approval triggers, carrying the server's undo window.
    serve([], [proposal({ state: 'approved', storedState: 'approved', undoableUntil: at(1) })]);
    await inbox.decide('proposal-1', 'approve');
    expect(api.post).toHaveBeenCalledWith('/proposals/proposal-1/decision', { action: 'approve' });
    expect(list()[0]!.state).toBe('approved');
    // Fetched straight away, not on the next background tick.
    expect(list()[0]!.undoableUntil).toBe(at(1));
  });

  it('shows the answer the server gave before the re-read lands', async () => {
    serve([proposal()]);
    const { root, inbox, list } = await openInbox();
    // The re-read hangs: what is on screen meanwhile is the server's answer to
    // the POST, never the state the button asked for.
    vi.mocked(api.get).mockReturnValue(new Promise(() => {}) as never);
    vi.mocked(api.post).mockResolvedValueOnce({
      outcome: 'applied',
      state: 'rejected',
      intentId: null,
    } as never);
    void inbox.decide('proposal-1', 'approve');
    await vi.waitFor(() => expect(list()[0]!.state).toBe('rejected'));
    root.queryClient.cancelQueries();
  });

  it('sends a snooze as an absolute instant, not a duration', async () => {
    // The server compares it against a deadline it wrote; a duration would be
    // resolved against a different clock from the one the user is reading.
    serve([proposal()]);
    const { inbox } = await openInbox();
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
    serve([proposal()]);
    const { inbox, list } = await openInbox();
    vi.mocked(api.post).mockResolvedValueOnce({
      outcome: 'unchanged',
      state: 'approved',
      intentId: null,
    } as never);
    serve([], [proposal({ state: 'approved', storedState: 'approved' })]);

    await inbox.decide('proposal-1', 'approve');
    expect(inbox.decisionError).toBeNull();
    expect(list()[0]!.state).toBe('approved');
  });

  it('re-reads after a refusal, so the screen stops describing a stale world', async () => {
    serve([proposal()]);
    const { inbox, list } = await openInbox();

    vi.mocked(api.post).mockRejectedValueOnce(
      new ApiRequestError('this proposal has expired', 422, 'expired', { state: 'expired' }),
    );
    serve([]);

    await inbox.decide('proposal-1', 'approve');
    expect(inbox.refusal).toEqual({
      proposalId: 'proposal-1',
      message: 'this proposal has expired',
    });
    // Re-read: the refused proposal is gone rather than sitting there beside a
    // message explaining that it is gone.
    const openReads = vi
      .mocked(api.get)
      .mock.calls.filter(([url]) => url === '/proposals?state=open');
    expect(openReads).toHaveLength(2);
    expect(list()).toHaveLength(0);
  });

  it('does not treat a refusal as a page-level error', async () => {
    // A refusal concerns one card. A page-level error would replace a usable
    // inbox with an error state over a single expired row.
    serve([proposal()]);
    const { inbox } = await openInbox();
    vi.mocked(api.post).mockRejectedValueOnce(
      new ApiRequestError('already decided', 422, 'already_decided'),
    );

    await inbox.decide('proposal-1', 'approve');
    expect(inbox.decisionError).toBeNull();
    expect(inbox.refusal?.message).toBe('already decided');
  });

  it('reports a failure that is not a refusal', async () => {
    serve([proposal()]);
    const { inbox, list } = await openInbox();
    vi.mocked(api.post).mockRejectedValueOnce(new ApiRequestError('offline', 0, 'network_error'));

    await inbox.decide('proposal-1', 'approve');
    expect(inbox.decisionError).toBe('offline');
    expect(list()[0]!.state).toBe('pending');
  });

  it('ignores a second click while a decision is in flight', async () => {
    // Otherwise a double click sends two decisions; the server is idempotent,
    // but spending a round trip to be told so is avoidable here.
    serve([proposal()]);
    const { inbox } = await openInbox();

    let release: (value: unknown) => void = () => {};
    vi.mocked(api.post).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }) as never,
    );

    const first = inbox.decide('proposal-1', 'approve');
    expect(inbox.isDeciding('proposal-1')).toBe(true);
    await inbox.decide('proposal-1', 'approve');
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));

    release({ outcome: 'applied', state: 'approved', intentId: 'i' });
    await first;
    expect(inbox.isDeciding('proposal-1')).toBe(false);
  });
});

describe('which button was clicked', () => {
  it('records the action in flight, not merely that one is', async () => {
    // So the clicked button can say "Rejecting…" while its siblings only
    // disable - the user sees which choice registered.
    serve([proposal()]);
    const { inbox } = await openInbox();

    let release: (value: unknown) => void = () => {};
    vi.mocked(api.post).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }) as never,
    );
    const pending = inbox.decide('proposal-1', 'reject');
    expect(inbox.decidingAction('proposal-1')).toBe('reject');

    // A different button on the same card is ignored too, not just a repeat.
    await inbox.decide('proposal-1', 'approve');
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));

    release({ outcome: 'applied', state: 'rejected', intentId: null });
    await pending;
    expect(inbox.decidingAction('proposal-1')).toBeNull();
  });
});

describe('undo', () => {
  it('moves an approval back to the open questions when it is undone', async () => {
    serve([], [proposal({ state: 'approved', storedState: 'approved' })]);
    const { inbox, list } = await openInbox();
    vi.mocked(api.post).mockResolvedValueOnce({
      outcome: 'applied',
      state: 'pending',
      intentId: null,
    } as never);
    serve([proposal()]);

    await inbox.decide('proposal-1', 'undo');
    expect(api.post).toHaveBeenCalledWith('/proposals/proposal-1/decision', { action: 'undo' });
    expect(recentlyApproved(list())).toHaveLength(0);
    expect(openProposals(list()).map((p) => p.id)).toEqual(['proposal-1']);
  });
});

describe('refreshing in the background', () => {
  it('picks up a decision made elsewhere, such as a Telegram tap', async () => {
    serve([proposal()]);
    const { root, list } = await openInbox();
    expect(openProposals(list())).toHaveLength(1);

    serve([], [proposal({ state: 'approved', storedState: 'approved' })]);
    await root.queryClient.refetchQueries({ queryKey: queryKeys.proposals });
    expect(openProposals(list())).toHaveLength(0);
    expect(recentlyApproved(list())).toHaveLength(1);
  });

  it('stays out of the way of a decision in flight', () => {
    expect(inboxRefetchInterval(0)).toBe(REFRESH_INTERVAL_MS);
    expect(inboxRefetchInterval(1)).toBe(false);
  });

  it('keeps the last good view when a background read fails', async () => {
    serve([proposal()]);
    const { root, list } = await openInbox();
    vi.mocked(api.get).mockRejectedValue(new Error('offline'));

    await root.queryClient.refetchQueries({ queryKey: queryKeys.proposals });
    expect(openProposals(list())).toHaveLength(1);
  });
});

describe('sign-out', () => {
  it('clears one account’s questions and refusals so the next sign-in does not see them', async () => {
    serve([proposal()]);
    const { root, inbox, list } = await openInbox();
    vi.mocked(api.post).mockRejectedValueOnce(new ApiRequestError('expired', 422, 'expired'));
    await inbox.decide('proposal-1', 'approve');

    vi.mocked(api.post).mockResolvedValueOnce(undefined as never);
    await root.auth.logout();
    expect(list()).toHaveLength(0);
    expect(inbox.refusal).toBeNull();
  });
});

describe('undoSecondsLeft', () => {
  const now = NOW.getTime();

  it('counts whole seconds down to the end of the window', () => {
    expect(undoSecondsLeft(new Date(now + 29_900).toISOString(), now)).toBe(29);
  });

  it('is null once the window has closed, so the button goes', () => {
    expect(undoSecondsLeft(new Date(now - 1).toISOString(), now)).toBeNull();
    expect(undoSecondsLeft(new Date(now + 400).toISOString(), now)).toBeNull();
  });

  it('is null when there is no window, or one it cannot read', () => {
    expect(undoSecondsLeft(null, now)).toBeNull();
    expect(undoSecondsLeft('soon', now)).toBeNull();
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
