/**
 * The observations feed: which drawers the reader opened, and what the reader
 * is shown for a raw evidence mapping. The API client is mocked, so these are
 * fast and need no backend.
 */

import { describe, expect, it, vi } from 'vitest';

import type { Observation } from '@traders/shared';

const get = vi.fn();
const post = vi.fn();
const postForm = vi.fn();
const patch = vi.fn();
const del = vi.fn();

vi.mock('../src/api/client.ts', () => ({
  api: { get, post, postForm, patch, delete: del },
  ApiRequestError: class ApiRequestError extends Error {
    constructor(
      message: string,
      readonly status = 500,
      readonly code = 'error',
    ) {
      super(message);
    }
  },
}));

const { RootStore } = await import('../src/stores/RootStore.ts');
const { readEvidence, labelFor, unitFor } = await import('../src/lib/evidence.ts');
const { kindLabel, severityRank, severityStyle, subjectLabel, conceptLabel } =
  await import('../src/lib/observationPresentation.ts');
const { formatExactTime } = await import('../src/lib/relativeTime.ts');

const priceMove: Observation = {
  id: 'obs-1',
  kind: 'price_move',
  severity: 'high',
  subjectKind: 'instrument',
  subjectRef: 'instrument:NVDA',
  headline: 'NVDA moved -8.5% to 118.45 USD',
  explanation: 'NVDA went from 129.45 USD to 118.45 USD, a change of -8.5%.',
  evidence: {
    symbol: 'NVDA',
    currency: 'USD',
    price_minor: 11845,
    as_of: '2026-09-16T14:00:00Z',
    previous_price_minor: 12945,
    change_minor: -1100,
    change_pct: -0.085,
    gap_days: 1,
    thresholds_pct: { info: 0.03, notable: 0.05, high: 0.08 },
  },
  conceptRefs: ['daily-return'],
  narrationSource: 'llm',
  fallbackReason: 'none',
  createdAt: '2026-09-16T14:00:00Z',
};

describe('ObservationsStore', () => {
  // The findings are server state (`queries/observations.ts`, tested with the
  // feed in feed.test.tsx). What is left here is what the reader did.
  it('tracks which evidence drawers are open, and clears them on reset', () => {
    const store = new RootStore();
    expect(store.observations.isExpanded('obs-1')).toBe(false);
    store.observations.toggleEvidence('obs-1');
    expect(store.observations.isExpanded('obs-1')).toBe(true);
    store.observations.toggleEvidence('obs-1');
    expect(store.observations.isExpanded('obs-1')).toBe(false);

    store.observations.toggleEvidence('obs-1');
    store.observations.reset();
    expect(store.observations.isExpanded('obs-1')).toBe(false);
  });
});

