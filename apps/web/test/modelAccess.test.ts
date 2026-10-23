/**
 * What stops a user's model calls, read from the Settings month and key (D245,
 * D250, D275): the rule the notice on Ask, Agents and a re-check shows.
 */

import { describe, expect, it } from 'vitest';

import type { MonthlySpend, OwnLlmKeyResponse } from '@traders/shared';

import { blockOf } from '../src/queries/modelAccess.ts';

const LIMIT = 20_000_000;
const MONTH: MonthlySpend = { ownKeySpentMicroUsd: 0, safetyLimitMicroUsd: null, resetsOn: '2026-11-01' };
const KEY = { lastFour: 'c0de', savedAt: '2026-10-20T12:00:00Z', failedAt: null, failure: null };
const WORKING: OwnLlmKeyResponse = { available: true, key: { ...KEY, status: 'valid' } };

describe('what stops a user', () => {
  it('is nothing with a working key under its limit, or with no limit', () => {
    expect(blockOf(MONTH, WORKING)).toBeNull();
    expect(blockOf({ ...MONTH, safetyLimitMicroUsd: LIMIT, ownKeySpentMicroUsd: LIMIT - 1 }, WORKING)).toBeNull();
  });

  it('names a missing key, a refused one, and an installation that cannot use keys', () => {
    expect(blockOf(MONTH, { available: true, key: null })).toBe('no_key');
    expect(
      blockOf(MONTH, { available: true, key: { ...KEY, status: 'failed', failure: 'rejected', failedAt: KEY.savedAt } }),
    ).toBe('key_failed');
    expect(blockOf(MONTH, { available: false, key: null })).toBe('unavailable');
  });

  it('is the safety limit once spend meets it', () => {
    expect(blockOf({ ...MONTH, safetyLimitMicroUsd: LIMIT, ownKeySpentMicroUsd: LIMIT }, WORKING)).toBe('safety_limit');
  });
});
