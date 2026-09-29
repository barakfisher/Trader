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
  tier: 'free',
  model: 'some/model:free',
  sampleSize: 4,
  lastFallbackReason: 'unsourced_figures',
  ...over,
});

describe('when the badge speaks', () => {
  it('says nothing when a paid model is narrating normally', () => {
    expect(isNoteworthy(health({ state: 'narrating', tier: 'paid' }))).toBe(false);
  });

  it('speaks up on a free tier even when the model is narrating', () => {
    // "This is costing you nothing" is itself worth saying, and it is the
    // state the user asked to be able to see at a glance.
    expect(isNoteworthy(health({ state: 'narrating', tier: 'free' }))).toBe(true);
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
    // They are the only output that clears the evidence check on this tier, so
    // the trade-off is phrasing against nothing, not quality against quality.
    const templates = narrationOptions('free')[1];
    expect(templates.detail).toMatch(/nothing is ever invented|never wrong|nothing is ever wrong/i);
  });

  it('quotes a cost that came from measurement', () => {
    expect(narrationOptions('free')[0].title).toMatch(/\$0\.45/);
  });
});
