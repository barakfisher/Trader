/**
 * The long-poll transport: the reason a tap in Telegram now reaches the ledger
 * at all on an installation with no public webhook URL.
 *
 * No network: the client takes its `fetch` as an argument, so each test scripts
 * what Telegram answers and records what was asked.
 */

import { describe, expect, it, vi } from 'vitest';

import { TelegramNotifier } from '../src/telegram/client.js';
import { TelegramPoller } from '../src/telegram/poller.js';

type Scripted = { status: number; body: unknown };

function pollerWith(answers: Scripted[]) {
  const requests: Record<string, unknown>[] = [];
  const telegram = new TelegramNotifier({
    botToken: 'bot-token',
    callbackSecret: 'a-signing-secret-long-enough',
    resolveChatId: async () => null,
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body ?? '{}')));
      const answer = answers.shift() ?? { status: 200, body: { ok: true, result: [] } };
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    },
  });
  const handled: number[] = [];
  const poller = new TelegramPoller(telegram, {
    handle: vi.fn(async (update) => {
      handled.push(update.update_id);
    }),
    sleep: async () => undefined,
  });
  return { poller, requests, handled };
}

const updates = (...ids: number[]) => ({
  status: 200,
  body: { ok: true, result: ids.map((id) => ({ update_id: id })) },
});

describe('TelegramPoller', () => {
  it('hands every update to the handler, in order', async () => {
    const { poller, handled } = pollerWith([updates(7, 8, 9)]);
    expect(await poller.pollOnce()).toBe(true);
    expect(handled).toEqual([7, 8, 9]);
  });

  it('confirms what it handled by asking for the next offset', async () => {
    // Without the offset Telegram re-sends the same updates for ever, and every
    // tap would be re-applied on every poll.
    const { poller, requests } = pollerWith([updates(41, 42), updates()]);
    await poller.pollOnce();
    await poller.pollOnce();
    expect(requests[0]).not.toHaveProperty('offset');
    expect(requests[1]).toMatchObject({ offset: 43 });
  });

  it('asks only for the update kinds the handler understands', async () => {
    const { poller, requests } = pollerWith([updates()]);
    await poller.pollOnce();
    expect(requests[0]).toMatchObject({ allowed_updates: ['message', 'callback_query'] });
  });

  it('reports a conflict with a registered webhook as a failed poll', async () => {
    const { poller, handled } = pollerWith([
      { status: 409, body: { ok: false, description: 'Conflict: webhook is active' } },
    ]);
    expect(await poller.pollOnce()).toBe(false);
    expect(handled).toEqual([]);
  });

  it('does not advance the offset past a poll that failed', async () => {
    const { poller, requests } = pollerWith([
      updates(5),
      { status: 502, body: { ok: false } },
      updates(),
    ]);
    await poller.pollOnce();
    await poller.pollOnce();
    await poller.pollOnce();
    expect(requests[2]).toMatchObject({ offset: 6 });
  });
});
