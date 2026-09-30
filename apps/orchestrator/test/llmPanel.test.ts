/**
 * The LLM panel counts calls per agent and reconciles narration's fallback
 * reasons against the calls behind them. The shapes are the ones measured on
 * compose on 2026-09-30: a free route that bills nothing, and verdicts that
 * refuse most of what it writes.
 */

import { describe, expect, it } from 'vitest';

import type { LlmCallGroupRow } from '../src/db/queries.js';
import {
  LLM_PANEL_DEFAULT_DAYS,
  LLM_PANEL_MAX_DAYS,
  isFreeRoute,
  llmPanel,
  parseWindowDays,
  reconciliationSince,
} from '../src/services/llmPanel.js';

const FREE = 'nvidia/nemotron-3.5-lightning:free';
const SINCE = new Date('2026-09-24T00:00:00Z');
const FIRST_CALL = new Date('2026-09-30T22:00:00Z');

function group(overrides: Partial<LlmCallGroupRow>): LlmCallGroupRow {
  return {
    agent: 'narration',
    model: FREE,
    outcome: 'ok',
    verdict: 'accepted',
    calls: 1,
    prompt_tokens: '0',
    completion_tokens: '0',
    cost_micro_usd: '0',
    ...overrides,
  };
}

function panel(groups: LlmCallGroupRow[], reconciled: { fallback_reason: string; count: number }[] = []) {
  return llmPanel({
    days: LLM_PANEL_DEFAULT_DAYS,
    since: SINCE,
    firstCallAt: FIRST_CALL,
    groups,
    latencies: [],
    fallbacks: [],
    reconciledFallbacks: reconciled,
    recent: [],
  });
}

describe('the window', () => {
  it('defaults, and refuses anything outside retention or not a whole number', () => {
    expect(parseWindowDays(undefined)).toBe(LLM_PANEL_DEFAULT_DAYS);
    expect(parseWindowDays(String(LLM_PANEL_MAX_DAYS))).toBe(LLM_PANEL_MAX_DAYS);
    for (const raw of ['0', String(LLM_PANEL_MAX_DAYS + 1), '1.5', '-1', 'week', '']) {
      expect(parseWindowDays(raw)).toBeNull();
    }
  });

  it('reconciles only where both records exist', () => {
    expect(reconciliationSince(SINCE, null)).toBeNull();
    expect(reconciliationSince(SINCE, FIRST_CALL)).toEqual(FIRST_CALL);
    const early = new Date('2026-09-01T00:00:00Z');
    expect(reconciliationSince(SINCE, early)).toEqual(SINCE);
  });
});

describe('per agent', () => {
  it('lists every agent, idle ones included, so "no calls" is an answer', () => {
    const response = panel([]);
    expect(response.agents.map((agent) => agent.agent)).toEqual(['narration', 'ask']);
    expect(response.agents[1]).toMatchObject({ calls: 0, latency: null, costMicroUsd: 0 });
  });

  it('sums outcomes, verdicts, tokens and cost, and marks a free route', () => {
    const response = panel([
      group({ verdict: 'accepted', calls: 2, prompt_tokens: '900', completion_tokens: '300' }),
      group({ verdict: 'unsourced_figures', calls: 3 }),
      group({ outcome: 'provider_error', verdict: null, calls: 4 }),
      group({ model: 'openai/gpt-x', verdict: 'accepted', cost_micro_usd: '1250' }),
    ]);
    const narration = response.agents.find((agent) => agent.agent === 'narration')!;
    expect(narration).toMatchObject({
      calls: 10,
      promptTokens: 900,
      completionTokens: 300,
      costMicroUsd: 1250,
    });
    expect(narration.outcomes).toMatchObject({ ok: 6, provider_error: 4 });
    // A provider error returned nothing to judge; it is not "not judged".
    expect(narration.verdicts).toMatchObject({ accepted: 3, unsourced_figures: 3, not_judged: 0 });
    expect(narration.models).toEqual([
      { model: FREE, calls: 9, free: true },
      { model: 'openai/gpt-x', calls: 1, free: false },
    ]);
  });

  it('knows the free route by its suffix only', () => {
    expect(isFreeRoute(FREE)).toBe(true);
    expect(isFreeRoute('free-model')).toBe(false);
    expect(isFreeRoute(null)).toBe(false);
  });
});

describe('narration reconciliation', () => {
  it('matches each fallback reason to the calls behind it', () => {
    const response = panel(
      [
        group({ verdict: 'accepted', calls: 2 }),
        group({ verdict: 'degenerate_completion' }),
        group({ verdict: 'malformed' }),
        group({ outcome: 'provider_error', verdict: null }),
        group({ agent: 'ask', verdict: 'unsourced_figures' }),
      ],
      [
        { fallback_reason: 'none', count: 2 },
        { fallback_reason: 'malformed', count: 2 },
        { fallback_reason: 'provider_error', count: 2 },
      ],
    );
    expect(response.reconciliation?.since).toBe(FIRST_CALL.toISOString());
    // The ask call counts nowhere here; the second provider error has no call.
    expect(response.reconciliation?.rows).toEqual([
      { reason: 'none', explanations: 2, calls: 2 },
      { reason: 'malformed', explanations: 2, calls: 2 },
      { reason: 'provider_error', explanations: 2, calls: 1 },
    ]);
  });

  it('keeps a completion nobody judged, and a reason it does not know', () => {
    const response = panel([group({ verdict: null })], [{ fallback_reason: 'new_reason', count: 1 }]);
    expect(response.reconciliation?.rows).toEqual([
      { reason: 'not_judged', explanations: 0, calls: 1 },
      { reason: 'new_reason', explanations: 1, calls: 0 },
    ]);
  });

  it('is absent when no call has been recorded', () => {
    const response = llmPanel({
      days: LLM_PANEL_DEFAULT_DAYS,
      since: SINCE,
      firstCallAt: null,
      groups: [],
      latencies: [],
      fallbacks: [{ fallback_reason: 'unsourced_figures', count: 17 }],
      reconciledFallbacks: [],
      recent: [],
    });
    expect(response.reconciliation).toBeNull();
    expect(response.narrationFallbacks).toEqual([{ reason: 'unsourced_figures', count: 17 }]);
  });
});
