/**
 * Fill in display names for instruments that have none.
 *
 * Instrument rows are created by the holdings and import paths, which write
 * whatever the market-data provider returned. For a long while that was nothing:
 * the Yahoo provider read only `fast_info`, which publishes no display name, so
 * every instrument it resolved landed with `name = NULL` while the fixture
 * provider's handful of symbols carried names. The UI then showed a company name
 * under some symbols and not others, which reads as a bug rather than as absent
 * data.
 *
 * The provider now supplies a name, but nothing re-resolves a row that already
 * exists - `upsertInstrument` runs only on a holding write or an import. This is
 * what closes that gap, for the rows already in the database and for any symbol
 * the provider could not name at the time it was first seen.
 *
 * Guideline 7 holds throughout: a symbol the provider still cannot name keeps a
 * null name. Nothing here derives a name from the symbol.
 *
 * One thing to expect rather than debug: the AI service caches a successful
 * resolution for `cache_ttl_history` (12 hours), so a symbol resolved shortly
 * before the provider learned to read names is served from that cache, without
 * one, until the entry expires. The first run after a deploy can therefore name
 * fewer rows than there are gaps; the run is daily and idempotent, so the next
 * one picks them up.
 */

import type { AiClient } from '@traders/shared/ai';

import { listInstrumentsWithoutName, setInstrumentName } from '../db/queries.js';
import { logger } from '../logger.js';

export interface InstrumentMetadataResult {
  /** Instruments that had no name when the run started. */
  examined: number;
  /** Instruments that now have one. */
  named: number;
  /** Instruments the provider still cannot name; they keep a null name. */
  stillUnnamed: string[];
  /** Symbols whose resolution call failed outright, as opposed to returning no name. */
  failed: string[];
}

/**
 * How many instruments one run will look at. Each one is an upstream request,
 * and the run is idempotent, so a portfolio with a long tail of unnamed symbols
 * simply finishes over several days instead of hammering the provider once.
 */
export const METADATA_BATCH_SIZE = 50;

/** Resolutions run concurrently but bounded, matching the importer's fan-out. */
const CONCURRENCY = 8;

export async function backfillInstrumentNames(
  ai: AiClient,
  requestId?: string,
): Promise<InstrumentMetadataResult> {
  const pending = await listInstrumentsWithoutName(METADATA_BATCH_SIZE);
  const result: InstrumentMetadataResult = {
    examined: pending.length,
    named: 0,
    stillUnnamed: [],
    failed: [],
  };
  if (pending.length === 0) return result;

  for (let index = 0; index < pending.length; index += CONCURRENCY) {
    const batch = pending.slice(index, index + CONCURRENCY);
    await Promise.all(
      batch.map(async (instrument) => {
        let name: string | null = null;
        try {
          const resolution = await ai.resolveInstrument(instrument.symbol, requestId);
          name = resolution.resolved?.name ?? null;
        } catch (error) {
          logger().warn(
            { symbol: instrument.symbol, err: error },
            'instrument name resolution failed',
          );
          result.failed.push(instrument.symbol);
          return;
        }
        if (!name) {
          result.stillUnnamed.push(instrument.symbol);
          return;
        }
        if (await setInstrumentName(instrument.id, name)) result.named += 1;
      }),
    );
  }

  result.stillUnnamed.sort();
  result.failed.sort();
  return result;
}
