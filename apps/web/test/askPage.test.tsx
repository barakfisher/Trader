// @vitest-environment jsdom
/**
 * The /ask screen: the assistant's conversation, rendered at its address.
 *
 * Pinned: a reply's markdown is rendered (links through the router, outside
 * links in a new tab), with the sources the server built and questions to ask
 * next that fill the box and are not sent; a follow-up carries the
 * conversation's id; a decline says why and the three no-reply outcomes are
 * said in the page's language - none of them an error; only a failure to get
 * any reply is, with a retry; one question at a time; conversations are listed,
 * opened and deleted; and signing out forgets the conversation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';

import type { AssistantConversationResponse, AssistantReplyView, OwnLlmKeyResponse } from '@traders/shared';

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>('../src/api/client.ts');
  return { ...actual, api: { get, post, put: vi.fn(), delete: del, postForm: vi.fn() } };
});

const { ApiRequestError } = await import('../src/api/client.ts');
const { App } = await import('../src/App.tsx');
const { createAppRouter } = await import('../src/router.tsx');
const { renderWithServerState } = await import('./serverStateHarness.tsx');

const CONVERSATION = '80000000-0000-0000-0000-000000000001';

function reply(overrides: Partial<AssistantReplyView> = {}): AssistantReplyView {
  return {
    conversationId: CONVERSATION,
    messageId: 'm1',
    outcome: 'answer',
    reason: null,
    text: 'Your portfolio is up **5.00%** over 7 days. See [Insights](/insights).',
    sources: [
      { kind: 'page', label: 'Portfolio', link: '/', url: null, published: null },
      { kind: 'news', label: 'Reuters: Chips slide', link: null, url: 'https://r.example/1', published: null },
    ],
    suggestions: ['Which holding moved most?'],
    ...overrides,
  };
}

const CONVERSATIONS = {
  conversations: [
    { id: CONVERSATION, title: 'How am I doing?', createdAt: '2026-10-12T08:00:00Z', updatedAt: '2026-10-12T08:01:00Z' },
  ],
};

function renderAsk() {
  const router = createAppRouter(createMemoryHistory({ initialEntries: ['/ask'] }));
  const result = renderWithServerState(<App router={router} />);
  act(() => {
    result.root.auth.user = { id: 'u', baseCurrency: 'USD', timezone: 'Asia/Jerusalem' } as never;
    result.root.auth.initialised = true;
  });
  return { ...result, router };
}

async function ask(text: string) {
  const box = await screen.findByLabelText('Your question');
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  window.scrollTo = () => {};
  get.mockImplementation((path: string) =>
    path === '/assistant/conversations' ? Promise.resolve(CONVERSATIONS) : new Promise(() => {}),
  );
});
afterEach(cleanup);

describe('a reply', () => {
  it('renders its markdown, its sources and what to ask next', async () => {
    post.mockResolvedValueOnce(reply());
    renderAsk();
    await ask('How am I doing?');

    expect(await screen.findByText('5.00%')).toBeTruthy();
    expect(screen.getByText('5.00%').tagName).toBe('STRONG');
    const replyText = within(screen.getByText('5.00%').closest('div')!);
    expect(replyText.getByRole('link', { name: 'Insights' }).getAttribute('href')).toBe('/insights');
    const news = screen.getByRole('link', { name: /Reuters: Chips slide/ });
    expect(news.getAttribute('target')).toBe('_blank');
    expect(news.getAttribute('rel')).toContain('noopener');
    expect(screen.getByText('Sources (2)')).toBeTruthy();
    expect(post).toHaveBeenCalledWith('/assistant/messages', { message: 'How am I doing?' });
  });

  it('marks a reply with the language it is written in, not the page language (D220)', async () => {
    post.mockResolvedValueOnce(
      reply({ text: 'התיק שלך עלה ב־**5.00%** בשבוע האחרון.', sources: [], suggestions: ['איזו החזקה זזה הכי הרבה?'] }),
    );
    renderAsk();
    await ask('איך התיק שלי?');

    const answer = (await screen.findByText('5.00%')).closest('div[lang]')!;
    expect(answer.getAttribute('lang')).toBe('he');
    expect(answer.getAttribute('dir')).toBe('auto');
    expect(screen.getByRole('button', { name: 'איזו החזקה זזה הכי הרבה?' }).getAttribute('lang')).toBe('he');
  });

  it('never renders HTML or an image from the text', async () => {
    post.mockResolvedValueOnce(
      reply({ text: 'Hi <img src="x" onerror="alert(1)"> ![pic](https://x.example/p.png) <b>bold</b>', sources: [] }),
    );
    const { container } = renderAsk();
    await ask('Hi');

    await screen.findByText(/Hi/, { selector: 'p' });
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
  });

  it('fills the box with a suggestion and does not send it', async () => {
    post.mockResolvedValueOnce(reply());
    renderAsk();
    await ask('How am I doing?');

    fireEvent.click(await screen.findByRole('button', { name: 'Which holding moved most?' }));
    expect((screen.getByLabelText('Your question') as HTMLTextAreaElement).value).toBe('Which holding moved most?');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('sends a follow-up in the same conversation', async () => {
    post.mockResolvedValueOnce(reply()).mockResolvedValueOnce(reply({ text: 'NVDA moved most.', suggestions: [] }));
    renderAsk();
    await ask('How am I doing?');
    await screen.findByText('5.00%');
    await ask('Which moved most?');

    expect(await screen.findByText('NVDA moved most.')).toBeTruthy();
    expect(post).toHaveBeenLastCalledWith('/assistant/messages', {
      message: 'Which moved most?',
      conversationId: CONVERSATION,
    });
  });
});

describe('what is not an answer', () => {
  it('says why it declined, in the page language', async () => {
    post.mockResolvedValueOnce(
      reply({ outcome: 'decline', reason: 'off_domain', text: 'I can only help with investing.', sources: [] }),
    );
    renderAsk();
    await ask("What's the weather?");

    expect(await screen.findByText('Outside what I cover')).toBeTruthy();
    expect(screen.getByText('I can only help with investing.')).toBeTruthy();
  });

  it.each([
    ['failed', /No answer I could check against the data/],
    ['budget_reached', /spending limit for questions is reached/],
    ['no_model', /needs a model/],
  ] as const)('%s is said plainly, not as an error', async (outcome, text) => {
    post.mockResolvedValueOnce(reply({ outcome, text: 'server words', sources: [], suggestions: [] }));
    renderAsk();
    await ask('Hello');

    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByText('server words')).toBeNull();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('reports a failure to reply as an error with a retry, and asks again from it', async () => {
    post.mockRejectedValueOnce(new ApiRequestError('The assistant could not answer.', 502, 'x'));
    renderAsk();
    await ask('How am I doing?');

    expect(await screen.findByText('The assistant could not answer.')).toBeTruthy();
    post.mockResolvedValueOnce(reply());
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('5.00%')).toBeTruthy();
    expect(post).toHaveBeenCalledTimes(2);
  });
});

describe('the conversation', () => {
  it('asks one question at a time, and says it is still working', async () => {
    post.mockReturnValueOnce(new Promise(() => {}));
    const { root } = renderAsk();
    await ask('How am I doing?');

    expect(await screen.findByText(/Looking it up/)).toBeTruthy();
    act(() => root.ask.setDraft('Another'));
    await act(() => root.ask.send());
    expect(post).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: 'Answering…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens an earlier conversation from the list', async () => {
    const stored: AssistantConversationResponse = {
      conversation: CONVERSATIONS.conversations[0]!,
      messages: [
        { id: 'u1', role: 'user', text: 'How am I doing?', outcome: null, reason: null, sources: [], suggestions: [], createdAt: '2026-10-12T08:00:00Z' },
        { id: 'a1', role: 'assistant', text: 'Up **5.00%**.', outcome: 'answer', reason: null, sources: [], suggestions: [], createdAt: '2026-10-12T08:01:00Z' },
      ],
    };
    get.mockImplementation((path: string) =>
      path === '/assistant/conversations'
        ? Promise.resolve(CONVERSATIONS)
        : path === `/assistant/conversations/${CONVERSATION}`
          ? Promise.resolve(stored)
          : new Promise(() => {}),
    );
    const { root } = renderAsk();

    fireEvent.click(await screen.findByRole('button', { name: /^How am I doing\?/ }));

    expect(await screen.findByText('5.00%')).toBeTruthy();
    expect(root.ask.conversationId).toBe(CONVERSATION);
  });

  it("names the safety limit's reset from the month a stored refusal was written in", async () => {
    const stored: AssistantConversationResponse = {
      conversation: CONVERSATIONS.conversations[0]!,
      messages: [
        { id: 'u1', role: 'user', text: 'How am I doing?', outcome: null, reason: null, sources: [], suggestions: [], createdAt: '2026-10-12T08:00:00Z' },
        { id: 'a1', role: 'assistant', text: 'server words', outcome: 'cap_reached', reason: null, sources: [], suggestions: [], createdAt: '2026-10-12T08:01:00Z' },
      ],
    };
    get.mockImplementation((path: string) =>
      path === '/assistant/conversations'
        ? Promise.resolve(CONVERSATIONS)
        : path === `/assistant/conversations/${CONVERSATION}`
          ? Promise.resolve(stored)
          : new Promise(() => {}),
    );
    renderAsk();

    fireEvent.click(await screen.findByRole('button', { name: /^How am I doing\?/ }));

    expect(await screen.findByText(/monthly safety limit on AI spending/)).toBeTruthy();
    expect(screen.getByText(/1 November 2026/)).toBeTruthy();
    expect(screen.queryByText('server words')).toBeNull();
  });

  it('deletes a conversation after confirming, and starts afresh if it was open', async () => {
    window.confirm = vi.fn(() => true);
    del.mockResolvedValueOnce(undefined);
    post.mockResolvedValueOnce(reply());
    const { root } = renderAsk();
    await ask('How am I doing?');
    await screen.findByText('5.00%');

    const history = within(screen.getByText('Conversations').closest('section') ?? document.body);
    fireEvent.click(await history.findByRole('button', { name: /Delete “How am I doing\?”/ }));

    await waitFor(() => expect(del).toHaveBeenCalledWith(`/assistant/conversations/${CONVERSATION}`));
    await waitFor(() => expect(root.ask.turns).toEqual([]));
  });

  it('does not delete without confirming', async () => {
    window.confirm = vi.fn(() => false);
    renderAsk();

    fireEvent.click(await screen.findByRole('button', { name: /Delete “How am I doing\?”/ }));
    expect(del).not.toHaveBeenCalled();
  });

  it('forgets the conversation when the account signs out', async () => {
    post.mockResolvedValueOnce(reply());
    const { root } = renderAsk();
    await ask('How am I doing?');
    await screen.findByText('5.00%');

    post.mockResolvedValueOnce(undefined);
    await act(() => root.auth.logout());
    expect(root.ask.turns).toEqual([]);
    expect(root.ask.conversationId).toBeNull();
  });
});

it('is linked from the app bar', async () => {
  const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }));
  const result = renderWithServerState(<App router={router} />);
  act(() => {
    result.root.auth.user = { id: 'u', baseCurrency: 'USD', timezone: 'Asia/Jerusalem' } as never;
    result.root.auth.initialised = true;
  });
  const link = await screen.findByRole('link', { name: /Ask/ });
  await waitFor(() => expect(link.getAttribute('href')).toBe('/ask'));
});

describe('a user with no working key of their own (D245, D270)', () => {
  const MONTH = { ownKeySpentMicroUsd: 0, safetyLimitMicroUsd: null, resetsOn: '2026-11-01' };

  function serveKey(spend: typeof MONTH | null, key: OwnLlmKeyResponse) {
    get.mockImplementation((path: string) =>
      path === '/assistant/conversations'
        ? Promise.resolve(CONVERSATIONS)
        : path === '/settings/llm-spend'
          ? Promise.resolve({ spend })
          : path === '/settings/llm-key'
            ? Promise.resolve(key)
            : new Promise(() => {}),
    );
  }

  it('is told up front, links to Settings, and cannot send', async () => {
    serveKey(MONTH, { available: true, key: null });
    renderAsk();

    expect(await screen.findByText(/run on your own OpenRouter API key, and none is saved/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Settings' }).getAttribute('href')).toBe('/settings');
    fireEvent.change(await screen.findByLabelText('Your question'), { target: { value: 'How am I doing?' } });
    expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByLabelText('Your question'), { key: 'Enter' });
    expect(post).not.toHaveBeenCalled();
  });

  it('asks normally with a working key, and the admin is never told', async () => {
    serveKey(MONTH, { available: true, key: { lastFour: 'c0de', status: 'valid', savedAt: '2026-10-20T12:00:00Z', failedAt: null, failure: null } });
    const { unmount } = renderAsk();
    fireEvent.change(await screen.findByLabelText('Your question'), { target: { value: 'How am I doing?' } });
    await waitFor(() => expect(get).toHaveBeenCalledWith('/settings/llm-key'));
    expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(false);
    unmount();

    serveKey(null, { available: true, key: null });
    renderAsk();
    expect(await screen.findByLabelText('Your question')).toBeTruthy();
    await waitFor(() => expect(get).toHaveBeenCalledWith('/settings/llm-spend'));
    expect(screen.queryByRole('link', { name: 'Open Settings' })).toBeNull();
  });
});
