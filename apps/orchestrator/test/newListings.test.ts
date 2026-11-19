/**
 * How a day's new-listings screen ends (migration 0088): a listing Yahoo has
 * not described yet is tomorrow's, not a failure; a listing the source could
 * not be asked about, or one admitted without a vector, degrades the run; an
 * installation without a profile source skips it and says why.
 */

import { describe, expect, it, vi } from 'vitest';

import type { NewListingsResponse } from '@traders/shared/ai';

import { newListingsOutcome, runNewListings } from '../src/services/newListings.js';

const DONE: NewListingsResponse = {
  status: 'done',
  reason: null,
  screened: 5397,
  kept: 5265,
  candidates: 3,
  same_company: 0,
  deferred: 0,
  admitted: ['NEWAI'],
  no_listing: [],
  outside_screen: [],
  no_description: ['ANT'],
  no_currency: [],
  failed: [],
  unembedded: [],
};

describe('the new-listings run', () => {
  it('is ok when every candidate was admitted or is waiting for Yahoo to describe it', () => {
    const outcome = newListingsOutcome(DONE);
    expect(outcome.status).toBe('ok');
    expect(outcome.result).toMatchObject({ admitted: ['NEWAI'], noDescription: ['ANT'], candidates: 3 });
  });

  it('is degraded when the source could not be asked about a listing', () => {
    expect(newListingsOutcome({ ...DONE, failed: ['ANT'] }).status).toBe('degraded');
  });

  it('is degraded when a listing was admitted without an embedding', () => {
    expect(newListingsOutcome({ ...DONE, unembedded: ['NEWAI'] }).status).toBe('degraded');
  });

  it('is skipped, with the reason, where the installation cannot screen', () => {
    const outcome = newListingsOutcome({ ...DONE, status: 'unavailable', reason: 'no Yahoo in the chain' });
    expect(outcome).toEqual({ status: 'skipped', result: { reason: 'no Yahoo in the chain' } });
  });

  it('asks the AI service once and passes the request id', async () => {
    const ai = { newListings: vi.fn(async () => DONE) };
    await runNewListings(ai, 'request-1');
    expect(ai.newListings).toHaveBeenCalledWith('request-1');
  });
});
