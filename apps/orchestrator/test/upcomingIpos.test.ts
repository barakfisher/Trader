/**
 * How a day's upcoming-IPO run ends (migration 0089): histories the cap left
 * for tomorrow are not a failure; a history that could not be fetched degrades
 * the run; FILINGS_PROVIDER=off skips it and says why.
 */

import { describe, expect, it, vi } from 'vitest';

import type { UpcomingIposResponse } from '@traders/shared/ai';

import { runUpcomingIpos, upcomingIposOutcome } from '../src/services/upcomingIpos.js';

const DONE: UpcomingIposResponse = {
  status: 'done',
  reason: null,
  searched: 400,
  tracked: ['Anthropic, PBC'],
  excluded: { blank_check: 17, reporting_company: 69, fund: 7 },
  advanced: ['Anthropic, PBC: priced'],
  listed: ['ANT'],
  failed: [],
  deferred: 34,
};

describe('the upcoming-IPO run', () => {
  it('is ok when every history it asked for was read, whatever the cap deferred', () => {
    const outcome = upcomingIposOutcome(DONE);
    expect(outcome.status).toBe('ok');
    expect(outcome.result).toMatchObject({ tracked: ['Anthropic, PBC'], listed: ['ANT'], deferred: 34 });
  });

  it('is degraded when a company history could not be fetched', () => {
    expect(upcomingIposOutcome({ ...DONE, failed: ['0002130357'] }).status).toBe('degraded');
  });

  it('is skipped, with the reason, where the installation reads no filings', () => {
    const outcome = upcomingIposOutcome({ ...DONE, status: 'unavailable', reason: 'FILINGS_PROVIDER is off' });
    expect(outcome).toEqual({ status: 'skipped', result: { reason: 'FILINGS_PROVIDER is off' } });
  });

  it('asks the AI service once and passes the request id', async () => {
    const ai = { upcomingIpos: vi.fn(async () => DONE) };
    await runUpcomingIpos(ai, 'request-1');
    expect(ai.upcomingIpos).toHaveBeenCalledWith('request-1');
  });
});
