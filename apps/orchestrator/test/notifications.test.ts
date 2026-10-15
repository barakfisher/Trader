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

/** The user's primary agent; its id is opaque to everything under test. */
const AGENT = '90000000-0000-0000-0000-000000000001';
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
  language: 'en',
};

function finding(overrides: Record<string, unknown> = {}) {
  return {
    refKind: 'observation' as const,
    refId: '22222222-2222-2222-2222-222222222222',
    severity: 'high',
    headline: 'VOO is 12pp above target',
    explanation: 'The position has drifted since the target was set.',
    localized: {},
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

    await fanOut(USER, AGENT, [finding()], SETTINGS, notifier, DAYTIME);
    expect(order).toEqual(['claim', 'send', 'settle']);
  });

  it('pushes a finding above the floor, outside quiet hours', async () => {
    const { notifier, sent } = workingNotifier();
    const result = await fanOut(USER, AGENT, [finding()], SETTINGS, notifier, DAYTIME);

    expect(result).toMatchObject({ pushed: 1, deferred: 0, failed: 0, duplicate: 0 });
    expect(sent[0]).toMatchObject({ userId: USER, title: 'VOO is 12pp above target' });
    expect(queries.settleNotification).toHaveBeenCalledWith('notification-1', 'sent');
  });

  it('defers into the digest during quiet hours without touching the channel', async () => {
    const { notifier } = workingNotifier();
    const result = await fanOut(USER, AGENT, [finding()], SETTINGS, notifier, NIGHT);

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
    await fanOut(USER, AGENT, [finding()], SETTINGS, notifier, NIGHT);

    const [record] = vi.mocked(queries.claimNotification).mock.calls[0]!;
    expect(record).toMatchObject({ channel: 'digest', route: 'digest', status: 'pending' });
    expect(record.dedupeKey).toContain('digest:');
  });

  it('does not send when the claim was already taken', async () => {
    // The unique key did its job: somebody already sent this. The point is that
    // losing the claim stops the send, rather than merely not recording it.
    vi.mocked(queries.claimNotification).mockResolvedValueOnce(null);
    const { notifier } = workingNotifier();
    const result = await fanOut(USER, AGENT, [finding()], SETTINGS, notifier, DAYTIME);

    expect(result).toMatchObject({ duplicate: 1, pushed: 0 });
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it('records a channel that declines, with its reason on the row', async () => {
    const notifier = new NullNotifier('TELEGRAM_BOT_TOKEN is not set');
    const result = await fanOut(USER, AGENT, [finding()], SETTINGS, notifier, DAYTIME);

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

    const result = await fanOut(USER, AGENT, [finding()], SETTINGS, notifier, DAYTIME);
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
      AGENT,
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
      AGENT,
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
    const result = await fanOut(USER, AGENT, [], SETTINGS, notifier, DAYTIME);
    expect(result).toMatchObject({ pushed: 0, deferred: 0, duplicate: 0, failed: 0 });
    expect(queries.claimNotification).not.toHaveBeenCalled();
  });
});

describe('fanOut in the user’s language', () => {
  const hebrew = { headline: 'משקל \u2066VOO\u2069 גבוה', explanation: 'משקל \u2066VOO\u2069 בתיק.' };

  it('sends the stored translation, and says which language it is in', async () => {
    const { sent, notifier } = workingNotifier();
    await fanOut(USER, AGENT, [finding({ localized: { he: hebrew } })], { ...SETTINGS, language: 'he' }, notifier, DAYTIME);
    expect(sent[0]).toMatchObject({ title: hebrew.headline, body: hebrew.explanation, language: 'he' });
  });

  it('sends the English when a finding has no translation, rather than nothing', async () => {
    const { sent, notifier } = workingNotifier();
    await fanOut(USER, AGENT, [finding()], { ...SETTINGS, language: 'he' }, notifier, DAYTIME);
    expect(sent[0]).toMatchObject({ title: 'VOO is 12pp above target', language: 'he' });
  });
});

