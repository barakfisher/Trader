/**
 * Target weights: the user's own statement of what they meant their allocation
 * to be.
 *
 * This is the input the allocation-drift rule has been waiting for. It matters
 * that the number comes from the user and not from us: drift is then an
 * observation about the distance between their intent and their portfolio,
 * which is something we can show them, rather than an opinion about what they
 * ought to hold, which we do not give (project guideline 2).
 *
 * The whole set is written at once. See `replaceTargetWeights` for why.
 */

import type { Hono } from 'hono';
import { z } from 'zod';

import {
  findInstrumentsBySymbols,
  listTargetWeights,
  primaryAgentId,
  replaceTargetWeights,
} from '../../db/queries.js';
import { currentUserId, type AppEnv } from '../app.js';
import { badRequest, unprocessable } from '../errors.js';

/**
 * `target_weights.weight` is `numeric(6, 4)`, so four decimal places is the
 * finest distinction the database can keep. Accepting more would silently round
 * the user's input on the way in, and a target is a number they will later
 * compare against the drift we report to them.
 */
const WEIGHT_DECIMAL_PLACES = 4;

/** A whole portfolio, in the integer units a four-decimal weight is counted in. */
const WEIGHT_SCALE = 10 ** WEIGHT_DECIMAL_PLACES;

/**
 * A ceiling on the size of one statement. It is far above any real allocation
 * and exists only so a malformed client cannot ask for an unbounded INSERT.
 */
const MAX_TARGETS = 500;

const WEIGHT_PATTERN = new RegExp(`^\\d+(\\.\\d{1,${WEIGHT_DECIMAL_PLACES}})?$`);

const putSchema = z.object({
  // An array rather than an object keyed by symbol: a JSON object silently
  // collapses a repeated key to its last value, and a payload naming the same
  // instrument twice is a client bug we would rather report than resolve.
  targets: z
    .array(
      z.object({
        symbol: z.string().min(1).max(32),
        // A decimal string, like quantity: the weight must not round through a
        // float on its way from the client to `numeric(6, 4)`.
        weight: z
          .string()
          .regex(WEIGHT_PATTERN, `weight must be a decimal string with at most ${WEIGHT_DECIMAL_PLACES} decimal places`),
      }),
    )
    .max(MAX_TARGETS),
});

/**
 * Exact conversion of a validated weight string to integer ten-thousandths, so
 * every bound and the sum are checked in integer arithmetic. `Number(weight)`
 * would be a float, and 0.1 + 0.2 deciding whether a user's allocation is legal
 * is exactly the class of bug guideline 3 exists to prevent.
 */
function toScaledWeight(weight: string): number {
  const [whole, fraction = ''] = weight.split('.');
  const padded = fraction.padEnd(WEIGHT_DECIMAL_PLACES, '0');
  return Number(whole) * WEIGHT_SCALE + Number(padded || '0');
}

/** The inverse, also in integer arithmetic: no division by 10000 in a float. */
function fromScaledWeight(scaled: number): string {
  const whole = Math.floor(scaled / WEIGHT_SCALE);
  const fraction = String(scaled % WEIGHT_SCALE).padStart(WEIGHT_DECIMAL_PLACES, '0');
  return `${whole}.${fraction}`;
}

export function registerTargetsRoutes(app: Hono<AppEnv>): void {
  app.get('/targets', async (context) => {
    const userId = currentUserId(context);
    const rows = await listTargetWeights(userId, await primaryAgentId(userId));
    return context.json({
      targets: rows.map((row) => ({
        symbol: row.symbol,
        name: row.name,
        // As stored, not as typed: '0.25' comes back '0.2500' because that is
        // what the database holds. Same number, no float in between.
        weight: row.weight,
      })),
    });
  });

  app.put('/targets', async (context) => {
    const userId = currentUserId(context);
    const parsed = putSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      throw badRequest('invalid_body', 'target weights payload failed validation', parsed.error.issues);
    }

    const requested = parsed.data.targets.map((target) => ({
      symbol: target.symbol.trim().toUpperCase(),
      weight: target.weight,
      scaled: toScaledWeight(target.weight),
    }));

    const duplicates = requested
      .map((target) => target.symbol)
      .filter((symbol, index, all) => all.indexOf(symbol) !== index);
    if (duplicates.length > 0) {
      throw unprocessable('duplicate_symbol', 'each symbol may appear at most once', {
        symbols: [...new Set(duplicates)],
      });
    }

    // Each weight is a share of one portfolio, so no single one can exceed the
    // whole. The database CHECK says the same thing; saying it here turns a
    // constraint violation into an error the client can act on.
    const outOfRange = requested.filter((target) => target.scaled > WEIGHT_SCALE);
    if (outOfRange.length > 0) {
      throw unprocessable('weight_out_of_range', 'each weight must be between 0 and 1', {
        symbols: outOfRange.map((target) => target.symbol),
      });
    }

    /**
     * The set may sum to less than 1 - targeting three of eight holdings is a
     * normal thing to do, and the drift rule reports the sum rather than
     * renormalising against it. It may not sum to more than 1: that describes a
     * portfolio larger than itself, so no allocation could ever satisfy it and
     * every drift computed against it would be permanent. The database cannot
     * catch this, because its CHECK only bounds one row at a time.
     */
    const total = requested.reduce((sum, target) => sum + target.scaled, 0);
    if (total > WEIGHT_SCALE) {
      throw unprocessable('weights_exceed_one', 'target weights must sum to at most 1', {
        sum: fromScaledWeight(total),
      });
    }

    const instruments = await findInstrumentsBySymbols(requested.map((target) => target.symbol));
    const bySymbol = new Map(instruments.map((instrument) => [instrument.symbol, instrument]));
    /**
     * A symbol we have never resolved is rejected rather than resolved now.
     * Two reasons. The instrument row has to exist for the foreign key, and the
     * only thing that puts one there is a holding or an import - so an unknown
     * symbol here is overwhelmingly a typo, and a typo that silently created an
     * instrument would sit in the user's targets drifting against nothing.
     * Keeping the write free of provider calls also means a market-data outage
     * can never stop someone correcting or clearing their own targets.
     */
    const unknown = requested.filter((target) => !bySymbol.has(target.symbol));
    if (unknown.length > 0) {
      throw unprocessable(
        'unknown_symbol',
        'a target may only name an instrument this portfolio already knows',
        { symbols: unknown.map((target) => target.symbol) },
      );
    }

    /**
     * A target on an instrument the user does not currently hold is allowed.
     * "I meant to hold 10% of this and I hold none of it" is a true statement
     * about their intent and the drift rule already treats it as one (see
     * `allocation_drift.py`: an unheld target has an exact actual weight of
     * zero). Rejecting it would also make selling out of a position quietly
     * delete the intention behind it.
     */
    const stored = await replaceTargetWeights(
      userId,
      await primaryAgentId(userId),
      requested.map((target) => ({
        instrumentId: bySymbol.get(target.symbol)!.id,
        weight: target.weight,
      })),
    );

    return context.json({
      targets: requested.map((target) => ({ symbol: target.symbol, weight: target.weight })),
      count: stored,
      sum: fromScaledWeight(total),
    });
  });
}

export { MAX_TARGETS, WEIGHT_DECIMAL_PLACES, WEIGHT_SCALE };
