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

export const observationSchema = z.object({
  kind: z.string(),
  severity: z.enum(['info', 'notable', 'high']),
  subject_ref: z.string(),
  as_of: z.string(),
  headline: z.string(),
  explanation: z.string(),
  // Evidence is deliberately unconstrained: it is the rule's own record of what
  // it measured, and every rule carries different figures. Narrowing it here
  // would mean editing this file whenever a rule learns to record one more
  // number, which is exactly the coupling the validator does not need.
  evidence: z.record(z.string(), z.unknown()).optional(),
  concept_refs: z.array(z.string()).optional(),
  dedupe_key: z.string(),
  narration_source: z.enum(['llm', 'template']),
  // Required, not optional: it carries a plain default of "none", which pydantic
  // publishes as a default and the generator therefore treats as always present.
  fallback_reason: z.string(),
});

// Counters carry plain defaults, which pydantic publishes as a `default` and the
// generator therefore treats as always present. The two collections use
// default_factory, which publishes no default and so arrives optional. Matching
// that split exactly is the whole point of the assertions below.
export const scanStatsSchema = z.object({
  subjects: z.number().int(),
  subjects_with_history: z.number().int(),
  findings: z.number().int(),
  already_known: z.number().int(),
  narrated_by_llm: z.number().int(),
  narration_fallbacks: z.record(z.string(), z.number().int()).optional(),
  drift_skipped_reason: z.string().nullish(),
  insufficient_history: z.array(z.string()).optional(),
});

export const portfolioScanResponseSchema = z.object({
  observations: z.array(observationSchema),
  stats: scanStatsSchema,
});

export const backfillResponseSchema = z.object({
  written: z.number().int(),
  already_present: z.number().int(),
  per_symbol: z.record(z.string(), z.number().int()).optional(),
  without_history: z.array(z.string()).optional(),
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
export type _AssertObservation = Expect<
  Equal<z.infer<typeof observationSchema>, Schemas['ObservationOut']>
>;
export type _AssertScanStats = Expect<Equal<z.infer<typeof scanStatsSchema>, Schemas['ScanStatsOut']>>;
export type _AssertBackfill = Expect<
  Equal<z.infer<typeof backfillResponseSchema>, Schemas['BackfillResponse']>
>;
export type _AssertPortfolioScan = Expect<
  Equal<z.infer<typeof portfolioScanResponseSchema>, Schemas['PortfolioScanResponse']>
>;
export const narrationConfigSchema = z.object({
  provider: z.string(),
  model: z.string().nullable(),
  tier: z.enum(['free', 'paid', 'none']),
  daily_budget_usd: z.string(),
});

export type _AssertNarrationConfig = Expect<
  Equal<z.infer<typeof narrationConfigSchema>, Schemas['NarrationConfigResponse']>
>;

export const conceptSectionSchema = z.object({
  id: z.string(),
  ord: z.number(),
  heading: z.string().nullable(),
  text: z.string(),
});

export const conceptDocumentSchema = z.object({
  slug: z.string(),
  title: z.string(),
  source: z.string(),
  uri: z.string().nullable(),
  license: z.string(),
  sections: z.array(conceptSectionSchema),
});

export const askCitationSchema = z.object({
  chunk_id: z.string(),
  document_id: z.string(),
  concept_slug: z.string().nullable(),
  title: z.string(),
  heading: z.string().nullable(),
  // Verbatim. A citation the reader cannot read is a footnote, not evidence,
  // and the whole claim of `/ask` is that its answers are checkable.
  text: z.string(),
  similarity: z.number().nullable(),
});

export const askResponseSchema = z.object({
  question: z.string(),
  intent: z.enum(['concept', 'portfolio']),
  // The field to branch on. A refusal is a 200 with `answered: false`, because
  // declining an out-of-index question is an outcome the milestone requires the
  // product to do well - not a fault to be signalled with a status code.
  answered: z.boolean(),
  text: z.string(),
  // Optional, not missing-by-accident: these three use default_factory, which
  // pydantic publishes with no `default`, so the generator treats them as
  // optional. `fallback_reason` below carries a plain default and therefore
  // arrives required. Matching that split exactly is what the assertions at the
  // bottom of this file are for.
  citations: z.array(askCitationSchema).optional(),
  concept_refs: z.array(z.string()).optional(),
  evidence: z.record(z.string(), z.unknown()).optional(),
  // `computed` is arithmetic over the caller's holdings and is never a model:
  // a plausible wrong number about someone's money is the worst output this
  // product could produce.
  answer_source: z.enum(['extractive', 'llm', 'computed', 'none']),
  fallback_reason: z.string(),
  // `weak` means answered, but the match sat close to the noise floor. Three
  // states rather than two because the measurement behind the threshold
  // supported three - see app/ask/relevance.py.
  relevance: z.enum(['confident', 'weak', 'none']),
  best_similarity: z.number().nullish(),
  refused_reason: z.string().nullish(),
  vector_is_semantic: z.boolean(),
});

export type _AssertAskCitation = Expect<
  Equal<z.infer<typeof askCitationSchema>, Schemas['AskCitation']>
>;
export type _AssertAskResponse = Expect<
  Equal<z.infer<typeof askResponseSchema>, Schemas['AskResponse']>
>;

export const conceptSearchMatchSchema = z.object({
  chunk_id: z.string(),
  document_id: z.string(),
  concept_slug: z.string().nullable(),
  title: z.string(),
  heading: z.string().nullable(),
  ord: z.number(),
  text: z.string(),
  score: z.number(),
  // Null means that half of the hybrid did not return this chunk at all, which
  // is a different statement from ranking it last. A null `vector_rank` on
  // every match is how a reader can tell the corpus has never been embedded -
  // a state that otherwise looks exactly like working hybrid retrieval.
  vector_rank: z.number().nullable(),
  text_rank: z.number().nullable(),
});

export const conceptSearchResponseSchema = z.object({
  query: z.string(),
  matches: z.array(conceptSearchMatchSchema),
  embedding_model: z.string(),
  // False while the configured embedder ranks by word overlap alone. On the
  // wire rather than in a log, because a ranking produced by shared words is
  // indistinguishable from one produced by understanding the question, and the
  // difference is the whole of the owed embeddings migration.
  vector_is_semantic: z.boolean(),
});

export type _AssertConceptSearchMatch = Expect<
  Equal<z.infer<typeof conceptSearchMatchSchema>, Schemas['ConceptSearchMatch']>
>;
export type _AssertConceptSearchResponse = Expect<
  Equal<z.infer<typeof conceptSearchResponseSchema>, Schemas['ConceptSearchResponse']>
>;

export type _AssertConceptSection = Expect<
  Equal<z.infer<typeof conceptSectionSchema>, Schemas['ConceptSection']>
>;
export type _AssertConceptDocument = Expect<
  Equal<z.infer<typeof conceptDocumentSchema>, Schemas['ConceptDocumentResponse']>
>;

export type _AssertHealthResponse = Expect<
  Equal<z.infer<typeof healthResponseSchema>, Schemas['HealthResponse']>
>;