describe('fanOut: a move and a drawdown on one holding (decision 148)', () => {
  const MOVE_ID = '33333333-3333-3333-3333-333333333333';
  const DRAWDOWN_ID = '44444444-4444-4444-4444-444444444444';

  function move(overrides: Record<string, unknown> = {}) {
    return finding({
      refId: MOVE_ID,
      kind: 'price_move',
      subjectRef: 'instrument:OUST',
      severity: 'high',
      headline: 'OUST shares fell 9.51% to USD 31.97',
      explanation: 'The price of OUST decreased by USD 3.36.',
      evidence: {
        symbol: 'OUST',
        currency: 'USD',
        price_minor: 3197,
        previous_price_minor: 3533,
        change_pct: -0.0951,
      },
      ...overrides,
    });
  }

  function drawdown(overrides: Record<string, unknown> = {}) {
    return finding({
      refId: DRAWDOWN_ID,
      kind: 'drawdown',
      subjectRef: 'instrument:OUST',
      severity: 'high',
      headline: 'OUST experienced a high drawdown of 28.81%',
      explanation: 'OUST dropped to a price of 31.97 USD.',
      evidence: {
        symbol: 'OUST',
        currency: 'USD',
        price_minor: 3197,
        high_price_minor: 4491,
        drawdown_pct: -0.2881,
        window_days: 30,
      },
      ...overrides,
    });
  }

  it('sends one message built from both evidences, and settles both rows', async () => {
    const { sent, notifier } = workingNotifier();
    vi.mocked(queries.claimNotification)
      .mockResolvedValueOnce({ id: 'row-move' })
      .mockResolvedValueOnce({ id: 'row-drawdown' });

    const result = await fanOut(USER, AGENT, [move(), drawdown()], SETTINGS, notifier, DAYTIME);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      title: 'OUST fell 9.51% to $31.97',
      body: 'Now 28.81% below its 30-day high of $44.91.',
    });
    expect(queries.claimNotification).toHaveBeenCalledTimes(2);
    expect(queries.settleNotification).toHaveBeenCalledWith('row-move', 'sent');
    expect(queries.settleNotification).toHaveBeenCalledWith('row-drawdown', 'sent');
    expect(result).toMatchObject({ pushed: 2, failed: 0, duplicate: 0 });
  });

  it('says how unusual the move was when it is a sigma move', async () => {
    const { sent, notifier } = workingNotifier();
    const sigma = move({
      kind: 'sigma_move',
      evidence: { symbol: 'OUST', currency: 'USD', price_minor: 3197, change_pct: -0.0951, z_score: -3.24 },
    });
    await fanOut(USER, AGENT, [drawdown(), sigma], SETTINGS, notifier, DAYTIME);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toBe(
      'Now 28.81% below its 30-day high of $44.91; the move was 3.2 standard deviations from its recent average.',
    );
  });

  it('is routed at the stronger severity, so a high move carries a notable drawdown', async () => {
    const { sent, notifier } = workingNotifier();
    const result = await fanOut(USER, AGENT, [move(), drawdown({ severity: 'notable' })], SETTINGS, notifier, DAYTIME);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.severity).toBe('high');
    expect(result.reasons).toEqual({ above_floor: 2 });
  });

  it('defers both halves into the digest during quiet hours', async () => {
    const { notifier } = workingNotifier();
    const result = await fanOut(USER, AGENT, [move(), drawdown()], SETTINGS, notifier, NIGHT);

    expect(notifier.send).not.toHaveBeenCalled();
    expect(result).toMatchObject({ deferred: 2, pushed: 0 });
  });

  it('sends nothing on a re-scan that finds both already claimed', async () => {
    const { notifier } = workingNotifier();
    vi.mocked(queries.claimNotification).mockResolvedValue(null);
    const result = await fanOut(USER, AGENT, [move(), drawdown()], SETTINGS, notifier, DAYTIME);

    expect(notifier.send).not.toHaveBeenCalled();
    expect(result.duplicate).toBe(2);
  });

  it('sends the unclaimed half in its own words when the other was already sent', async () => {
    const { sent, notifier } = workingNotifier();
    vi.mocked(queries.claimNotification).mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'row-drawdown' });
    await fanOut(USER, AGENT, [move(), drawdown()], SETTINGS, notifier, DAYTIME);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toBe('OUST experienced a high drawdown of 28.81%');
  });

  it('marks both rows failed when the one message fails', async () => {
    vi.mocked(queries.claimNotification)
      .mockResolvedValueOnce({ id: 'row-move' })
      .mockResolvedValueOnce({ id: 'row-drawdown' });
    const notifier = {
      channel: 'telegram',
      send: vi.fn(async () => ({ delivered: false, error: 'chat not found' })),
    } satisfies Notifier;
    const result = await fanOut(USER, AGENT, [move(), drawdown()], SETTINGS, notifier, DAYTIME);

    expect(notifier.send).toHaveBeenCalledTimes(1);
    expect(queries.settleNotification).toHaveBeenCalledWith('row-move', 'failed', 'chat not found');
    expect(queries.settleNotification).toHaveBeenCalledWith('row-drawdown', 'failed', 'chat not found');
    expect(result.failed).toBe(2);
  });

  it('leaves a lone move, and findings on different holdings, as separate messages', async () => {
    const { sent, notifier } = workingNotifier();
    await fanOut(
      USER,
      AGENT,
      [move(), drawdown({ subjectRef: 'instrument:URA', evidence: { symbol: 'URA' } })],
      SETTINGS,
      notifier,
      DAYTIME,
    );
    expect(sent.map((message) => message.title)).toEqual([
      'OUST shares fell 9.51% to USD 31.97',
      'OUST experienced a high drawdown of 28.81%',
    ]);
  });

  it('falls back to the stored words when the evidence lacks a figure the sentence needs', async () => {
    // A sentence with a missing figure would be a figure invented (guideline 7).
    const { sent, notifier } = workingNotifier();
    await fanOut(USER, AGENT, [move(), drawdown({ evidence: { currency: 'USD', drawdown_pct: -0.2881 } })], SETTINGS, notifier, DAYTIME);
    expect(sent).toHaveLength(2);
  });

  it('writes the merged sentence in Hebrew from the catalogue', async () => {
    const { sent, notifier } = workingNotifier();
    await fanOut(USER, AGENT, [move(), drawdown()], { ...SETTINGS, language: 'he' }, notifier, DAYTIME);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toContain('ירד');
    expect(sent[0]!.body).toContain('שיא של');
    expect(sent[0]!.language).toBe('he');
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
        language: 'he',
      },
      'America/New_York',
    );
    expect(mapped).toEqual({
      notifySeverity: 'notable',
      quietHoursStart: '23:00',
      quietHoursEnd: '06:00',
      mutedUntil: null,
      timezone: 'America/New_York',
      language: 'he',
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
