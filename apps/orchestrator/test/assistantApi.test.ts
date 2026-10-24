/**
 * The assistant's routes (migration 0052): the question passed through with the
 * signed-in user, every outcome a 200, and conversations listed, read back and
 * deleted only for their owner.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIVE_SESSION, sessionCookie } from './session.js';

const USER_ID = '00000000-0000-0000-0000-000000000001';
const CONVERSATION = '80000000-0000-0000-0000-000000000001';

vi.mock('../src/db/pool.js', () => ({
  queryOne: vi.fn(async () => ({ ok: 1 })),
  query: vi.fn(async () => []),
  transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
  initPool: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../src/db/queries.js', () => ({
  getSessionUser: vi.fn(async (userId: string) => (await import('./session.js')).mockedSessionUser(userId)),
  getUser: vi.fn(async () => ({
    ...ACTIVE_SESSION,
    id: USER_ID,
    email: null,
    base_currency: 'USD',
    timezone: 'Asia/Jerusalem',
  })),
  listAssistantConversations: vi.fn(async () => [
    {
      id: CONVERSATION,
      title: 'How is my portfolio?',
      created_at: new Date('2026-10-12T08:00:00Z'),
      updated_at: new Date('2026-10-12T08:01:00Z'),
    },
  ]),
  getAssistantConversation: vi.fn(async () => null),
  listAssistantMessages: vi.fn(async () => []),
  deleteAssistantConversation: vi.fn(async () => false),
}));

const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');
const { AiServiceError } = await import('@traders/shared/ai');
const queries = await import('../src/db/queries.js');

const ENV = {
  APP_ENV: 'test',
  LOG_LEVEL: 'error',
  SESSION_SECRET: 'test-session-secret-value',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  AI_SERVICE_URL: 'http://ai-service:8000',
  INTERNAL_API_KEY: 'internal-test-key',
  ALLOWED_ORIGINS: 'http://localhost:5173',
} as unknown as NodeJS.ProcessEnv;

const HEADERS = { origin: 'http://localhost:5173', 'content-type': 'application/json' };

const assistantMessage = vi.fn();

const REPLY = {
  conversation_id: CONVERSATION,
  message_id: '81000000-0000-0000-0000-000000000001',
  outcome: 'answer',
  reason: null,
  text: 'Up 5.00% over 7 days.',
  sources: [{ kind: 'page', label: 'Portfolio', link: '/', url: null, published: null }],
  suggestions: ['Which holding moved most?'],
  model: 'google/gemini-3.5-flash-lite',
  cost_micro_usd: 1200,
  steps: 1,
};

describe('the assistant routes', () => {
  let app: ReturnType<typeof createApp>;
  let cookie: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetConfigForTests();
    app = createApp(loadConfig(ENV), { assistantMessage } as never);
    cookie = sessionCookie();
  });

  const send = (body: unknown) =>
    app.request('/assistant/messages', {
      method: 'POST',
      headers: { ...HEADERS, cookie },
      body: JSON.stringify(body),
    });

  it('passes the question on with the signed-in user, and answers in camelCase', async () => {
    assistantMessage.mockResolvedValue(REPLY);

    const response = await send({ message: 'How did I do this week?', conversationId: CONVERSATION });

    expect(response.status).toBe(200);
    expect(assistantMessage).toHaveBeenCalledWith(
      { user_id: USER_ID, conversation_id: CONVERSATION, message: 'How did I do this week?' },
      expect.any(String),
    );
    expect(await response.json()).toEqual({
      conversationId: CONVERSATION,
      messageId: REPLY.message_id,
      outcome: 'answer',
      reason: null,
      text: REPLY.text,
      sources: [{ kind: 'page', label: 'Portfolio', link: '/', url: null, published: null }],
      suggestions: ['Which holding moved most?'],
      fallbackFrom: null,
    });
  });

  it("does not send the model's name or the cost to the browser", async () => {
    assistantMessage.mockResolvedValue(REPLY);

    const body = await (await send({ message: 'Hi' })).json();

    expect(body).not.toHaveProperty('model');
    expect(body).not.toHaveProperty('costMicroUsd');
  });

  it("names the user's own chosen model when the answer ran on a fallback (D284)", async () => {
    assistantMessage.mockResolvedValue({ ...REPLY, fallback_from: 'acme/retired-1' });

    const body = await (await send({ message: 'Hi' })).json();

    expect(body.fallbackFrom).toBe('acme/retired-1');
  });

  it('passes a decline and a spent budget through as 200s, not errors', async () => {
    for (const outcome of [
      { outcome: 'decline', reason: 'off_domain' },
      { outcome: 'budget_reached', reason: null },
      { outcome: 'no_model', reason: null },
    ]) {
      assistantMessage.mockResolvedValue({ ...REPLY, ...outcome, sources: [], suggestions: [] });
      const response = await send({ message: "What's the weather?" });
      expect(response.status, outcome.outcome).toBe(200);
      expect(await response.json()).toMatchObject(outcome);
    }
  });

  it('starts a new conversation when none is named', async () => {
    assistantMessage.mockResolvedValue(REPLY);

    await send({ message: 'Hello' });

    expect(assistantMessage.mock.calls[0]![0]).toMatchObject({ conversation_id: null });
  });

  it("answers another user's conversation with a 404, as the AI service does", async () => {
    assistantMessage.mockRejectedValue(new AiServiceError('not found', 404));

    expect((await send({ message: 'Hi', conversationId: CONVERSATION })).status).toBe(404);
  });

  it('refuses a body it does not understand before calling the AI service', async () => {
    for (const body of [{}, { message: 3 }, { message: 'x'.repeat(2001) }, { message: 'Hi', conversationId: 'nope' }]) {
      expect((await send(body)).status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    expect(assistantMessage).not.toHaveBeenCalled();
  });

  it('lists conversations, newest first', async () => {
    const response = await app.request('/assistant/conversations', { headers: { ...HEADERS, cookie } });

    expect(await response.json()).toEqual({
      conversations: [
        {
          id: CONVERSATION,
          title: 'How is my portfolio?',
          createdAt: '2026-10-12T08:00:00.000Z',
          updatedAt: '2026-10-12T08:01:00.000Z',
        },
      ],
    });
    expect(queries.listAssistantConversations).toHaveBeenCalledWith(USER_ID, expect.any(Number));
  });

  it('reads a conversation back with its messages, scoped to the user', async () => {
    vi.mocked(queries.getAssistantConversation).mockResolvedValue({
      id: CONVERSATION,
      title: 'Hi',
      created_at: new Date('2026-10-12T08:00:00Z'),
      updated_at: new Date('2026-10-12T08:01:00Z'),
    });
    vi.mocked(queries.listAssistantMessages).mockResolvedValue([
      {
        id: 'm1',
        role: 'user',
        content: 'Hi',
        outcome: null,
        reason: null,
        sources: [],
        suggestions: [],
        created_at: new Date('2026-10-12T08:00:00Z'),
      },
      {
        id: 'm2',
        role: 'assistant',
        content: 'Hello.',
        outcome: 'answer',
        reason: null,
        sources: [{ kind: 'news', label: 'Reuters: x', url: 'https://r.example/1' }],
        suggestions: ['Why?'],
        created_at: new Date('2026-10-12T08:01:00Z'),
      },
    ]);

    const response = await app.request(`/assistant/conversations/${CONVERSATION}`, { headers: { ...HEADERS, cookie } });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    expect(body.messages[1].sources).toEqual([
      { kind: 'news', label: 'Reuters: x', url: 'https://r.example/1', link: null, published: null },
    ]);
    expect(queries.getAssistantConversation).toHaveBeenCalledWith(USER_ID, CONVERSATION);
  });

  it("answers a conversation that is missing, malformed or someone else's with a 404", async () => {
    // The queries are scoped by user, so another user's conversation reads as none.
    vi.mocked(queries.getAssistantConversation).mockResolvedValue(null);
    vi.mocked(queries.deleteAssistantConversation).mockResolvedValue(false);
    for (const id of [CONVERSATION, 'not-a-uuid']) {
      const read = await app.request(`/assistant/conversations/${id}`, { headers: { ...HEADERS, cookie } });
      const removed = await app.request(`/assistant/conversations/${id}`, {
        method: 'DELETE',
        headers: { ...HEADERS, cookie },
      });
      expect([read.status, removed.status], id).toEqual([404, 404]);
    }
  });

  it('deletes a conversation of its owner', async () => {
    vi.mocked(queries.deleteAssistantConversation).mockResolvedValue(true);

    const response = await app.request(`/assistant/conversations/${CONVERSATION}`, {
      method: 'DELETE',
      headers: { ...HEADERS, cookie },
    });

    expect(response.status).toBe(204);
    expect(queries.deleteAssistantConversation).toHaveBeenCalledWith(USER_ID, CONVERSATION);
  });

  it('is for a signed-in user only', async () => {
    const response = await app.request('/assistant/conversations', { headers: HEADERS });
    expect(response.status).toBe(401);
  });
});
