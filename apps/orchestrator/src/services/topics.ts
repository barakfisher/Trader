/**
 * Confirming a topic: the user's chosen instruments, with the reasons they
 * were offered (FR-10, M5).
 *
 * Resolution suggests and the user decides. The M5 exit criterion is a
 * *confirmed* set, not a perfect suggestion list: the resolver finds 14 of 35
 * expected tickers on held-out topics, and the add-a-ticker path here is how
 * the rest get in.
 *
 * **Provenance comes from re-resolving, never from the request.** A confirm
 * sends only the label and the symbols. The label is resolved again on the
 * server, and a symbol counts as `resolver` only if the resolver offers it
 * now, with the band, quoted sentence and source ETFs it offers now.
 * Everything else is `user`: a ticker checked with the same instrument lookup
 * a new holding goes through, carrying no reasons at all. The alternative, the
 * browser posting back the rationale it was shown, would let any client write
 * a sentence that the topic card then presents as a quotation from the
 * company's own description.
 *
 * The cost is one more embedding call per confirm, and one edge. If the
 * universe changes between the user seeing a suggestion and confirming it, a
 * ticked instrument that is no longer offered is stored as `user`. That is
 * the honest reading. The reason shown earlier is not what the resolver says
 * now, and storing it would put words in its mouth.
 */

import type { AiClient, InstrumentResolution, TopicCandidate } from '@traders/shared/ai';

import {
  listTopicInstruments,
  getTopic,
  lockTopic,
  lockTopicsForWrite,
  replaceTopicInstruments,
  transaction,
  upsertInstrument,
  writeConfirmedTopic,
  type TopicInstrumentInput,
  type UpsertInstrumentInput,
  type TopicInstrumentRow,
  type TopicRow,
} from '../db/queries.js';

/**
 * Live topics one user may have (PRD risk table: "topic count cap").
 *
 * Every active topic will cost a news fetch and a sentiment pass per
 * topicScan run, plus a line in the daily digest. So the cap bounds scheduled
 * work and the digest's length, not storage. Ten is enough for a person's real
 * interests and small enough that the digest's topic section stays readable.
 * It is a product bound; nothing measured it.
 */
export const MAX_ACTIVE_TOPICS = 10;

/**
 * Instruments one topic may hold. Twice the resolver's fifteen suggestions per
 * interpretation, which leaves room to keep most of an ambiguous topic's two
 * meanings or to add what the resolver missed, without making "a topic" a
 * second portfolio.
 */
export const MAX_INSTRUMENTS_PER_TOPIC = 30;

/** Mirrors the AI service's bound on a topic, which the label is resolved as. */
export const MAX_TOPIC_LABEL_LENGTH = 200;

export interface ConfirmInput {
  userId: string;
  /** Null to create a topic; an id to re-confirm (and possibly relabel) one. */
  topicId: string | null;
  label: string;
  symbols: string[];
}

export type ConfirmOutcome =
  | { ok: true; topic: TopicRow; instruments: TopicInstrumentRow[] }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'limit_reached'; limit: number }
  | { ok: false; reason: 'duplicate_label'; label: string }
  | { ok: false; reason: 'unresolved_symbols'; symbols: string[] };

