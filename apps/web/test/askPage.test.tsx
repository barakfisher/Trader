// @vitest-environment jsdom
/**
 * The /ask screen, rendered at its address.
 *
 * Pinned: a weak match and each refusal look different from an answer and from
 * each other (decisions 32, 36); who wrote an answer is said; the passages are
 * shown verbatim; a computed answer shows its figures; a failure to get any
 * reply is an error with a retry, never a refusal; one question at a time; and
 * signing out forgets the questions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';

import type { AskResponse } from '@traders/shared/ai';

const get = vi.fn();
const post = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>(
    '../src/api/client.ts',
  );
  return { ...actual, api: { get, post, put: vi.fn(), delete: vi.fn(), postForm: vi.fn() } };
});

const { ApiRequestError } = await import('../src/api/client.ts');
const { App } = await import('../src/App.tsx');
const { createAppRouter } = await import('../src/router.tsx');
const { renderWithServerState } = await import('./serverStateHarness.tsx');

const PASSAGE = 'A drawdown is how far an instrument has fallen from a recent high.';

function reply(overrides: Partial<AskResponse> = {}): AskResponse {
  return {
    question: 'what is a drawdown',
    intent: 'concept',
    answered: true,
    text: 'A drawdown is the distance from a recent peak.',
    citations: [
      {
        chunk_id: 'c1',
        document_id: 'd1',
        concept_slug: 'drawdown',
        title: 'Drawdown',
        heading: 'What it is',
        text: PASSAGE,
        similarity: 0.7124,
      },
    ],
    concept_refs: ['drawdown'],
    evidence: {},
    answer_source: 'llm',
    fallback_reason: 'none',
    relevance: 'confident',
    best_similarity: 0.7124,
    refused_reason: null,
    vector_is_semantic: true,
    ...overrides,
  };
}

function renderAsk() {
  const router = createAppRouter(createMemoryHistory({ initialEntries: ['/ask'] }));
  const result = renderWithServerState(<App router={router} />);
  act(() => {
    result.root.auth.user = { id: 'u', baseCurrency: 'USD', timezone: 'Asia/Jerusalem' } as never;
    result.root.auth.initialised = true;
  });
  return result;
}

async function askQuestion(text: string) {
  const box = await screen.findByLabelText(/Ask what a term means/);
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  window.scrollTo = () => {};
  get.mockReturnValue(new Promise(() => {}));
});
afterEach(cleanup);

describe('an answer', () => {
  it('says who wrote it and shows the passage verbatim', async () => {
    post.mockResolvedValueOnce(reply());
    renderAsk();
    await askQuestion('what is a drawdown');

    expect(await screen.findByText('A drawdown is the distance from a recent peak.')).toBeTruthy();
    expect(screen.getByText(/Written by a model from the passages below/)).toBeTruthy();
    expect(screen.getByText(PASSAGE)).toBeTruthy();
    expect(screen.queryByText(/Weak match/)).toBeNull();
    expect(post).toHaveBeenCalledWith('/ask', { question: 'what is a drawdown' });
  });

  it('marks a weak match on the page, not only in the text', async () => {
    post.mockResolvedValueOnce(
      reply({ relevance: 'weak', best_similarity: 0.2502, answer_source: 'extractive' }),
    );
    renderAsk();
    await askQuestion('what is the current price of gold');

    expect(await screen.findByText(/Weak match: the reference notes may not cover/)).toBeTruthy();
    expect(screen.getByText(/closest passage scored 0.25/)).toBeTruthy();
  });

  it('shows a computed answer’s figures, and that no model wrote it', async () => {
    post.mockResolvedValueOnce(
      reply({
        intent: 'portfolio',
        answer_source: 'computed',
        text: 'Your largest position is BTC-USD.',
        citations: [],
        concept_refs: [],
        evidence: { symbol: 'BTC-USD', value_minor: 3499743, currency: 'USD' },
      }),
    );
    renderAsk();
    await askQuestion('what is my largest position');

    expect(await screen.findByText(/No model wrote this/)).toBeTruthy();
    expect(screen.getByText('$34,997.43')).toBeTruthy();
  });
});

describe('a refusal', () => {
  it.each([
    ['not_in_corpus', 'Not in the reference corpus'],
    ['no_holdings', 'No holdings to compute from'],
    ['advice', 'No personal investment advice'],
    ['not_computable', 'Not something I can compute'],
  ])('%s has its own title', async (reason, title) => {
    post.mockResolvedValueOnce(
      reply({ answered: false, refused_reason: reason, answer_source: 'none', citations: [], text: 'declined' }),
    );
    renderAsk();
    await askQuestion('anything');

    expect(await screen.findByText(title)).toBeTruthy();
    expect(screen.queryByText(/Written by a model/)).toBeNull();
  });
});

describe('asking', () => {
  it('reports a failure to reply as an error with a retry, and asks again from it', async () => {
    post.mockRejectedValueOnce(new ApiRequestError('The question could not be answered.', 502, 'x'));
    renderAsk();
    await askQuestion('what is a drawdown');

    expect(await screen.findByText('The question could not be answered.')).toBeTruthy();
    expect(screen.queryByText('Not in the reference corpus')).toBeNull();

    post.mockResolvedValueOnce(reply());
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('A drawdown is the distance from a recent peak.')).toBeTruthy();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('asks one question at a time, and says it is still working', async () => {
    post.mockReturnValueOnce(new Promise(() => {}));
    const { root } = renderAsk();
    await askQuestion('what is a drawdown');

    expect(await screen.findByText(/Searching the reference corpus/)).toBeTruthy();
    act(() => root.ask.setDraft('what is volatility'));
    await act(() => root.ask.ask());
    expect(post).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: 'Answering…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('forgets the questions when the account signs out', async () => {
    post.mockResolvedValueOnce(reply());
    const { root } = renderAsk();
    await askQuestion('what is a drawdown');
    await screen.findByText(PASSAGE);

    post.mockResolvedValueOnce(undefined);
    await act(() => root.auth.logout());
    expect(root.ask.entries).toEqual([]);
  });
});

it('is linked from the dashboard', async () => {
  const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }));
  const result = renderWithServerState(<App router={router} />);
  act(() => {
    result.root.auth.user = { id: 'u', baseCurrency: 'USD', timezone: 'Asia/Jerusalem' } as never;
    result.root.auth.initialised = true;
  });
  const link = await screen.findByRole('link', { name: /Ask/ });
  await waitFor(() => expect(link.getAttribute('href')).toBe('/ask'));
});
