import { describe, expect, it } from 'vitest';

import type { AskResponse } from '@traders/shared/ai';

import {
  matchingNote,
  outcomeOf,
  similarityText,
  sourceText,
  waitingText,
} from '../src/lib/askPresentation.ts';

function reply(overrides: Partial<AskResponse> = {}): AskResponse {
  return {
    question: 'q',
    intent: 'concept',
    answered: true,
    text: 't',
    citations: [],
    concept_refs: [],
    evidence: {},
    answer_source: 'extractive',
    fallback_reason: 'none',
    relevance: 'confident',
    best_similarity: 0.71,
    refused_reason: null,
    vector_is_semantic: true,
    ...overrides,
  };
}

describe('outcomeOf', () => {
  it.each([
    ['not_in_corpus', 'Not in the reference corpus'],
    ['no_holdings', 'No holdings to compute from'],
    ['advice', 'No personal investment advice'],
    ['not_computable', 'Not something I can compute'],
  ])('gives the %s refusal its own title', (reason, title) => {
    expect(outcomeOf(reply({ answered: false, refused_reason: reason, answer_source: 'none' }))).toEqual({
      kind: 'refused',
      reason,
      title,
    });
  });

  it('names a refusal it does not know rather than folding it into one it does', () => {
    const outcome = outcomeOf(reply({ answered: false, refused_reason: 'new_reason' }));
    expect(outcome).toMatchObject({ title: 'Not answered (new_reason)' });
  });

  it('keeps a weak match apart from a confident one, and arithmetic apart from both', () => {
    expect(outcomeOf(reply({ relevance: 'weak' }))).toEqual({ kind: 'answer', relevance: 'weak' });
    expect(outcomeOf(reply())).toEqual({ kind: 'answer', relevance: 'confident' });
    expect(outcomeOf(reply({ answer_source: 'computed', intent: 'portfolio' }))).toEqual({
      kind: 'computed',
    });
  });
});

describe('sourceText', () => {
  it('says who wrote it', () => {
    expect(sourceText(reply({ answer_source: 'llm' }))).toMatch(/^Written by a model/);
    expect(sourceText(reply({ answer_source: 'computed' }))).toMatch(/No model wrote this/);
    expect(sourceText(reply({ fallback_reason: 'no_llm_configured' }))).toBe(
      'Quoted from the passages below.',
    );
  });

  it('says why a model’s draft was set aside', () => {
    expect(sourceText(reply({ fallback_reason: 'degenerate_completion' }))).toMatch(
      /set aside: it was not readable text/,
    );
    expect(sourceText(reply({ fallback_reason: 'unsourced_figures' }))).toMatch(
      /a figure the passages do not contain/,
    );
  });
});

it('notes a lexical match, and only then', () => {
  expect(matchingNote(reply())).toBeNull();
  expect(matchingNote(reply({ vector_is_semantic: false }))).toMatch(/shared words/);
  // A portfolio answer searched nothing, whatever the embedder is.
  expect(matchingNote(reply({ vector_is_semantic: false, intent: 'portfolio' }))).toBeNull();
});

it('cuts a similarity to two places without rounding it up', () => {
  expect(similarityText(0.2498)).toBe('0.24');
  expect(similarityText(null)).toBeNull();
});

it('says a slow answer is expected, after a moment', () => {
  expect(waitingText(1)).toMatch(/^Searching/);
  expect(waitingText(20)).toMatch(/Still working \(20s\)/);
});
