/**
 * The "Open in app" link on a Telegram proposal (FR-21).
 *
 * Pinned: the link appears only for an address Telegram will accept - it
 * refuses the whole message over a bad URL button, so a local http address must
 * never reach a send - and it survives every keyboard, a decided proposal's
 * included, because the page is where the audit trail lives.
 */

import { describe, expect, it } from 'vitest';

import { OPEN_IN_APP_LABEL, TelegramNotifier, proposalLinkBase } from '../src/telegram/client.js';

type Button = { text: string; url?: string; callback_data?: string };

function notifierWith(webBaseUrl: string | null) {
  const calls: { method: string; body: { reply_markup?: { inline_keyboard: Button[][] } } }[] = [];
  const notifier = new TelegramNotifier({
    botToken: 'bot-token',
    callbackSecret: 'callback-secret-value',
    resolveChatId: async () => '42',
    webBaseUrl,
    fetchImpl: async (url, init) => {
      calls.push({ method: url.split('/').pop()!, body: JSON.parse(String(init?.body)) });
      return new Response('{"ok":true,"result":{"message_id":7}}', { status: 200 });
    },
  });
  return { notifier, calls };
}

const PROPOSAL = '3549bea4-e409-48e5-bd90-bfefeaf6a6df';

describe('proposalLinkBase', () => {
  it.each([
    ['https://traders.example.com', 'https://traders.example.com'],
    ['https://traders.example.com/', 'https://traders.example.com'],
    ['https://example.com/app/', 'https://example.com/app'],
  ])('accepts a public https address: %s', (value, expected) => {
    expect(proposalLinkBase(value)).toBe(expected);
  });

  it.each([
    undefined,
    '',
    'http://traders.example.com',
    'https://127.0.0.1:5174',
    'https://localhost',
    'http://127.0.0.1:5174',
    'not a url',
  ])('refuses what Telegram would refuse: %s', (value) => {
    expect(proposalLinkBase(value)).toBeNull();
  });
});

describe('a proposal message', () => {
  const lastKeyboard = (calls: ReturnType<typeof notifierWith>['calls']) =>
    calls.at(-1)?.body.reply_markup?.inline_keyboard ?? [];

  it('carries the three decisions and a link to its page', async () => {
    const { notifier, calls } = notifierWith('https://traders.example.com');
    await notifier.send({
      userId: 'u',
      title: 'BTC-USD drifted',
      body: '',
      proposalId: PROPOSAL,
      severity: 'high',
    });

    const keyboard = lastKeyboard(calls);
    expect(keyboard).toHaveLength(2);
    expect(keyboard[0]!.every((button) => button.callback_data)).toBe(true);
    expect(keyboard[1]).toEqual([
      { text: OPEN_IN_APP_LABEL, url: `https://traders.example.com/proposals/${PROPOSAL}` },
    ]);
  });

  it('keeps only the link once the proposal is decided', async () => {
    const { notifier, calls } = notifierWith('https://traders.example.com');
    await notifier.editMessage('42', 7, 'Rejected', { proposalId: PROPOSAL, keyboard: 'none' });
    expect(lastKeyboard(calls)).toEqual([
      [{ text: OPEN_IN_APP_LABEL, url: `https://traders.example.com/proposals/${PROPOSAL}` }],
    ]);
  });

  it('is unchanged without an address: no link, and a decided message loses every button', async () => {
    const { notifier, calls } = notifierWith(null);
    await notifier.send({ userId: 'u', title: 't', body: '', proposalId: PROPOSAL, severity: 'high' });
    expect(lastKeyboard(calls)).toHaveLength(1);
    await notifier.editMessage('42', 7, 'Rejected', { proposalId: PROPOSAL, keyboard: 'none' });
    expect(lastKeyboard(calls)).toEqual([]);
  });
});
