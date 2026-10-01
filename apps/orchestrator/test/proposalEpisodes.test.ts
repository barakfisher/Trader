/**
 * Proposal episodes (decision 92): a standing finding is asked about once.
 *
 * The database is an in-memory stand-in for `proposal_episodes` with its
 * partial unique index, so what is under test is the policy - when a subject is
 * asked again, and when it is not. The centre of the file is the week that
 * motivated it, replayed from compose: seven days of BTC-USD drift at
 * 0.149-0.153 on the 0.15 line, which used to raise seven proposals.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Episode {
  id: string;
  userId: string;
  kind: string;
  subjectRef: string;
  asked: string;
  closedReason: string | null;
}

const store: Episode[] = [];

vi.mock('../src/db/queries.js', () => ({
  listOpenEpisodes: vi.fn(async (userId: string, kind: string) =>
    store
      .filter((row) => row.userId === userId && row.kind === kind && row.closedReason === null)
      .map((row) => ({ id: row.id, subject_ref: row.subjectRef, asked_magnitude: row.asked })),
  ),
  claimEpisode: vi.fn(
    async (episode: {
      userId: string;
      observationKind: string;
      subjectRef: string;
      askedMagnitude: string;
    }) => {
      const taken = store.some(
        (row) =>
          row.userId === episode.userId &&
          row.kind === episode.observationKind &&
          row.subjectRef === episode.subjectRef &&
          row.closedReason === null,
      );
      if (taken) return null;
      const id = `episode-${store.length + 1}`;
      store.push({
        id,
        userId: episode.userId,
        kind: episode.observationKind,
        subjectRef: episode.subjectRef,
        asked: episode.askedMagnitude,
        closedReason: null,
      });
      return id;
    },
  ),
  closeEpisodes: vi.fn(async (_userId: string, ids: string[], reason: string) => {
    let closed = 0;
    for (const row of store) {
      if (ids.includes(row.id) && row.closedReason === null) {
        row.closedReason = reason;
        closed += 1;
      }
    }
    return closed;
  }),
}));

const queries = await import('../src/db/queries.js');
const { admitCandidates, bandStep, compareWithAsked, isResolved, settleEpisodes, toFixed18 } =
  await import('../src/services/proposalEpisodes.js');

const USER = '00000000-0000-0000-0000-000000000001';
const SUBJECT = 'portfolio:allocation:BTC-USD';
const BANDS = { high: 0.15, notable: 0.1, info: 0.05 };
const DRIFT_RAN = { allocation_drift: true };

function severityOf(drift: string): 'high' | 'notable' | 'info' | null {
  const size = Math.abs(Number(drift));
  if (size >= BANDS.high) return 'high';
  if (size >= BANDS.notable) return 'notable';
  if (size >= BANDS.info) return 'info';
  return null;
}

let observation = 0;
function candidate(drift: string, overrides: Record<string, unknown> = {}) {
  observation += 1;
  return {
    id: `observation-${observation}`,
    kind: 'allocation_drift',
    severity: severityOf(drift) ?? 'info',
    subjectRef: SUBJECT,
    evidence: { drift, thresholds_weight: BANDS },
    ...overrides,
  };
}

/** One scan: settle on what was seen, then admit the drift if it is new and high. */
async function scan(drift: string, options: { isNew?: boolean; ruleRan?: boolean } = {}) {
  const severity = severityOf(drift);
  const seen =
    severity === null ? [] : [{ kind: 'allocation_drift', subject_ref: SUBJECT, severity }];
  await settleEpisodes(
    USER,
    seen,
    { allocation_drift: options.ruleRan ?? true },
    'high',
  );
  if (severity !== 'high' || options.isNew === false) return 0;
  const { admitted } = await admitCandidates(USER, [candidate(drift)], 'high');
  return admitted.length;
}

beforeEach(() => {
  store.length = 0;
  vi.clearAllMocks();
});

