/**
 * Redrawing a proposal's Telegram messages after it changed elsewhere (D427).
 *
 * The bug this pins: a trade approved for the open from a Telegram message kept
 * *Cancel approval* on that message after the open had filled it, because
 * nothing knew which message to edit. The message is now remembered when tapped,
 * and redrawn from the proposal's row when the open settles the approval.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '00000000-0000-0000-0000-000000000001';
const PROPOSAL = '11111111-2222-3333-4444-555555555555';
const CHAT = '987654321';
const OPENS_AT = new Date('2026-11-23T14:30:00Z');
const AFTER_OPEN = new Date('2026-11-23T14:31:00Z');
const SIGNING_SECRET = 'a-signing-secret-long-enough';

let row: Record<string, unknown> | null;
let stored: { chat_id: string; message_id: string; back_to_pending: boolean }[];

vi.mock('../src/db/queries.js', () => ({
  findProposal: vi.fn(async () => row),
  getOrCreateUserSettings: vi.fn(async () => ({ language: 'he' })),
  listTelegramProposalMessages: vi.fn(async () => stored),
}));

vi.mock('../src/logger.js', () => ({
  logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { TelegramNotifier } = await import('../src/telegram/client.js');
const { MESSAGES } = await import('../src/notify/messages.js');
const { redrawProposalMessages } = await import('../src/telegram/proposalMessages.js');

function proposalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROPOSAL,
    user_id: USER,
    kind: 'buy',
    state: 'approved',
    expires_at: new Date(OPENS_AT.getTime() + 3_600_000),
    snoozed_until: null,
    decided_at: AFTER_OPEN,
    opens_at: OPENS_AT,
    open_approval: 'filled',
    ...overrides,
  };
}

let calls: { method: string; body: Record<string, unknown> }[];

function telegram() {
  return new TelegramNotifier({
    botToken: 'bot-token',
    callbackSecret: SIGNING_SECRET,
    resolveChatId: async () => CHAT,
    fetchImpl: async (url, init) => {
      calls.push({ method: url.split('/').pop() as string, body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response('{"ok":true}', { status: 200 });
    },
  });
}

type Button = { text: string };
const labels = (call: { body: Record<string, unknown> }) =>
  (call.body.reply_markup as { inline_keyboard: Button[][] }).inline_keyboard.flat().map((button) => button.text);

beforeEach(() => {
  calls = [];
  row = proposalRow();
  stored = [{ chat_id: CHAT, message_id: '99', back_to_pending: false }];
});

describe('redrawing a proposal message', () => {
  it('takes Cancel approval off the tapped message once the open filled it', async () => {
    await redrawProposalMessages(telegram(), USER, PROPOSAL, AFTER_OPEN);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('editMessageReplyMarkup');
    expect(calls[0]!.body).toMatchObject({ chat_id: CHAT, message_id: 99 });
    expect(labels(calls[0]!)).not.toContain(MESSAGES.he.openApproval.cancelButton);
    expect(labels(calls[0]!)).not.toContain(MESSAGES.he.buttons.reject);
  });

  it('brings Approve and Reject back when the open refused it', async () => {
    row = proposalRow({ state: 'pending', decided_at: null, open_approval: 'refused' });
    await redrawProposalMessages(telegram(), USER, PROPOSAL, AFTER_OPEN);
    expect(labels(calls[0]!)).toEqual(expect.arrayContaining([MESSAGES.he.buttons.approve, MESSAGES.he.buttons.reject]));
    expect(labels(calls[0]!)).not.toContain(MESSAGES.he.openApproval.cancelButton);
  });

  it('keeps the way back to /pending on a message opened from it', async () => {
    stored = [{ chat_id: CHAT, message_id: '99', back_to_pending: true }];
    await redrawProposalMessages(telegram(), USER, PROPOSAL, AFTER_OPEN);
    expect(labels(calls[0]!)).toContain(MESSAGES.he.menu.buttons.backToPending);
  });

  it('edits every message remembered for the proposal', async () => {
    stored = [
      { chat_id: CHAT, message_id: '99', back_to_pending: false },
      { chat_id: CHAT, message_id: '120', back_to_pending: true },
    ];
    await redrawProposalMessages(telegram(), USER, PROPOSAL, AFTER_OPEN);
    expect(calls.map((call) => call.body.message_id)).toEqual([99, 120]);
  });

  it('does nothing without Telegram, or with no message remembered', async () => {
    await redrawProposalMessages({ channel: 'none', send: vi.fn() }, USER, PROPOSAL, AFTER_OPEN);
    stored = [];
    await redrawProposalMessages(telegram(), USER, PROPOSAL, AFTER_OPEN);
    expect(calls).toHaveLength(0);
  });

  it('never throws: a failed edit is the message, not the fill', async () => {
    vi.mocked((await import('../src/db/queries.js')).listTelegramProposalMessages).mockRejectedValueOnce(
      new Error('database down'),
    );
    await expect(redrawProposalMessages(telegram(), USER, PROPOSAL, AFTER_OPEN)).resolves.toBeUndefined();
  });
});
