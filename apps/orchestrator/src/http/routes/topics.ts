/**
 * `POST /topics/resolve` (FR-10, M5): a theme in the user's words, candidate
 * instruments out.
 *
 * A proxy, like `/concepts/:slug`. The universe, the embeddings and the resolver
 * all live in the AI service, which owns the schema they are stored in; a second
 * reader of `instrument_profiles` here would be a second place that has to agree
 * about which model's vectors count.
 *
 * **`verdict: 'unavailable'` is passed through as a 200.** It means this
 * installation has no searchable universe - the descriptions are not committed,
 * so a fresh clone has none - and `universe.state` names the missing step. That
 * is a state of the deployment rather than a fault, and it is not the same
 * statement as `verdict: 'none'` (the universe was searched and nothing in it is
 * about the topic). Rewriting either into an error status would erase exactly
 * the distinction the AI service went out of its way to draw.
 *
 * Resolving stores nothing. Resolution proposes, and the user's confirmation is
 * a separate write:
 *
 *   GET    /topics        the user's topics and the limits they are held to
 *   POST   /topics        confirm a new topic: { label, symbols }
 *   GET    /topics/:id    one topic, each instrument with the reason it is there
 *   PUT    /topics/:id    re-confirm: the whole set again, and optionally a new label
 *   DELETE /topics/:id
 *
 * There is no unconfirmed topic. A user's topic comes into existence when they
 * confirm its instruments, because a draft saved before that would be a row
 * nobody chose, counted against the cap and left behind whenever someone stops
 * halfway. `services/topics.ts` explains why the server re-resolves on confirm
 * instead of trusting the reasons the browser was shown.
 */

import type { Context, Hono } from 'hono';
import { z } from 'zod';

import type { TopicDetail, TopicSummary, TopicsResponse } from '@traders/shared';
import { AiServiceError } from '@traders/shared/ai';

import {
  deleteTopic,
  getTopic,
  listTopicInstruments,
  listTopics,
  type TopicInstrumentRow,
  type TopicRow,
} from '../../db/queries.js';
import {
  MAX_ACTIVE_TOPICS,
  MAX_INSTRUMENTS_PER_TOPIC,
  MAX_TOPIC_LABEL_LENGTH,
  confirmTopic,
  normaliseSymbols,
  type ConfirmOutcome,
} from '../../services/topics.js';
import { backfillConfirmedInstruments } from '../../services/topicScan.js';
import { currentUserId, type AppEnv } from '../app.js';
import { badRequest, conflict, notFound, unprocessable, upstreamFailure } from '../errors.js';

const confirmSchema = z.object({
  label: z.string(),
  // Bounded before normalising, so an enormous array is refused rather than
  // de-duplicated; the post-normalisation bound is checked below.
  symbols: z.array(z.string().max(32)).max(MAX_INSTRUMENTS_PER_TOPIC * 2),
});

const topicId = z.string().uuid();

function summary(row: TopicRow): TopicSummary {
  return {
    id: row.id,
    label: row.label,
    // Rejected rows never leave queries.ts; they are auto-discovery's memory.
    status: row.status as TopicSummary['status'],
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    instrumentCount: row.instrument_count,
  };
}

function detail(row: TopicRow, instruments: TopicInstrumentRow[]): TopicDetail {
  return {
    ...summary(row),
    instruments: instruments.map((i) => ({
      instrumentId: i.instrument_id,
      symbol: i.symbol,
      name: i.name,
      assetClass: i.asset_class,
      source: i.source,
      confidence: i.confidence,
      rationale: i.rationale,
      heldBy: i.held_by,
      addedAt: i.added_at.toISOString(),
    })),
  };
}

/** A path id that is not a uuid names no topic; Postgres would call it a 500. */
function parseTopicId(raw: string): string {
  const parsed = topicId.safeParse(raw);
  if (!parsed.success) throw notFound('no such topic');
  return parsed.data;
}

/** The label and symbol set of a confirm, validated and normalised. */
async function readConfirm(body: unknown): Promise<{ label: string; symbols: string[] }> {
  const parsed = confirmSchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest('invalid_body', 'send { label: string, symbols: string[] }', parsed.error.issues);
  }
  const label = parsed.data.label.trim();
  if (!label) throw badRequest('missing_topic', 'a topic needs a label');
  if (label.length > MAX_TOPIC_LABEL_LENGTH) {
    throw badRequest('topic_too_long', `a topic may be at most ${MAX_TOPIC_LABEL_LENGTH} characters`);
  }
  const symbols = normaliseSymbols(parsed.data.symbols);
  if (symbols.length === 0) {
    // The M5 exit criterion is a confirmed instrument set; an empty one would
    // be a topic that can never produce an observation.
    throw unprocessable('no_instruments', 'confirm at least one instrument for the topic');
  }
  if (symbols.length > MAX_INSTRUMENTS_PER_TOPIC) {
    throw unprocessable(
      'too_many_instruments',
      `a topic may hold at most ${MAX_INSTRUMENTS_PER_TOPIC} instruments`,
    );
  }
  return { label, symbols };
}