describe('the rules, without a database', () => {
  it('reads decimals exactly, never through a float', () => {
    expect(toFixed18('0.150619')).toBe(150_619_000_000_000_000n);
    expect(toFixed18('-0.2')).toBe(-200_000_000_000_000_000n);
    expect(toFixed18('1')).toBe(1_000_000_000_000_000_000n);
  });

  it('resolves only below the band beneath the floor, so hovering on the line is not a resolution', () => {
    expect(isResolved('notable', 'high')).toBe(false);
    expect(isResolved('info', 'high')).toBe(true);
    expect(isResolved(undefined, 'high')).toBe(true);
    expect(isResolved('info', 'notable')).toBe(false);
    expect(isResolved(undefined, 'notable')).toBe(true);
  });

  it('never resolves on a severity it cannot read', () => {
    expect(isResolved('severe', 'high')).toBe(false);
  });

  it('takes one band from the thresholds the finding carries', () => {
    expect(bandStep(BANDS, 'high')).toBe(toFixed18('0.05'));
    expect(bandStep(BANDS, 'notable')).toBe(toFixed18('0.05'));
    expect(bandStep(BANDS, 'info')).toBe(toFixed18('0.05'));
    expect(bandStep(undefined, 'high')).toBeNull();
  });

  it('holds, worsens by a full band, or reverses on a change of sign', () => {
    const step = toFixed18('0.05');
    const asked = toFixed18('0.150619');
    expect(compareWithAsked(asked, toFixed18('0.2'), step)).toBe('held');
    expect(compareWithAsked(asked, toFixed18('0.200619'), step)).toBe('worsened');
    expect(compareWithAsked(asked, toFixed18('-0.16'), step)).toBe('reversed');
  });
});

describe('the measured week (BTC-USD, 24 Sep - 1 Oct 2026)', () => {
  it('asks once where it used to ask every day', async () => {
    // Each day: the morning's new "high" observation, and the same day's dips
    // to "notable" that crossed the line - the sequence stored on compose.
    const week: [string, boolean][] = [
      ['0.150619', true],
      ['0.149125', false],
      ['0.152957', true],
      ['0.150302', true],
      ['0.151486', true],
      ['0.150073', true],
      ['0.149142', false],
      ['0.150246', true],
      ['0.149554', false],
      ['0.151565', true],
      ['0.149194', false],
      ['0.151303', true],
    ];
    let asked = 0;
    for (const [drift, isNew] of week) asked += await scan(drift, { isNew });
    expect(asked).toBe(1);
  });
});

describe('when the subject is asked about again', () => {
  it('after the drift has resolved below the band and come back', async () => {
    expect(await scan('0.16')).toBe(1);
    expect(await scan('0.16')).toBe(0);
    await scan('0.04'); // below info: no finding at all
    expect(store[0]!.closedReason).toBe('resolved');
    expect(await scan('0.16')).toBe(1);
  });

  it('not after a dip to notable', async () => {
    await scan('0.16');
    await scan('0.12');
    expect(await scan('0.16')).toBe(0);
  });

  it('not when the rule did not run - an unpriced portfolio is not a resolved one', async () => {
    await scan('0.16');
    await scan('0.04', { ruleRan: false });
    expect(store[0]!.closedReason).toBeNull();
    expect(await scan('0.16')).toBe(0);
  });

  it('when the drift has worsened by a full band since the question', async () => {
    await scan('0.150619');
    expect(await scan('0.19')).toBe(0);
    expect(await scan('0.200619')).toBe(1);
    expect(store.map((row) => row.closedReason)).toEqual(['worsened', null]);
  });

  it('when it has turned from overweight to underweight', async () => {
    await scan('0.16');
    expect(await scan('-0.16')).toBe(1);
    expect(store[0]!.closedReason).toBe('reversed');
  });
});

describe('what passes through untouched', () => {
  it('a finding whose evidence cannot be read is asked about, as before', async () => {
    const { admitted } = await admitCandidates(
      USER,
      [candidate('0.16', { evidence: { thresholds_weight: BANDS } })],
      'high',
    );
    expect(admitted).toHaveLength(1);
    expect(queries.claimEpisode).not.toHaveBeenCalled();
  });

  it('a kind with no episode policy is asked about, as before', async () => {
    const { admitted } = await admitCandidates(
      USER,
      [candidate('0.16', { kind: 'price_move' })],
      'high',
    );
    expect(admitted).toHaveLength(1);
  });

  it('two candidates for one subject in one scan raise one question', async () => {
    const { admitted, held } = await admitCandidates(
      USER,
      [candidate('0.16'), candidate('0.17')],
      'high',
    );
    expect(admitted).toHaveLength(1);
    expect(held).toBe(1);
  });

  it('a scan that lost the claim to a concurrent one holds', async () => {
    vi.mocked(queries.listOpenEpisodes).mockResolvedValueOnce([]);
    store.push({
      id: 'episode-x',
      userId: USER,
      kind: 'allocation_drift',
      subjectRef: SUBJECT,
      asked: '0.16',
      closedReason: null,
    });
    const { admitted, held } = await admitCandidates(USER, [candidate('0.16')], 'high');
    expect(admitted).toHaveLength(0);
    expect(held).toBe(1);
  });

  it('settles nothing for a kind whose rule did not run', async () => {
    await scan('0.16');
    expect(await settleEpisodes(USER, [], { allocation_drift: false }, 'high')).toBe(0);
    expect(await settleEpisodes(USER, [], DRIFT_RAN, 'high')).toBe(1);
  });
});
