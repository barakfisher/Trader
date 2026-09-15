/**
 * Runtime schemas for every AI-service response the client returns.
 *
 * Why these exist: the AI service is a separate process written in another
 * language. TypeScript has never seen its code, so `JSON.parse(...) as T` in the
 * client was a promise rather than a check. When a field went missing - a
 * deployed service one version behind, a provider returning null where the
 * pydantic model allows it - `price_minor` became `undefined`, `scaleMinor`
 * returned NaN and the dashboard rendered a plausible wrong number with no error
 * anywhere. Guideline 7 says a failure must be visible, so the boundary now
 * parses instead of casting.
 *
 * Why the assertions at the bottom: pydantic is the single source of truth for
 * these shapes, reaching TypeScript through `services/ai/openapi.json` and the
 * generated `../generated/ai-api.d.ts`. A hand-written zod schema is a second,
 * independent description of the same contract, and two descriptions drift -
 * which is the exact problem the codegen exists to prevent. So every schema is
 * pinned to its generated counterpart by `Expect<Equal<...>>`: the assertion
 * holds only if the schema's inferred type is structurally identical to the
 * generated one, field for field, including optionality and nullability.
 *
 * The practical consequence: change a pydantic model, regenerate, and this file
 * stops compiling until the schema is updated. `pnpm -r typecheck` in CI is
 * therefore the drift alarm. Nothing here may be loosened to `z.any()`,
 * `.passthrough()` on a required field or a cast - each would silence the alarm
 * while leaving the schema wrong.
 *
 * Validation is deliberately no stricter than the contract. Anything the wire
 * format genuinely guarantees is enforced (minor units are integers, not floats
 * or NaN; decimal strings actually parse as decimals, because `Number('n/a')` is
 * the NaN that starts the silent-wrong-number chain). Timestamps stay plain
 * strings: Python's ISO output varies between `Z` and `+00:00` offsets, and
 * rejecting a valid response would degrade a whole portfolio to unpriced for no
 * gain in correctness.
 */

import { z } from 'zod';

import type { components } from '../generated/ai-api.js';

/**
 * A decimal number carried as a string, per guideline 4. Matches what
 * `parseToMinor` and `convertMinor` in money.ts are able to read; an
 * unparseable rate silently converts to zero or NaN downstream.
 */
const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'expected a decimal number as a string');

/** Integer minor units. A float or NaN here is a contract violation, not a price. */
const minorUnits = z.number().int();

export const instrumentSchema = z.object({
  asset_class: z.enum(['equity', 'etf', 'crypto', 'fx', 'index', 'unknown']),
  currency: z.string(),
  exchange: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  source: z.string(),
  symbol: z.string(),
});

export const quoteSchema = z.object({
  as_of: z.string(),
  currency: z.string(),
  day_change_pct: z.number().nullable().optional(),
  delay_seconds: z.number(),
  previous_close_minor: minorUnits.nullable().optional(),
  price_minor: minorUnits,
  source: z.string(),
  stale: z.boolean(),
  symbol: z.string(),
});

export const quoteResponseSchema = z.object({
  missing: z.array(z.string()).optional(),
  quotes: z.array(quoteSchema),
});

export const instrumentResolutionSchema = z.object({
  candidates: z.array(instrumentSchema).optional(),
  confidence: z.number(),
  query: z.string(),
  reason: z.string().nullable().optional(),
  resolved: instrumentSchema.nullable().optional(),
});

export const fxRateSchema = z.object({
  as_of: z.string(),
  base: z.string(),
  quote: z.string(),
  rate: decimalString,
  source: z.string(),
});

export const healthResponseSchema = z.object({
  checks: z.record(z.string(), z.string()).optional(),
  service: z.string(),
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
});

// --- Compile-time drift detection -------------------------------------------
//
// `Equal` is the standard function-identity trick: two types are identical only
// if the compiler cannot distinguish the conditional types built from them, so
// it rejects the near-misses a plain `extends` check waves through - a widened
// `string`, an added field, an optional that became required.

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type Expect<T extends true> = T;

type Schemas = components['schemas'];

// Each line fails to compile if the schema above and the generated type from
// pydantic have parted ways. Do not delete one to make a build pass.
export type _AssertInstrument = Expect<
  Equal<z.infer<typeof instrumentSchema>, Schemas['Instrument']>
>;
export type _AssertQuote = Expect<Equal<z.infer<typeof quoteSchema>, Schemas['Quote']>>;
export type _AssertQuoteResponse = Expect<
  Equal<z.infer<typeof quoteResponseSchema>, Schemas['QuoteResponse']>
>;
export type _AssertInstrumentResolution = Expect<
  Equal<z.infer<typeof instrumentResolutionSchema>, Schemas['InstrumentResolution']>
>;
export type _AssertFxRate = Expect<Equal<z.infer<typeof fxRateSchema>, Schemas['FxRate']>>;
export type _AssertHealthResponse = Expect<
  Equal<z.infer<typeof healthResponseSchema>, Schemas['HealthResponse']>
>;
