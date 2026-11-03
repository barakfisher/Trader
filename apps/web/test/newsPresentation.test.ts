import { describe, expect, it } from 'vitest';

import { newsEmptyMessage } from '../src/lib/newsPresentation.ts';

const COLLECTED = { lastRunAt: '2026-09-27T14:01:12Z', failedProviders: [] as string[] };

describe('an empty news list, in words', () => {
  it('never calls a week quiet when the news could not be read', () => {
    const failing = newsEmptyMessage({ ...COLLECTED, status: 'degraded', failedProviders: ['gdelt'] }, 7, 'NVDA');
    expect(failing).not.toMatch(/No news about/);
    expect(failing).toMatch(/may not mean a quiet week/);
    expect(failing).toMatch(/gdelt/);
    expect(newsEmptyMessage({ ...COLLECTED, status: 'failed' }, 7, 'NVDA')).toMatch(/stories may be missing/);
  });

  it('calls a week quiet only after a clean collection', () => {
    expect(newsEmptyMessage({ ...COLLECTED, status: 'ok' }, 7, 'NVDA')).toBe('No news about NVDA in the last 7 days.');
  });

  it('says so when news was never collected', () => {
    expect(newsEmptyMessage(null, 7, 'NVDA')).toMatch(/has not been collected yet/);
  });
});
