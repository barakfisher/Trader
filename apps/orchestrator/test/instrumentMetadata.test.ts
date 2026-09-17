/**
 * Backfilling instrument display names.
 *
 * The rule under test is guideline 7 applied to a cosmetic field: a name the
 * provider does not have stays null, and the run says so, rather than falling
 * back to the symbol so that every row looks equally complete. The database is
 * mocked - what matters here is which rows are written, not the SQL that writes
 * them.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/queries.js', () => ({
  listInstrumentsWithoutName: vi.fn(async () => []),
  setInstrumentName: vi.fn(async () => true),
}));

const queries = await import('../src/db/queries.js');
const { backfillInstrumentNames, METADATA_BATCH_SIZE } =
  await import('../src/services/instrumentMetadata.js');

/** Only the one method the backfill calls; the rest of AiClient is irrelevant. */
function aiResolving(names: Record<string, string | null>) {
  return {
    resolveInstrument: vi.fn(async (query: string) => ({
      query,
      resolved: { symbol: query.toUpperCase(), name: names[query.toUpperCase()] ?? null },
      candidates: [],
      confidence: 0.9,
      reason: 'fake',
    })),
  } as never;
}

describe('backfillInstrumentNames', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.setInstrumentName).mockResolvedValue(true);
  });

  it('writes the name the provider supplies', async () => {
    vi.mocked(queries.listInstrumentsWithoutName).mockResolvedValueOnce([
      { id: 'instrument-msft', symbol: 'MSFT' },
    ]);

    const result = await backfillInstrumentNames(aiResolving({ MSFT: 'Microsoft Corporation' }));

    expect(queries.setInstrumentName).toHaveBeenCalledWith(
      'instrument-msft',
      'Microsoft Corporation',
    );
    expect(result).toMatchObject({ examined: 1, named: 1, stillUnnamed: [], failed: [] });
  });

  it('leaves a name the provider does not have null instead of using the symbol', async () => {
    vi.mocked(queries.listInstrumentsWithoutName).mockResolvedValueOnce([
      { id: 'instrument-zzz', symbol: 'ZZZZ.TA' },
    ]);

    const result = await backfillInstrumentNames(aiResolving({}));

    expect(queries.setInstrumentName).not.toHaveBeenCalled();
    expect(result).toMatchObject({ examined: 1, named: 0, stillUnnamed: ['ZZZZ.TA'] });
  });

  it('reports a failed resolution separately from an absent name', async () => {
    // The two look identical in the database - both leave a null name - but only
    // one of them means the provider was asked and answered.
    vi.mocked(queries.listInstrumentsWithoutName).mockResolvedValueOnce([
      { id: 'instrument-a', symbol: 'AAA' },
      { id: 'instrument-b', symbol: 'BBB' },
    ]);
    const ai = {
      resolveInstrument: vi.fn(async (query: string) => {
        if (query === 'AAA') throw new Error('provider unreachable');
        return {
          query,
          resolved: { symbol: 'BBB', name: null },
          candidates: [],
          confidence: 0.9,
          reason: 'fake',
        };
      }),
    } as never;

    const result = await backfillInstrumentNames(ai);

    expect(result.failed).toEqual(['AAA']);
    expect(result.stillUnnamed).toEqual(['BBB']);
    expect(result.named).toBe(0);
  });

  it('does not count a row another writer named first', async () => {
    // `setInstrumentName` only fills a null name, so a concurrent import that
    // named the row wins and this run must not claim the write as its own.
    vi.mocked(queries.listInstrumentsWithoutName).mockResolvedValueOnce([
      { id: 'instrument-msft', symbol: 'MSFT' },
    ]);
    vi.mocked(queries.setInstrumentName).mockResolvedValueOnce(false);

    const result = await backfillInstrumentNames(aiResolving({ MSFT: 'Microsoft Corporation' }));

    expect(result.named).toBe(0);
  });

  it('asks the provider for nothing when no row is missing a name', async () => {
    const ai = aiResolving({});

    const result = await backfillInstrumentNames(ai);

    expect(result).toMatchObject({ examined: 0, named: 0 });
    expect(
      (ai as unknown as { resolveInstrument: ReturnType<typeof vi.fn> }).resolveInstrument,
    ).not.toHaveBeenCalled();
  });

  it('bounds one run to the configured batch size', async () => {
    await backfillInstrumentNames(aiResolving({}));

    expect(queries.listInstrumentsWithoutName).toHaveBeenCalledWith(METADATA_BATCH_SIZE);
  });
});
