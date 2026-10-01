import type { PoolClient } from 'pg';
import type { AssetClass, ProposalBand, TopicEvidence } from '@traders/shared';
import { query, queryOne } from '../pool.js';

export type TopicStatus = 'active' | 'proposed' | 'rejected' | 'expired';

/**
 * The statuses a user sees and can act on. `rejected` and `expired` rows are
 * auto-discovery's memory and leave every list; each reader filters by this
 * rather than by excluding one dead status, so a third cannot slip through.
 */
export const LIVE_TOPIC = `status IN ('active', 'proposed')`;

export interface TopicRow {
  id: string;
  label: string;
  status: TopicStatus;
  created_by: 'user' | 'auto';
  proposal_band: ProposalBand | null;
  created_at: Date;
  updated_at: Date;
  confirmed_at: Date | null;
  instrument_count: number;
  /** Why an auto-discovered topic was proposed; null for a topic the user created. */
  evidence: TopicEvidence | null;
}

export interface TopicInstrumentRow {
  instrument_id: string;
  symbol: string;
  name: string | null;
  asset_class: AssetClass;
  source: 'resolver' | 'user';
  confidence: 'confident' | 'weak' | null;
  rationale: string | null;
  /** `[{ etf, weight }]`, weights as decimal strings, exactly as offered. */
  held_by: { etf: string; weight: string }[];
  added_at: Date;
}

/** One confirmed instrument, with the reasons it was offered (none for `user`). */
export interface TopicInstrumentInput {
  instrumentId: string;
  source: 'resolver' | 'user';
  confidence: 'confident' | 'weak' | null;
  rationale: string | null;
  heldBy: { etf: string; weight: string }[];
}

const TOPIC_COLUMNS = `
  t.id, t.label, t.status, t.created_by, t.proposal_band, t.created_at, t.updated_at,
  t.confirmed_at, t.evidence,
  (SELECT count(*)::int FROM topic_instruments ti WHERE ti.topic_id = t.id) AS instrument_count`;

/**
 * The user's topics, newest first. Rejected and expired proposals are excluded:
 * they exist only as auto-discovery's memory of what not to propose again.
 */
export function listTopics(userId: string): Promise<TopicRow[]> {
  return query<TopicRow>(
    `SELECT ${TOPIC_COLUMNS}
       FROM topics t
      WHERE t.user_id = $1 AND t.${LIVE_TOPIC}
      ORDER BY t.created_at DESC, t.id`,
    [userId],
  );
}

export function getTopic(userId: string, topicId: string): Promise<TopicRow | null> {
  return queryOne<TopicRow>(
    `SELECT ${TOPIC_COLUMNS}
       FROM topics t
      WHERE t.user_id = $1 AND t.id = $2 AND t.${LIVE_TOPIC}`,
    [userId, topicId],
  );
}

/** A topic's confirmed instruments: resolver picks first, then additions, by symbol. */
export function listTopicInstruments(
  userId: string,
  topicId: string,
): Promise<TopicInstrumentRow[]> {
  return query<TopicInstrumentRow>(
    `SELECT ti.instrument_id, i.symbol, i.name, i.asset_class, ti.source, ti.confidence,
            ti.rationale, ti.held_by, ti.added_at
       FROM topic_instruments ti
       JOIN instruments i ON i.id = ti.instrument_id
      WHERE ti.user_id = $1 AND ti.topic_id = $2
      ORDER BY ti.source = 'user', i.symbol`,
    [userId, topicId],
  );
}

/**
 * Serialise every topic write for one user, and report how many topics are live.
 *
 * The count-then-insert behind the topic cap is a race without this: two
 * simultaneous confirms both read nine and both write a tenth. Locking the
 * user's row makes the second wait for the first, then count again. `proposed`
 * topics do not count - auto-discovery's own bound is its business, and a
 * proposal must not be able to use up the user's room for topics they chose.
 */
export async function lockTopicsForWrite(client: PoolClient, userId: string): Promise<number> {
  await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
  const { rows } = await client.query<{ active: number }>(
    `SELECT count(*)::int AS active FROM topics WHERE user_id = $1 AND status = 'active'`,
    [userId],
  );
  return rows[0]?.active ?? 0;
}

/**
 * The status of `topicId` if it is a live topic of this user, else null. Locks
 * the row for the rest of the transaction.
 */
export async function lockTopic(
  client: PoolClient,
  userId: string,
  topicId: string,
): Promise<TopicStatus | null> {
  const { rows } = await client.query<{ status: TopicStatus }>(
    `SELECT status FROM topics
      WHERE user_id = $1 AND id = $2 AND ${LIVE_TOPIC}
      FOR UPDATE`,
    [userId, topicId],
  );
  return rows[0]?.status ?? null;
}

