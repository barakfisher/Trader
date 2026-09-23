/**
 * The five states, and the distinctions that stop an operator fixing the wrong
 * thing.
 *
 * Each state has a different remedy: paying, waiting, changing the model, or
 * nothing at all because it was switched off on purpose. Collapsing any two of
 * them sends someone somewhere useless, so each boundary is asserted.
 */

import { describe, expect, it } from 'vitest';

import { narrationStateFrom } from '../src/services/narrationHealth.js';

const row = (source: string, reason: string | null = null) => ({
  narration_source: source,
  fallback_reason: reason,
});

describe('narrationStateFrom', () => {
  it('reports off when no provider was asked for, which is not a failure', () => {
    expect(narrationStateFrom([], 'none').state).toBe('off');
    // Even with rows to read: a configured-off installation is not degraded.
    expect(narrationStateFrom([row('template', 'no_provider')], 'none').state).toBe('off');
  });

  it('claims nothing when nothing has been recorded', () => {
    // Distinct from `off`. Rows predating provenance are excluded by the query,
    // so an empty sample means "not recorded", not "not working".
    expect(narrationStateFrom([], 'free').state).toBe('unknown');
  });

  it('treats one model-written sentence as a working narrator', () => {
    // A rejected finding among narrated ones is an awkward finding, not an
    // outage. Reporting it as a fault would cry wolf on most scans.
    const rows = [row('llm'), row('template', 'unsourced_figures')];
    expect(narrationStateFrom(rows, 'paid').state).toBe('narrating');
  });

  it('separates a spent budget from a refusing provider', () => {
    // Paying fixes one; waiting fixes the other. A single "degraded" would send
    // an operator to the wrong remedy.
    expect(narrationStateFrom([row('template', 'budget_exhausted')], 'paid').state).toBe(
      'exhausted',
    );
    expect(narrationStateFrom([row('template', 'provider_error')], 'free').state).toBe(
      'unavailable',
    );
  });

  it('reports a model whose figures are refused as its own state', () => {
    // The state the free tier is actually in: every request answered, nothing
    // usable. Neither paying for the same model nor waiting will change it.
    expect(narrationStateFrom([row('template', 'unsourced_figures')], 'free').state).toBe(
      'rejected',
    );
    expect(narrationStateFrom([row('template', 'malformed')], 'free').state).toBe('rejected');
  });

  it('shows the most serious reason when a scan hit several', () => {
    const rows = [row('template', 'provider_error'), row('template', 'budget_exhausted')];
    const health = narrationStateFrom(rows, 'paid');
    expect(health.state).toBe('exhausted');
    expect(health.lastFallbackReason).toBe('budget_exhausted');
  });

  it('degrades to unavailable for a reason it has never seen', () => {
    // A new fallback reason must not crash the indicator or read as healthy.
    // Same lesson as the run-kind CHECK: an unanticipated value is not a licence
    // to fail, and telemetry must never be able to take down what reports it.
    expect(narrationStateFrom([row('template', 'something_new')], 'paid').state).toBe(
      'unavailable',
    );
  });
});