/** Trimmed, upper-cased, de-duplicated, in the order the user gave them. */
export function normaliseSymbols(symbols: string[]): string[] {
  return [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
}

/** Every candidate the resolver offers for `label`, by symbol, first occurrence kept. */
function offeredBySymbol(interpretations: { candidates: TopicCandidate[] }[]): Map<string, TopicCandidate> {
  const offered = new Map<string, TopicCandidate>();
  for (const interpretation of interpretations) {
    for (const candidate of interpretation.candidates) {
      if (!offered.has(candidate.symbol)) offered.set(candidate.symbol, candidate);
    }
  }
  return offered;
}

function fromResolver(candidate: TopicCandidate): TopicInstrumentInput {
  return {
    instrumentId: candidate.instrument_id,
    source: 'resolver',
    confidence: candidate.confidence,
    rationale: candidate.rationale,
    heldBy: (candidate.held_by ?? []).map((h) => ({ etf: h.etf, weight: h.weight })),
  };
}

type Addition = Required<Omit<UpsertInstrumentInput, 'name' | 'exchange'>> &
  Pick<UpsertInstrumentInput, 'name' | 'exchange'>;

/**
 * Split the requested symbols into what the resolver offers and what the user
 * added, looking each addition up the way a new holding is looked up. Nothing
 * is written here, so a request with one bad ticker writes nothing at all.
 */
/** Told each added symbol's resolution - how the route records universe gaps. */
export type OnResolution = (symbol: string, resolution: InstrumentResolution) => Promise<void>;

async function plan(
  ai: AiClient,
  label: string,
  symbols: string[],
  requestId: string | undefined,
  onResolution?: OnResolution,
): Promise<
  | { ok: true; offered: TopicInstrumentInput[]; additions: Addition[] }
  | { ok: false; unresolved: string[] }
> {
  const resolution = await ai.resolveTopic(label, requestId);
  const offered = offeredBySymbol(resolution.interpretations ?? []);

  const lookups = await Promise.all(
    symbols
      .filter((symbol) => !offered.has(symbol))
      .map(async (symbol) => {
        const result = await ai.resolveInstrument(symbol, requestId);
        await onResolution?.(symbol, result);
        return { symbol, result };
      }),
  );
  const unresolved = lookups.filter((l) => !l.result.resolved).map((l) => l.symbol);
  if (unresolved.length > 0) return { ok: false, unresolved };

  const chosen = new Map<string, TopicInstrumentInput>();
  const additions = new Map<string, Addition>();
  for (const symbol of symbols) {
    const candidate = offered.get(symbol);
    if (candidate) chosen.set(candidate.symbol, fromResolver(candidate));
  }
  for (const { result } of lookups) {
    const found = result.resolved!;
    // "brk.b" can come back as BRK-B. If the lookup lands on an offered
    // instrument, the user ticked a suggestion by another spelling, and it keeps
    // its reasons.
    const candidate = offered.get(found.symbol);
    if (candidate) {
      chosen.set(candidate.symbol, fromResolver(candidate));
    } else if (!chosen.has(found.symbol)) {
      additions.set(found.symbol, {
        symbol: found.symbol,
        name: found.name ?? null,
        assetClass: found.asset_class,
        exchange: found.exchange ?? null,
        currency: found.currency,
      });
    }
  }
  return { ok: true, offered: [...chosen.values()], additions: [...additions.values()] };
}

/**
 * Create or re-confirm a topic with exactly `symbols` as its instruments.
 *
 * All the calls to the AI service happen before the transaction opens, so no
 * database lock is held across a network round trip. The cap, the duplicate
 * check and the writes then happen under one lock on the user's row.
 */
export async function confirmTopic(
  ai: AiClient,
  input: ConfirmInput,
  requestId?: string,
  onResolution?: OnResolution,
): Promise<ConfirmOutcome> {
  const planned = await plan(ai, input.label, input.symbols, requestId, onResolution);
  if (!planned.ok) return { ok: false, reason: 'unresolved_symbols', symbols: planned.unresolved };

  type Written = Exclude<ConfirmOutcome, { ok: true }> | { ok: true; id: string };
  const outcome = await transaction(async (client): Promise<Written> => {
    const active = await lockTopicsForWrite(client, input.userId);
    let wasActive = false;
    if (input.topicId !== null) {
      const status = await lockTopic(client, input.userId, input.topicId);
      if (status === null) return { ok: false, reason: 'not_found' };
      wasActive = status === 'active';
    }
    // Re-confirming an active topic does not add one; confirming a new topic
    // or a proposal does.
    if (!wasActive && active >= MAX_ACTIVE_TOPICS) {
      return { ok: false, reason: 'limit_reached', limit: MAX_ACTIVE_TOPICS };
    }

    const written = await writeConfirmedTopic(client, {
      userId: input.userId,
      topicId: input.topicId,
      label: input.label,
    });
    if ('duplicate' in written) return { ok: false, reason: 'duplicate_label', label: input.label };

    const added: TopicInstrumentInput[] = [];
    for (const addition of planned.additions) {
      const row = await upsertInstrument(addition, client);
      added.push({ instrumentId: row.id, source: 'user', confidence: null, rationale: null, heldBy: [] });
    }
    const resolverIds = new Set(planned.offered.map((i) => i.instrumentId));
    await replaceTopicInstruments(client, input.userId, written.id, [
      ...planned.offered,
      ...added.filter((i) => !resolverIds.has(i.instrumentId)),
    ]);
    return { ok: true, id: written.id };
  });

  if (!outcome.ok) return outcome;
  const [topic, instruments] = await Promise.all([
    getTopic(input.userId, outcome.id),
    listTopicInstruments(input.userId, outcome.id),
  ]);
  return { ok: true, topic: topic!, instruments };
}