/**
 * Write a confirmed topic's label: a new active topic when `topicId` is null,
 * otherwise a relabel of an existing one. Confirming is what makes a topic
 * active, so both stamp `confirmed_at`.
 *
 * Returns `duplicate` instead of throwing when the label is already a live
 * topic of this user (compared case-insensitively by the unique index), so the
 * route can say which topic it collided with rather than surfacing a 500.
 */
export async function writeConfirmedTopic(
  client: PoolClient,
  input: { userId: string; topicId: string | null; label: string },
): Promise<{ id: string } | { duplicate: true }> {
  try {
    const { rows } =
      input.topicId === null
        ? await client.query<{ id: string }>(
            `INSERT INTO topics (user_id, label, status, created_by, confirmed_at)
           VALUES ($1, $2, 'active', 'user', now())
           RETURNING id`,
            [input.userId, input.label],
          )
        : await client.query<{ id: string }>(
            `UPDATE topics
              SET label = $3, status = 'active', confirmed_at = now(), updated_at = now()
            WHERE user_id = $1 AND id = $2
           RETURNING id`,
            [input.userId, input.topicId, input.label],
          );
    return { id: rows[0]!.id };
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return { duplicate: true };
    throw error;
  }
}

/**
 * Make `instruments` exactly the topic's confirmed set.
 *
 * Rows that stay keep their `added_at` - "confirmed since March" should not
 * reset every time the user edits the list - and take the provenance offered
 * this time. Rows not in the set are deleted.
 */
export async function replaceTopicInstruments(
  client: PoolClient,
  userId: string,
  topicId: string,
  instruments: TopicInstrumentInput[],
): Promise<void> {
  await client.query(
    `DELETE FROM topic_instruments
      WHERE user_id = $1 AND topic_id = $2 AND NOT (instrument_id = ANY($3::uuid[]))`,
    [userId, topicId, instruments.map((i) => i.instrumentId)],
  );
  for (const instrument of instruments) {
    await client.query(
      `INSERT INTO topic_instruments
              (topic_id, user_id, instrument_id, source, confidence, rationale, held_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (topic_id, instrument_id) DO UPDATE
          SET source = EXCLUDED.source,
              confidence = EXCLUDED.confidence,
              rationale = EXCLUDED.rationale,
              held_by = EXCLUDED.held_by`,
      [
        topicId,
        userId,
        instrument.instrumentId,
        instrument.source,
        instrument.confidence,
        instrument.rationale,
        JSON.stringify(instrument.heldBy),
      ],
    );
  }
}

export interface ActiveTopicInstrumentRow {
  topic_id: string;
  label: string;
  instrument_id: string;
  symbol: string;
}

/**
 * Every active topic's confirmed instruments, one row per pair, for the topic
 * scan. Ordered so rows of one topic are adjacent and the scan can group them
 * without sorting.
 */
export function listActiveTopicInstruments(userId: string): Promise<ActiveTopicInstrumentRow[]> {
  return query<ActiveTopicInstrumentRow>(
    `SELECT t.id AS topic_id, t.label, i.id AS instrument_id, i.symbol
       FROM topics t
       JOIN topic_instruments ti ON ti.topic_id = t.id AND ti.user_id = t.user_id
       JOIN instruments i ON i.id = ti.instrument_id
      WHERE t.user_id = $1 AND t.status = 'active'
      ORDER BY t.created_at, t.id, i.symbol`,
    [userId],
  );
}

/** Topic observations written in the last `hours`, most severe first, for the digest. */
export function listRecentTopicObservations(
  userId: string,
  hours: number,
): Promise<{ subject_ref: string; severity: string; headline: string; created_at: Date }[]> {
  return query(
    `SELECT subject_ref, severity, headline, created_at
       FROM observations
      WHERE user_id = $1
        AND subject_kind = 'topic'
        AND created_at > now() - ($2 || ' hours')::interval
      ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'notable' THEN 1 ELSE 2 END,
               created_at DESC`,
    [userId, String(hours)],
  );
}

/** Delete one of the user's topics and, by cascade, its instruments. */
/**
 * Delete a topic the user follows. A proposal is not deleted here: forgetting it
 * would erase the memory that stops it being proposed again, so a proposal is
 * declined with `rejectProposal` instead, and the route says so.
 */
export async function deleteTopic(userId: string, topicId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `DELETE FROM topics WHERE user_id = $1 AND id = $2 AND status = 'active' RETURNING id`,
    [userId, topicId],
  );
  return rows.length > 0;
}
