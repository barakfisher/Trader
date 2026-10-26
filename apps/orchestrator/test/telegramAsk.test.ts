/**
 * Asking the assistant from Telegram (D221-D224): a message that is not a
 * command is a question, sent through the Ask page's own call, in the chat's
 * rolling conversation, and answered in the question's language.
 *
 * No network: the Telegram client records what it would send, and the AI
 * client is a stub whose `assistantMessage` each test scripts.
 */

import type { AssistantReply } from '@traders/shared/ai';
import { AiServiceError } from '@traders/shared/ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RATE_LIMITS, memoryRateLimits, userKey } from '../src/http/rateLimits.js';

const USER = '00000000-0000-0000-0000-000000000001';
const CHAT = 987654321;
const CONVERSATION = '80000000-0000-0000-0000-000000000001';
const LATER = '80000000-0000-0000-0000-000000000002';

vi.mock('../src/db/queries.js', () => ({
  findTelegramBindingByChat: vi.fn(async () => ({ user_id: USER, chat_id: String(CHAT), legal_accepted: true })),
  findTelegramConversation: vi.fn(async () => null),
  setTelegramConversation: vi.fn(async () => undefined),
  getOrCreateUserSettings: vi.fn(async () => ({ language: 'en', notify_severity: 'high' })),
  getUser: vi.fn(async () => ({ id: USER, timezone: 'Asia/Jerusalem', base_currency: 'USD' })),
}));

const queries = await import('../src/db/queries.js');
const { handleTelegramUpdate } = await import('../src/telegram/updates.js');
const { MAX_QUESTION_CHARS, QUIET_HOURS, minutesOf, startQuestion } = await import('../src/telegram/assistantQuestion.js');
const { TelegramNotifier } = await import('../src/telegram/client.js');
const { MESSAGES } = await import('../src/notify/messages.js');
const { MAX_NEWS_SOURCES, flattenMarkdown, plainAnswer } = await import('../src/telegram/plainAnswer.js');
const { loadConfig, resetConfigForTests } = await import('../src/config.js');

const ENV = {
  APP_ENV: 'test',
  LOG_LEVEL: 'error',
  SESSION_SECRET: 'test-session-secret-value',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  AI_SERVICE_URL: 'http://ai-service:8000',
  INTERNAL_API_KEY: 'internal-test-key',
  TELEGRAM_BOT_TOKEN: 'bot-token',
  TELEGRAM_SIGNING_SECRET: 'a-signing-secret-long-enough',
} as unknown as NodeJS.ProcessEnv;

function reply(overrides: Partial<AssistantReply> = {}): AssistantReply {
  return {
    conversation_id: CONVERSATION,
    message_id: 'm1',
    outcome: 'answer',
    reason: null,
    text: 'Your portfolio is up **5.00%**. See [Insights](/insights).',
    sources: [],
    suggestions: ['Which holding moved most?'],
    model: 'm',
    cost_micro_usd: 100,
    steps: 1,
    ...overrides,
  };
}

let sent: { method: string; body: Record<string, unknown> }[] = [];
const assistantMessage = vi.fn();

