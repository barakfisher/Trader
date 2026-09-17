/**
 * Notification fan-out: the claim/send/settle ordering, and what happens when a
 * channel misbehaves.
 *
 * The routing rules themselves are covered in notificationPolicy.test.ts. What
 * is pinned here is the sequence around a message that cannot be recalled - the
 * claim must happen before the send, a duplicate claim must stop the send, and
 * one broken channel must not silence the findings behind it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Notifier, OutboundNotification } from '../src/notify/notifier.js';

vi.mock('../src/db/queries.js', () => ({
  claimNotification: vi.fn(async () => ({ id: 'notification-1' })),
  settleNotification: vi.fn(async () => undefined),
}));

vi.mock('../src/logger.js', () => ({
  logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const queries = await import('../src/db/queries.js');
const { fanOut, settingsForNotification } = await import('../src/services/notifications.js');
const { NullNotifier } = await import('../src/notify/notifier.js');

const USER = '00000000-0000-0000-0000-000000000001';
/** Noon in Jerusalem: outside the default 22:00-07:00 quiet window. */
const DAYTIME = new Date('2026-09-17T09:00:00Z');
/** 02:00 in Jerusalem: inside it. */
const NIGHT = new Date('2026-09-16T23:00:00Z');

const SETTINGS = {
  notifySeverity: 'high',
  quietHoursStart: '22:00',
  quietHoursEnd: '07:00',
  mutedUntil: null,
  timezone: 'Asia/Jerusalem',
};

function finding(overrides: Record<string, unknown> = {}) {
  return {
    refKind: 'observation' as const,
    refId: '22222222-2222-2222-2222-222222222222',
    severity: 'high',
    headline: 'VOO is 12pp above target',
    explanation: 'The position has drifted since the target was set.',
    ...overrides,
  };
}

/** A channel that records what it was handed and reports success. */
function workingNotifier() {
  const sent: OutboundNotification[] = [];
  return {
    sent,
    notifier: {
      channel: 'telegram',
      send: vi.fn(async (notification: OutboundNotification) => {
        sent.push(notification);
        return { delivered: true };
      }),
    } satisfies Notifier,
  };
}

beforeEach(() => {
  vi.mocked(queries.claimNotification).mockClear().mockResolvedValue({ id: 'notification-1' });
  vi.mocked(queries.settleNotification).mockClear();
});

