/**
 * Finding episodes (decision 132): when a standing state's episode ends.
 *
 * Ending one re-arms the finding, so the cost of closing wrongly is a repeated
 * observation - the very noise the episode exists to remove. The cases below
 * are the ways "the scan found nothing" can mean "the scan did not look".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/queries.js', () => ({
  recordFindingEpisode: vi.fn(async () => undefined),
  closeFindingEpisodes: vi.fn(async (_userId: string, ids: string[]) => ids.length),
  listHoldings: vi.fn(async () => []),
  listOpenFindingEpisodes: vi.fn(async () => [
    { id: 'e9', kind: 'drawdown', subject_ref: 'instrument:SMR', severity: 'high' },
  ]),
}));

const queries = await import('../src/db/queries.js');
const { endedEpisodes, settleFindingEpisodes, wasMeasured } =
  await import('../src/services/findingEpisodes.js');

const USER = '00000000-0000-0000-0000-000000000001';
const AGENT = '90000000-0000-0000-0000-000000000001';

const drawdown = { id: 'e1', kind: 'drawdown', subject_ref: 'instrument:SMR', severity: 'high' };
const drift = {
  id: 'e2',
  kind: 'allocation_drift',
  subject_ref: 'portfolio:allocation:BTC-USD',
  severity: 'notable',
};

beforeEach(() => vi.clearAllMocks());

describe('endedEpisodes', () => {
  it('ends an episode whose subject the scan measured and found nothing for', () => {
    expect(endedEpisodes([drawdown, drift], [], {})).toEqual([drawdown, drift]);
  });

  it('keeps an episode whose state is still seen, at any band', () => {
    const seen = [{ kind: 'drawdown', subject_ref: 'instrument:SMR', severity: 'info' }];
    expect(endedEpisodes([drawdown], seen, {})).toEqual([]);
  });

  it('keeps a drift episode when drift did not run', () => {
    expect(
      endedEpisodes([drift], [], { driftSkippedReason: 'no target weights configured' }),
    ).toEqual([]);
  });

  it('keeps a drawdown episode when the holding had too little history to measure', () => {
    expect(endedEpisodes([drawdown], [], { insufficientHistory: ['SMR'] })).toEqual([]);
  });

  it('never ends an episode of a kind it does not know', () => {
    expect(wasMeasured({ ...drawdown, kind: 'something_new' }, {})).toBe(false);
  });
});

describe('settleFindingEpisodes', () => {
  it('records written states, ignores events, and closes what ended', async () => {
    const ended = await settleFindingEpisodes(
      USER,
      AGENT,
      [drift],
      [
        { id: 'o1', kind: 'drawdown', severity: 'notable', subject_ref: 'instrument:URA' },
        { id: 'o2', kind: 'price_move', severity: 'high', subject_ref: 'instrument:URA' },
      ],
      [{ kind: 'drawdown', subject_ref: 'instrument:URA', severity: 'notable' }],
      {},
    );

    expect(queries.recordFindingEpisode).toHaveBeenCalledTimes(1);
    expect(queries.recordFindingEpisode).toHaveBeenCalledWith({
      userId: USER,
      agentId: AGENT,
      kind: 'drawdown',
      subjectRef: 'instrument:URA',
      severity: 'notable',
      observationId: 'o1',
    });
    expect(queries.closeFindingEpisodes).toHaveBeenCalledWith(USER, ['e2']);
    expect(ended).toBe(1);
  });
});

describe('an empty portfolio', () => {
  it('ends every standing episode, so a holding bought back is announced again', async () => {
    const { runPortfolioScan } = await import('../src/services/portfolioScan.js');
    const user = { id: USER, base_currency: 'USD', timezone: 'UTC' } as never;

    const result = await runPortfolioScan(user, AGENT, {} as never, {} as never, null);

    expect(queries.closeFindingEpisodes).toHaveBeenCalledWith(USER, ['e9']);
    expect(result.findingEpisodesEnded).toBe(1);
    expect(result.skipped).toEqual(['no holdings to analyse']);
  });
});