function deps(webBaseUrl: string | null = null) {
  resetConfigForTests();
  const notifier = new TelegramNotifier({
    botToken: 'bot-token',
    callbackSecret: 'a-signing-secret-long-enough',
    resolveChatId: async () => String(CHAT),
    webBaseUrl,
    fetchImpl: async (url, init) => {
      sent.push({ method: url.split('/').pop() as string, body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response('{"ok":true}', { status: 200 });
    },
  });
  return { config: loadConfig(ENV), notifier, ai: { assistantMessage } as never, rateLimits: memoryRateLimits() };
}

const message = (text?: string) => ({ message: { chat: { id: CHAT, type: 'private' }, ...(text === undefined ? {} : { text }) } });
const messagesSent = () => sent.filter((call) => call.method === 'sendMessage').map((call) => call.body);

/** Ask, and wait for the answer: the update returns before it arrives. */
async function askAndWait(text: string, webBaseUrl: string | null = null) {
  const d = deps(webBaseUrl);
  const { done } = await startQuestion({
    telegram: d.notifier,
    ai: d.ai,
    userId: USER,
    chatId: String(CHAT),
    question: text,
    rateLimits: d.rateLimits,
  });
  await done;
}

beforeEach(() => {
  sent = [];
  vi.clearAllMocks();
  assistantMessage.mockResolvedValue(reply());
});
afterEach(() => vi.useRealTimers());

describe('a question in the chat', () => {
  it("goes to the Ask page's call with the bound user, and the answer comes back with its suggestions", async () => {
    await askAndWait('How am I doing?');

    expect(assistantMessage).toHaveBeenCalledWith({ user_id: USER, conversation_id: null, message: 'How am I doing?' });
    expect(sent[0]).toEqual({ method: 'sendChatAction', body: { chat_id: String(CHAT), action: 'typing' } });
    const [answer] = messagesSent();
    expect(answer!.text).toBe('Your portfolio is up 5.00%. See Insights.');
    expect(answer!.reply_markup).toEqual({
      keyboard: [[{ text: 'Which holding moved most?' }]],
      one_time_keyboard: true,
      resize_keyboard: true,
    });
  });

  it('joins the chat\'s conversation while it is recent, and remembers the one it landed in (D222)', async () => {
    vi.mocked(queries.findTelegramConversation).mockResolvedValueOnce(CONVERSATION);
    assistantMessage.mockResolvedValueOnce(reply({ conversation_id: CONVERSATION }));
    await askAndWait('And this week?');

    expect(queries.findTelegramConversation).toHaveBeenCalledWith(USER, QUIET_HOURS);
    expect(assistantMessage).toHaveBeenCalledWith(expect.objectContaining({ conversation_id: CONVERSATION }));
    expect(queries.setTelegramConversation).toHaveBeenCalledWith(USER, CONVERSATION);
  });

  it('starts afresh when the conversation was deleted on the Ask page meanwhile', async () => {
    vi.mocked(queries.findTelegramConversation).mockResolvedValueOnce(CONVERSATION);
    assistantMessage
      .mockRejectedValueOnce(new AiServiceError('conversation not found', 404))
      .mockResolvedValueOnce(reply({ conversation_id: LATER }));
    await askAndWait('And this week?');

    expect(assistantMessage.mock.calls.map(([payload]) => payload.conversation_id)).toEqual([CONVERSATION, null]);
    expect(queries.setTelegramConversation).toHaveBeenCalledWith(USER, LATER);
  });

  it('says the assistant could not be reached when the AI service fails, in the question\'s language', async () => {
    assistantMessage.mockRejectedValueOnce(new AiServiceError('down', 502));
    await askAndWait('מה שווה התיק שלי?');

    expect(messagesSent().map((m) => m.text)).toEqual([MESSAGES.he.ask.unavailable]);
    expect(queries.setTelegramConversation).not.toHaveBeenCalled();
  });

  it("counts with the Ask page's limit and, once it is spent, says when to try again in the question's language (D257)", async () => {
    const d = deps();
    for (let point = 0; point < RATE_LIMITS.assistantQuestion.points; point += 1) {
      await d.rateLimits.take('assistantQuestion', userKey(USER));
    }
    const { done } = await startQuestion({
      telegram: d.notifier,
      ai: d.ai,
      userId: USER,
      chatId: String(CHAT),
      question: 'מה שווה התיק שלי?',
      rateLimits: d.rateLimits,
    });
    await done;

    expect(assistantMessage).not.toHaveBeenCalled();
    expect(messagesSent().map((m) => m.text)).toEqual([
      MESSAGES.he.rateLimited(minutesOf(RATE_LIMITS.assistantQuestion.durationSeconds)),
    ]);
  });

  it('refuses a question past the bound before any call', async () => {
    await askAndWait('x'.repeat(MAX_QUESTION_CHARS + 1));

    expect(assistantMessage).not.toHaveBeenCalled();
    expect(messagesSent().map((m) => m.text)).toEqual([MESSAGES.en.ask.tooLong(MAX_QUESTION_CHARS)]);
  });

  it('answers one question per chat at a time, and refuses the second rather than queueing it', async () => {
    let release!: (value: AssistantReply) => void;
    assistantMessage.mockReturnValueOnce(new Promise<AssistantReply>((resolve) => (release = resolve)));
    const d = deps();
    const input = { telegram: d.notifier, ai: d.ai, userId: USER, chatId: String(CHAT), rateLimits: d.rateLimits };
    const first = await startQuestion({ ...input, question: 'First?' });
    await startQuestion({ ...input, question: 'Second?' });

    expect(messagesSent().map((m) => m.text)).toEqual([MESSAGES.en.ask.stillAnswering]);
    release(reply());
    await first.done;
    expect(assistantMessage).toHaveBeenCalledTimes(1);

    // Once answered, the chat may ask again.
    await askAndWait('Third?');
    expect(assistantMessage).toHaveBeenCalledTimes(2);
  });

  it('is started by the update handler for text that is not a command, and returns before the answer', async () => {
    let release!: (value: AssistantReply) => void;
    assistantMessage.mockReturnValueOnce(new Promise<AssistantReply>((resolve) => (release = resolve)));
    await handleTelegramUpdate(deps(), message('How am I doing?'));

    await vi.waitFor(() => expect(assistantMessage).toHaveBeenCalledTimes(1));
    expect(messagesSent()).toEqual([]);
    release(reply());
    await vi.waitFor(() => expect(messagesSent()).toHaveLength(1));
  });

  it('is ignored in silence from an unbound chat', async () => {
    vi.mocked(queries.findTelegramBindingByChat).mockResolvedValueOnce(null);
    await handleTelegramUpdate(deps(), message('How am I doing?'));

    expect(assistantMessage).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
});

describe('the commands around it', () => {
  it('/new forgets the conversation; the next question starts one', async () => {
    await handleTelegramUpdate(deps(), message('/new'));

    expect(queries.setTelegramConversation).toHaveBeenCalledWith(USER, null);
    expect(messagesSent().map((m) => m.text)).toEqual([MESSAGES.en.ask.newConversation]);
  });

  it('a photo or a voice note is answered with what the bot can read', async () => {
    await handleTelegramUpdate(deps(), message());

    expect(assistantMessage).not.toHaveBeenCalled();
    expect(messagesSent().map((m) => m.text)).toEqual([MESSAGES.en.ask.textOnly]);
  });

  it.each(['/help', '/teapot'])('%s shows the help, and the help says to write a question', async (command) => {
    await handleTelegramUpdate(deps(), message(command));

    expect(assistantMessage).not.toHaveBeenCalled();
    expect(messagesSent().map((m) => m.text)).toEqual([MESSAGES.en.menu.help]);
    expect(MESSAGES.en.menu.help).toContain('/new');
    expect(MESSAGES.en.menu.help).toContain('Write any question');
  });
});

describe('the reply as plain text (D223)', () => {
  it('flattens markdown: emphasis, headings, bullets, code and links lose their marks', () => {
    expect(
      flattenMarkdown('## Movers\n- **NVDA** fell *sharply*\n* `AAPL` rose\nSee [Agents](/agents) and [Reuters](https://r.example/1).', null),
    ).toBe('Movers\n• NVDA fell sharply\n• AAPL rose\nSee Agents and Reuters (https://r.example/1).');
  });

  it("gives an app page its address only when the installation has a public one", () => {
    expect(flattenMarkdown('[Insights](/insights)', 'https://traders.example.com')).toBe(
      'Insights (https://traders.example.com/insights)',
    );
  });

  it(`lists at most ${MAX_NEWS_SOURCES} news sources with their URLs, and leaves pages and data out`, () => {
    const news = Array.from({ length: MAX_NEWS_SOURCES + 2 }, (_, i) => ({
      kind: 'news' as const,
      label: `Reuters: story ${i}`,
      url: `https://r.example/${i}`,
    }));
    const text = plainAnswer(
      reply({ text: 'Chips slid.', sources: [{ kind: 'page', label: 'Portfolio', link: '/' }, ...news] }),
      MESSAGES.en,
      null,
    );

    expect(text.split('\n')).toEqual([
      'Chips slid.',
      '',
      MESSAGES.en.ask.sources,
      ...news.slice(0, MAX_NEWS_SOURCES).flatMap((s) => [`• ${s.label}`, s.url]),
    ]);
  });

  it('marks an answer that ran on a fallback model, under it (D284)', () => {
    const text = plainAnswer(reply({ text: 'Chips slid.', fallback_from: 'acme/retired-1' }), MESSAGES.en, null);

    expect(text).toBe(`Chips slid.\n\n${MESSAGES.en.modelFallback.answerMark('acme/retired-1')}`);
  });

  it("says the catalogue's sentence for an outcome with no reply, in the language given (D224)", () => {
    for (const outcome of ['failed', 'budget_reached', 'cap_reached', 'no_model', 'own_key_failed'] as const) {
      expect(plainAnswer(reply({ outcome, text: 'English server text' }), MESSAGES.he, null)).toBe(
        MESSAGES.he.ask.noReply[outcome],
      );
    }
  });

  it("a Hebrew question's refusal is Hebrew whatever the settings language", async () => {
    assistantMessage.mockResolvedValueOnce(reply({ outcome: 'budget_reached', text: 'x', suggestions: [] }));
    await askAndWait('מה שווה התיק שלי?');

    const [answer] = messagesSent();
    expect(answer!.text).toBe(MESSAGES.he.ask.noReply.budget_reached);
    expect(answer!.reply_markup).toEqual({ remove_keyboard: true });
  });

  it('a decline is shown as the model wrote it', async () => {
    assistantMessage.mockResolvedValueOnce(
      reply({ outcome: 'decline', reason: 'advice', text: 'אני לא אומר מה לקנות.', suggestions: [] }),
    );
    await askAndWait('לקנות NVDA?');

    expect(messagesSent()[0]!.text).toBe('אני לא אומר מה לקנות.');
  });
});
