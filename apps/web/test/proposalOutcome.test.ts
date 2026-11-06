import { describe, expect, it } from 'vitest';

import en from '../src/i18n/locales/en.json';
import { closedByNewerView, outcomeAt, outcomeText, transitionText } from '../src/lib/proposalOutcome.ts';

describe('outcomeText', () => {
  it('names where a decision was made', () => {
    expect(outcomeText({ state: 'approved', decidedVia: 'telegram' })).toBe('Approved from Telegram');
    expect(outcomeText({ state: 'rejected', decidedVia: 'web' })).toBe('Rejected in the app');
  });

  it('says an expiry is unanswered, never a choice', () => {
    expect(outcomeText({ state: 'expired', decidedVia: 'system' })).toBe('Expired unanswered');
  });
});

describe('transitionText', () => {
  const at = '2026-09-24T13:18:58.000Z';

  it('reads a user decision with its surface', () => {
    expect(
      transitionText({ from: 'pending', to: 'approved', surface: 'telegram', byUser: true, at }),
    ).toBe('Open → Approved, from Telegram');
  });

  it('reads an expiry as the deadline passing, not as someone - and not as the deadline itself', () => {
    expect(
      transitionText({ from: 'pending', to: 'expired', surface: 'system', byUser: false, at }),
    ).toBe('Open → Expired, recorded after its deadline passed');
  });

  it('reads an approval moved back to open as an undo', () => {
    expect(
      transitionText({ from: 'approved', to: 'pending', surface: 'web', byUser: true, at }),
    ).toBe('Approval undone in the app');
  });
});

it('dates an expiry by its deadline, not by when the sweep recorded it', async () => {
  const { outcomeAt } = await import('../src/lib/proposalOutcome.ts');
  const recorded = '2026-09-28T10:18:01.000Z';
  const deadline = '2026-09-28T06:40:16.000Z';
  expect(outcomeAt({ state: 'expired', decidedAt: recorded, expiresAt: deadline })).toBe(deadline);
  expect(outcomeAt({ state: 'approved', decidedAt: recorded, expiresAt: deadline })).toBe(recorded);
});

describe('a view a newer one closed (D392, D393)', () => {
  const closed = { state: 'expired', decidedVia: 'system', decidedAt: '2026-11-02T10:00:00Z', expiresAt: '2026-11-08T10:00:00Z' } as const;

  it('says so, at the time it closed, rather than claiming its deadline passed', () => {
    expect(closedByNewerView(closed)).toBe(true);
    expect(outcomeAt(closed)).toBe(closed.decidedAt);
    expect(outcomeText(closed)).toBe(en.proposal.closedByNewerView);
    expect(
      transitionText({ from: 'pending', to: 'expired', surface: 'system', byUser: false, at: closed.decidedAt }, closed.expiresAt),
    ).toContain(en.proposal.closedByNewerViewMove.replace('{{move}}, ', ''));
  });

  it('leaves an expiry the sweep recorded after its deadline as it was', () => {
    const lapsed = { ...closed, decidedAt: '2026-11-08T12:00:00Z' };
    expect(closedByNewerView(lapsed)).toBe(false);
    expect(outcomeAt(lapsed)).toBe(lapsed.expiresAt);
    expect(outcomeText(lapsed)).toBe(en.proposal.expiredUnanswered);
  });
});
