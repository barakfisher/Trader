/**
 * The digest's topic section, and the digest itself - which had no tests before it.
 *
 * The database is substituted: rows are shaped as the queries return them. What
 * is asserted is the wording's honesty (measured / not measured / not scanned
 * never look alike), when a digest is sent at all, and that settlement of the
 * deferred entries is unchanged by the new section.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TopicSentimentRow } from '../src/db/queries.js';

const USER = {
  id: '00000000-0000-0000-0000-000000000001',
  email: null,
  base_currency: 'USD',
  timezone: 'Asia/Jerusalem',
};
const NOW = new Date('2026-09-27T12:00:00Z');
const TODAY = '2026-09-27';

const db = vi.hoisted(() => ({
  topics: [] as Record<string, unknown>[],
  observations: [] as { subject_ref: string; severity: string; headline: string; created_at: Date }[],
  lastScan: null as { started_at: Date; status: string; stats: unknown } | null,
  rows: {} as Record<string, TopicSentimentRow[]>,
  pending: [] as { id: string; reason: string }[],
  settled: [] as { id: string; status: string }[],
}));

vi.mock('../src/db/queries.js', () => ({
  listTopics: vi.fn(async () => db.topics),
  listRecentTopicObservations: vi.fn(async () => db.observations),
  getLatestFinishedRun: vi.fn(async () => db.lastScan),
  listTopicSentimentRows: vi.fn(async (_u: string, topicId: string) => db.rows[topicId] ?? []),
  listPendingDigest: vi.fn(async () => db.pending),
  getOrCreateUserSettings: vi.fn(async () => ({ muted_until: null })),
  settleNotification: vi.fn(async (id: string, status: string) => {
    db.settled.push({ id, status });
  }),
  claimNotification: vi.fn(),
}));
vi.mock('../src/logger.js', () => ({ logger: () => ({ info: vi.fn(), warn: vi.fn() }) }));

const { gatherTopicDigest, renderTopicSection } = await import('../src/services/topicDigest.js');
const { sendDigest } = await import('../src/services/notifications.js');

function topic(id: string, label: string, confirmedAt = '2026-09-20T00:00:00Z') {
  return {
    id,
    label,
    status: 'active',
    created_by: 'user',
    created_at: new Date(confirmedAt),
    updated_at: new Date(confirmedAt),
    confirmed_at: new Date(confirmedAt),
    instrument_count: 2,
  };
}

function article(id: string, day: string, score = '1.0000', magnitude = '0.5000'): TopicSentimentRow {
  return {
    id,
    url: `https://example.com/${id}`,
    source: 'Example',
    title: id,
    published_at: new Date(`${day}T08:00:00Z`),
    fetched_at: new Date(`${day}T08:05:00Z`),
    local_day: day,
    model: 'lexicon-v1',
    score,
    magnitude,
  };
}

function notifier() {
  return { channel: 'test', send: vi.fn(async () => ({ delivered: true })) };
}

beforeEach(() => {
  db.topics = [topic('t-u', 'uranium'), topic('t-g', 'gasoline'), topic('t-n', 'nuclear')];
  db.observations = [];
  db.lastScan = {
    started_at: new Date('2026-09-27T11:30:00Z'),
    status: 'degraded',
    stats: { skipped: { nuclear: '1 of 4 instruments priced on 2026-09-26; at least 2 needed' } },
  };
  db.rows = {};
  db.pending = [];
  db.settled = [];
});

describe('the topic section', () => {
  it('quotes a move by its stored headline and keeps three states apart', async () => {
    db.topics.push(topic('t-new', 'solar', '2026-09-27T11:45:00Z'));
    db.observations = [
      {
        subject_ref: 'topic:t-u',
        severity: 'notable',
        headline: 'uranium moved -5.0% on average, 3.1 standard deviations from its recent average',
        created_at: NOW,
      },
    ];

    const section = renderTopicSection(await gatherTopicDigest(USER as never, NOW));

    expect(section).toBe(
      [
        'Topics',
        '• uranium moved -5.0% on average, 3.1 standard deviations from its recent average',
        '  News, last 7 days: none collected',
        '• gasoline: no unusual move in the last day',
        '  News, last 7 days: none collected',
        '• nuclear: not measured (1 of 4 instruments priced on 2026-09-26; at least 2 needed)',
        '  News, last 7 days: none collected',
        '• solar: not scanned yet',
        '  News, last 7 days: none collected',
      ].join('\n'),
    );
  });

  it("gives the week's tone, or says why there is none", async () => {
    db.rows['t-u'] = [
      article('a', TODAY, '1.0000'),
      article('b', '2026-09-25', '1.0000'),
      article('c', '2026-09-24', '-1.0000', '0.2500'),
    ];
    db.rows['t-g'] = [article('d', TODAY)];

    const section = renderTopicSection(await gatherTopicDigest(USER as never, NOW))!;

    // (0.5 + 0.5 - 0.25) / 1.25 = 0.6
    expect(section).toContain('  News, last 7 days: 3 articles, tone +0.60 (lexicon-v1)');
    expect(section).toContain('  News, last 7 days: 1 article, too few with a clear tone to score');
  });

  it('is absent on a day when no topic moved or had news', async () => {
    db.rows['t-u'] = [article('old', '2026-09-24')];

    expect(renderTopicSection(await gatherTopicDigest(USER as never, NOW))).toBeNull();
  });

  it('is absent when the user follows no topics', async () => {
    db.topics = [];
    expect(await gatherTopicDigest(USER as never, NOW)).toEqual([]);
  });
});

describe('sendDigest', () => {
  it('sends nothing on a quiet day, as before', async () => {
    const channel = notifier();

    const result = await sendDigest(USER as never, channel as never, NOW);

    expect(result).toEqual({ entries: 0, topics: 0, delivered: false });
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('sends a topic-only digest when a topic moved, with nothing to settle', async () => {
    db.observations = [
      { subject_ref: 'topic:t-u', severity: 'info', headline: 'uranium moved +3.4% on average', created_at: NOW },
    ];
    const channel = notifier();

    const result = await sendDigest(USER as never, channel as never, NOW);

    expect(result).toMatchObject({ entries: 0, topics: 3, delivered: true });
    const [message] = channel.send.mock.calls[0]! as unknown as [{ title: string; body: string }];
    expect(message.title).toBe('Daily digest: 3 topics');
    expect(message.body.startsWith('Topics\n• uranium moved +3.4% on average')).toBe(true);
    expect(db.settled).toEqual([]);
  });

  it('puts the held-back findings first and still settles all of them together', async () => {
    db.pending = [
      { id: 'n1', reason: 'quiet_hours' },
      { id: 'n2', reason: 'quiet_hours' },
    ];
    db.rows['t-g'] = [article('d', TODAY)];
    const channel = notifier();
    channel.send.mockResolvedValueOnce({ delivered: false, error: 'telegram down' } as never);

    const result = await sendDigest(USER as never, channel as never, NOW);

    const [message] = channel.send.mock.calls[0]! as unknown as [{ title: string; body: string }];
    expect(message.title).toBe('Daily digest: 2 findings, 3 topics');
    expect(message.body.startsWith('2 held during quiet hours\n\nTopics\n')).toBe(true);
    expect(result).toMatchObject({ entries: 2, delivered: false, error: 'telegram down' });
    expect(db.settled).toEqual([
      { id: 'n1', status: 'failed' },
      { id: 'n2', status: 'failed' },
    ]);
  });
});