describe('readEvidence', () => {
  it('renders minor units as money in the currency the mapping declares', () => {
    const [figures] = readEvidence(priceMove.evidence);
    const price = figures?.entries.find((entry) => entry.key === 'price_minor');

    expect(price?.label).toBe('Price');
    expect(price?.value).toBe('$118.45');
    expect(price?.interpreted).toBe(true);
  });

  it('falls back to the base currency when the mapping declares none', () => {
    const [figures] = readEvidence({ price_minor: 11845 }, { fallbackCurrency: 'EUR' });
    expect(figures?.entries[0]?.value).toBe('€118.45');
  });

  it('renders a fraction as the percentage a reader expects, not as 0.085', () => {
    const [figures] = readEvidence(priceMove.evidence);
    const change = figures?.entries.find((entry) => entry.key === 'change_pct');

    expect(change?.label).toBe('Change');
    expect(change?.value).toBe('-8.50%');
  });

  it('reads an exact decimal weight string as a fraction', () => {
    // Weights cross the wire as exact decimal strings, not floats.
    const [figures] = readEvidence({ actual_weight: '0.253100', drift: '-0.046900' });
    expect(figures?.entries[0]).toMatchObject({ label: 'Actual', value: '+25.31%' });
    expect(figures?.entries[1]).toMatchObject({ label: 'Drift from target', value: '-4.69%' });
  });

  it('renders timestamps as a readable time rather than an ISO string', () => {
    const [figures] = readEvidence(priceMove.evidence);
    const asOf = figures?.entries.find((entry) => entry.key === 'as_of');

    expect(asOf?.label).toBe('Observed at');
    expect(asOf?.value).toBe(formatExactTime('2026-09-16T14:00:00Z'));
    expect(asOf?.value).not.toContain('T');
  });

  it('shows an unknown key raw rather than guessing a unit for it', () => {
    const [figures] = readEvidence({ sample_size: 60, some_future_field: 4 });
    expect(figures?.entries).toEqual([
      { key: 'sample_size', label: 'Sample size', value: '60', interpreted: false },
      { key: 'some_future_field', label: 'Some future field', value: '4', interpreted: false },
    ]);
  });

  it('renders booleans and long floats in a form a person can read', () => {
    const [figures] = readEvidence({ held: true, z_score: 3.104137295 });
    expect(figures?.entries[0]?.value).toBe('yes');
    expect(figures?.entries[1]).toMatchObject({ label: 'Z-score', value: '3.1041' });
  });

  it('lifts a nested mapping into its own section, below the finding figures', () => {
    const sections = readEvidence(priceMove.evidence);
    expect(sections).toHaveLength(2);
    expect(sections[0]?.label).toBeNull();

    const thresholds = sections[1];
    expect(thresholds?.label).toBe('Thresholds');
    // The unit comes from the key that holds the mapping: `thresholds_pct`
    // contains fractions even though `info` says nothing about its own unit.
    expect(thresholds?.entries.map((entry) => entry.value)).toEqual(['+3.00%', '+5.00%', '+8.00%']);
  });

  it('does not convert a sigma threshold into a percentage', () => {
    const sections = readEvidence({ thresholds_sigma: { info: 2, notable: 2.5, high: 3 } });
    expect(sections[0]?.entries.map((entry) => entry.value)).toEqual(['2', '2.5', '3']);
  });

  it('returns nothing for evidence that is missing or not a mapping', () => {
    expect(readEvidence(null)).toEqual([]);
    expect(readEvidence(undefined)).toEqual([]);
    expect(readEvidence([1, 2])).toEqual([]);
  });

  it('classifies keys by their unit suffix', () => {
    expect(unitFor('previous_price_minor')).toBe('money');
    expect(unitFor('return_ratio')).toBe('fraction');
    expect(unitFor('target_weight')).toBe('fraction');
    expect(unitFor('high_as_of')).toBe('timestamp');
    expect(unitFor('as_of')).toBe('timestamp');
    expect(unitFor('symbol')).toBe('unknown');
  });

  it('drops the unit suffix from a label once the unit has been applied', () => {
    expect(labelFor('previous_price_minor')).toBe('Previous price');
    expect(labelFor('portfolio_total_minor')).toBe('Portfolio total');
    expect(labelFor('window_days')).toBe('Window days');
  });
});

describe('observation presentation', () => {
  it('names every severity the engine can emit, and tolerates one it cannot', () => {
    expect(severityStyle('high').label).toBe('High');
    expect(severityStyle('notable').label).toBe('Notable');
    expect(severityStyle('info').label).toBe('Info');
    expect(severityStyle('apocalyptic').label).toBe('Info');
  });

  it('never dresses a severity in the gain or loss colour by accident', () => {
    // Green means "money went up" everywhere else in this dashboard; no
    // severity may borrow it.
    for (const severity of ['info', 'notable', 'high']) {
      expect(severityStyle(severity).chipClassName).not.toContain('gain');
      expect(severityStyle(severity).railClassName).not.toContain('gain');
    }
  });

  it('ranks an unreadable severity below the ones it knows', () => {
    expect(severityRank('high')).toBeGreaterThan(severityRank('notable'));
    expect(severityRank('notable')).toBeGreaterThan(severityRank('info'));
    expect(severityRank('unknown-kind')).toBeLessThan(severityRank('info'));
  });

  it('gives an unknown kind a readable name instead of a blank', () => {
    expect(kindLabel('sigma_move')).toBe('Unusual move');
    expect(kindLabel('volume_anomaly')).toBe('Volume anomaly');
  });

  it('reduces a subject handle to the thing it is about', () => {
    expect(subjectLabel('instrument:NVDA')).toBe('NVDA');
    expect(subjectLabel('portfolio:allocation:AAPL')).toBe('AAPL');
    expect(subjectLabel('NVDA')).toBe('NVDA');
  });

  it('names a topic by its label, never by its id', () => {
    const ref = 'topic:5f0c1d2e-0000-4000-8000-000000000001';
    expect(subjectLabel(ref, { topic_label: 'uranium' })).toBe('uranium');
    expect(kindLabel('topic_move')).toBe('Topic move');
  });

  it('turns a concept slug into words', () => {
    expect(conceptLabel('daily-return')).toBe('Daily return');
  });
});