/** A failed confirm, as the one error the browser can act on. */
function confirmFailure(outcome: Exclude<ConfirmOutcome, { ok: true }>): never {
  switch (outcome.reason) {
    case 'not_found':
      throw notFound('no such topic');
    case 'limit_reached':
      throw unprocessable(
        'topic_limit_reached',
        `you can follow at most ${outcome.limit} topics; remove one to add another`,
        { limit: outcome.limit },
      );
    case 'duplicate_label':
      throw conflict(
        'duplicate_topic',
        `you already follow a topic called "${outcome.label}" (names are compared ignoring case)`,
      );
    case 'unresolved_symbols':
      throw unprocessable(
        'unresolved_symbols',
        `no market data provider recognises ${outcome.symbols.join(', ')}`,
        { symbols: outcome.symbols },
      );
  }
}

async function confirmed(context: Context<AppEnv>, topicIdOrNull: string | null): Promise<TopicDetail> {
  const userId = currentUserId(context);
  const { label, symbols } = await readConfirm(await context.req.json().catch(() => null));
  let outcome: ConfirmOutcome;
  try {
    outcome = await confirmTopic(
      context.get('ai'),
      { userId, topicId: topicIdOrNull, label, symbols },
      context.get('requestId'),
    );
  } catch (error) {
    if (error instanceof AiServiceError) {
      // Confirming needs the resolver's answer to know which instruments carry
      // reasons. Without it, every ticked suggestion would be stored as a
      // bare user addition, so the write is refused rather than degraded.
      throw upstreamFailure(error.status, 'The topic could not be confirmed.');
    }
    throw error;
  }
  if (!outcome.ok) confirmFailure(outcome);
  // Without history the topic scan skips the topic until tomorrow's backfill.
  backfillConfirmedInstruments(
    context.get('ai'),
    outcome.instruments.map((row) => ({ instrument_id: row.instrument_id, symbol: row.symbol })),
    context.get('requestId'),
  );
  return detail(outcome.topic, outcome.instruments);
}

export function registerTopicsRoutes(app: Hono<AppEnv>): void {
  app.post('/topics/resolve', async (context) => {
    // The universe is shared reference data with no `user_id` (migration 0015),
    // but resolving against it is part of the product and sits behind the gate.
    currentUserId(context);

    const body = (await context.req.json().catch(() => null)) as { topic?: unknown } | null;
    const topic = typeof body?.topic === 'string' ? body.topic.trim() : '';

    if (!topic) {
      throw badRequest('missing_topic', 'a topic is required: send { topic: string }');
    }
    if (topic.length > MAX_TOPIC_LABEL_LENGTH) {
      throw badRequest('topic_too_long', `a topic may be at most ${MAX_TOPIC_LABEL_LENGTH} characters`);
    }

    try {
      return context.json(await context.get('ai').resolveTopic(topic, context.get('requestId')));
    } catch (error) {
      if (error instanceof AiServiceError) {
        throw upstreamFailure(error.status, 'The topic could not be resolved.');
      }
      throw error;
    }
  });

  app.get('/topics', async (context) => {
    const userId = currentUserId(context);
    const body: TopicsResponse = {
      topics: (await listTopics(userId)).map(summary),
      limits: {
        maxActiveTopics: MAX_ACTIVE_TOPICS,
        maxInstrumentsPerTopic: MAX_INSTRUMENTS_PER_TOPIC,
        maxLabelLength: MAX_TOPIC_LABEL_LENGTH,
      },
    };
    return context.json(body);
  });

  app.post('/topics', async (context) => context.json(await confirmed(context, null), 201));

  app.get('/topics/:id', async (context) => {
    const userId = currentUserId(context);
    const id = parseTopicId(context.req.param('id'));
    const topic = await getTopic(userId, id);
    if (!topic) throw notFound('no such topic');
    return context.json(detail(topic, await listTopicInstruments(userId, id)));
  });

  app.put('/topics/:id', async (context) =>
    context.json(await confirmed(context, parseTopicId(context.req.param('id')))),
  );

  app.delete('/topics/:id', async (context) => {
    const userId = currentUserId(context);
    if (!(await deleteTopic(userId, parseTopicId(context.req.param('id'))))) {
      throw notFound('no such topic');
    }
    return context.body(null, 204);
  });
}
