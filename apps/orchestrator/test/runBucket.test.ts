/**
 * The bucket decides how often a kind of run may do work.
 *
 * Kept in its own file rather than added to app.test.ts: this is policy with
 * arithmetic in it, and it deserves cases that name the times they describe.
 */

import { describe, expect, it } from 'vitest';

import { runBucket } from '../src/http/routes/internal.js';

const DATE = '2026-09-16';
const at = (hour: number, minute: number) => new Date(Date.UTC(2026, 8, 16, hour, minute));

describe('runBucket', () => {
  it('gives a snapshot one bucket per day', () => {
    // The day's closing value: a second trigger has nothing to add.
    expect(runBucket('snapshot', DATE, at(9, 0))).toBe(DATE);
    expect(runBucket('snapshot', DATE, at(23, 59))).toBe(DATE);
  });

  it('gives a scan a bucket every thirty minutes', () => {
    expect(runBucket('portfolio_scan', DATE, at(14, 0))).toBe(`${DATE}:28`);
    expect(runBucket('portfolio_scan', DATE, at(14, 29))).toBe(`${DATE}:28`);
    expect(runBucket('portfolio_scan', DATE, at(14, 30))).toBe(`${DATE}:29`);
  });

  it('collapses triggers inside one window', () => {
    // The timer fires more often than the work is allowed to happen, so that a
    // missed tick costs one interval rather than a whole period.
    const first = runBucket('portfolio_scan', DATE, at(14, 2));
    const second = runBucket('portfolio_scan', DATE, at(14, 17));
    expect(first).toBe(second);
  });

  it('separates consecutive windows', () => {
    expect(runBucket('portfolio_scan', DATE, at(14, 20))).not.toBe(
      runBucket('portfolio_scan', DATE, at(14, 50)),
    );
  });

  it('sorts chronologically when read as text', () => {
    // Zero padding matters only for a human reading psql output, which is
    // exactly when it matters.
    const early = runBucket('portfolio_scan', DATE, at(2, 0));
    const late = runBucket('portfolio_scan', DATE, at(20, 0));
    expect(early < late).toBe(true);
  });

  it('falls back to a daily bucket for an unknown kind', () => {
    // A new kind should under-run rather than hammer, until someone chooses.
    expect(runBucket('not_a_real_kind', DATE, at(14, 0))).toBe(DATE);
  });
});
