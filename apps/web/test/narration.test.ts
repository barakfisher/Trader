/**
 * When the badge speaks, and what it says.
 *
 * Two properties matter more than the rest. It stays silent in the one state
 * that needs no comment, because a badge that is always present stops being
 * read. And it says nothing at all when it cannot reach its own subject - an
 * indicator about reliability that reported its own outage as a product fault
 * would be the most misleading thing on the page.
 */

import { describe, expect, it, vi } from 'vitest';

import type { NarrationHealthResponse } from '@traders/shared';

vi.mock('../src/api/client.ts', () => ({
  api: { get: vi.fn() },
  ApiRequestError: class ApiRequestError extends Error {},
}));

const { describeNarration, isNoteworthy, narrationOptions } = await import(
  '../src/lib/narrationStatus.ts'
);
const { narrationQuery } = await import('../src/queries/narration.ts');

const health = (over: Partial<NarrationHealthResponse> = {}): NarrationHealthResponse => ({
  state: 'rejected',
  sampleSize: 4,
  lastFallbackReason: 'unsourced_figures',
  ...over,
});

describe('when the badge speaks', () => {
  it('says nothing when a model is narrating normally', () => {
    // Whatever the model: the badge once said "Free tier" from the
    // installation's LLM_MODEL over a user's paid model, so it names no tier.
    expect(isNoteworthy(health({ state: 'narrating' }))).toBe(false);
  });

  it('speaks up whenever templates are writing instead', () => {
    expect(isNoteworthy(health({ state: 'rejected' }))).toBe(true);
  });

  it('stays silent when it cannot reach its own subject', () => {
    // A failed read leaves no data, and is not retried into a spinner.
    expect(isNoteworthy(undefined)).toBe(false);
    expect(narrationQuery.retry).toBe(false);
  });
});

describe('narration copy', () => {
  it('gives every state a label and a summary a reader can act on', () => {
    for (const state of ['off', 'narrating', 'unavailable', 'exhausted', 'rejected', 'unknown'] as const) {
      const copy = describeNarration(state);
      expect(copy.label).not.toBe('');
      expect(copy.summary).not.toBe('');
    }
  });

  it('says that a refused model has shown the reader nothing wrong', () => {
    // The refusal is the safeguard working, and a reader seeing a warning badge
    // deserves to be told that before they wonder what they have been reading.
    expect(describeNarration('rejected').consequence).toMatch(/nothing wrong has been shown/i);
  });

  it('does not describe templates as merely worse', () => {
    // Every figure in them is checked, so the trade-off is phrasing against
    // nothing, not quality against quality.
    const templates = narrationOptions()[1];
    expect(templates.detail).toMatch(/nothing is ever invented|never wrong|nothing is ever wrong/i);
  });

  it('quotes a cost that came from measurement', () => {
    expect(narrationOptions()[0].title).toMatch(/\$0\.45/);
  });
});