describe('fanOut', () => {
  it('claims before it sends', async () => {
    // The whole reason this module exists. Sending first leaves a window in
    // which a crash loses the record of a message the user has already read,
    // and the retry then sends it again.
    const order: string[] = [];
    vi.mocked(queries.claimNotification).mockImplementationOnce(async () => {
      order.push('claim');
      return { id: 'notification-1' };
    });
    const notifier = {
      channel: 'telegram',
      send: vi.fn(async () => {
        order.push('send');
        return { delivered: true };
      }),
    } satisfies Notifier;
    vi.mocked(queries.settleNotification).mockImplementationOnce(async () => {
      order.push('settle');
    });

    await fanOut(USER, [finding()], SETTINGS, notifier, DAYTIME);
    expect(order).toEqual(['claim', 'send', 'settle']);
  });

  it('pushes a finding above the floor, outside quiet hours', async () => {
    const { notifier, sent } = workingNotifier();
    const result = await fanOut(USER, [finding()], SETTINGS, notifier, DAYTIME);

    expect(result).toMatchObject({ pushed: 1, deferred: 0, failed: 0, duplicate: 0 });
    expect(sent[0]).toMatchObject({ userId: USER, title: 'VOO is 12pp above target' });
    expect(queries.settleNotification).toHaveBeenCalledWith('notification-1', 'sent');
  });

  it('defers into the digest during quiet hours without touching the channel', async () => {
    const { notifier } = workingNotifier();
    const result = await fanOut(USER, [finding()], SETTINGS, notifier, NIGHT);

    expect(result).toMatchObject({ pushed: 0, deferred: 1 });
    expect(result.reasons).toEqual({ quiet_hours: 1 });
    expect(notifier.send).not.toHaveBeenCalled();
    // Left 'pending' for the digest run to collect, so it is not settled here.
    expect(queries.settleNotification).not.toHaveBeenCalled();
  });

  it('claims a deferred finding on the digest channel, not the push one', async () => {
    // Otherwise a deferred alert and a later push share a dedupe key and
    // collapse into each other, and the user hears about it exactly once -
    // whichever way round that happens to fall.
    const { notifier } = workingNotifier();
    await fanOut(USER, [finding()], SETTINGS, notifier, NIGHT);

    const [record] = vi.mocked(queries.claimNotification).mock.calls[0]!;
    expect(record).toMatchObject({ channel: 'digest', route: 'digest', status: 'pending' });
    expect(record.dedupeKey).toContain('digest:');
  });

  it('does not send when the claim was already taken', async () => {
    // The unique key did its job: somebody already sent this. The point is that
    // losing the claim stops the send, rather than merely not recording it.
    vi.mocked(queries.claimNotification).mockResolvedValueOnce(null);
    const { notifier } = workingNotifier();
    const result = await fanOut(USER, [finding()], SETTINGS, notifier, DAYTIME);

    expect(result).toMatchObject({ duplicate: 1, pushed: 0 });
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it('records a channel that declines, with its reason on the row', async () => {
    const notifier = new NullNotifier('TELEGRAM_BOT_TOKEN is not set');
    const result = await fanOut(USER, [finding()], SETTINGS, notifier, DAYTIME);

    expect(result).toMatchObject({ failed: 1, pushed: 0 });
    expect(queries.settleNotification).toHaveBeenCalledWith(
      'notification-1',
      'failed',
      'TELEGRAM_BOT_TOKEN is not set',
    );
  });

  it('records a channel that throws rather than losing the row', async () => {
    const notifier = {
      channel: 'telegram',
      send: vi.fn(async () => {
        throw new Error('connection reset');
      }),
    } satisfies Notifier;

    const result = await fanOut(USER, [finding()], SETTINGS, notifier, DAYTIME);
    expect(result.failed).toBe(1);
    expect(queries.settleNotification).toHaveBeenCalledWith(
      'notification-1',
      'failed',
      'connection reset',
    );
  });

  it('keeps going after one finding fails', async () => {
    // A single unreachable message must not silence every finding behind it.
    let call = 0;
    const notifier = {
      channel: 'telegram',
      send: vi.fn(async () => {
        call += 1;
        if (call === 1) throw new Error('connection reset');
        return { delivered: true };
      }),
    } satisfies Notifier;

    const result = await fanOut(
      USER,
      [finding({ refId: 'a' }), finding({ refId: 'b' })],
      SETTINGS,
      notifier,
      DAYTIME,
    );
    expect(result).toMatchObject({ failed: 1, pushed: 1 });
  });

  it('counts the reasons so a run can report why it was quiet', async () => {
    const { notifier } = workingNotifier();
    const result = await fanOut(
      USER,
      [
        finding({ refId: 'a', severity: 'high' }),
        finding({ refId: 'b', severity: 'info' }),
        finding({ refId: 'c', severity: 'notable' }),
      ],
      SETTINGS,
      notifier,
      DAYTIME,
    );

    expect(result.reasons).toEqual({ above_floor: 1, below_floor: 2 });
    expect(result).toMatchObject({ pushed: 1, deferred: 2 });
  });

  it('sends nothing at all when there is nothing to send', async () => {
    const { notifier } = workingNotifier();
    const result = await fanOut(USER, [], SETTINGS, notifier, DAYTIME);
    expect(result).toMatchObject({ pushed: 0, deferred: 0, duplicate: 0, failed: 0 });
    expect(queries.claimNotification).not.toHaveBeenCalled();
  });
});

describe('settingsForNotification', () => {
  it('takes the timezone from the user, not from the settings row', async () => {
    // Quiet hours borrow users.timezone rather than storing a second copy that
    // could drift from the one every "today" calculation already uses.
    const mapped = settingsForNotification(
      {
        notify_severity: 'notable',
        quiet_hours_start: '23:00',
        quiet_hours_end: '06:00',
        muted_until: null,
      },
      'America/New_York',
    );
    expect(mapped).toEqual({
      notifySeverity: 'notable',
      quietHoursStart: '23:00',
      quietHoursEnd: '06:00',
      mutedUntil: null,
      timezone: 'America/New_York',
    });
  });
});

describe('NullNotifier', () => {
  it('declines with a reason instead of claiming success', async () => {
    // Pretending to deliver would write status='sent' for a message that
    // reached nobody, which is the one lie the notifications table exists to
    // prevent. Throwing would turn "not configured" into a failed scan.
    const result = await new NullNotifier('no channel configured').send();
    expect(result).toEqual({ delivered: false, error: 'no channel configured' });
  });
});
