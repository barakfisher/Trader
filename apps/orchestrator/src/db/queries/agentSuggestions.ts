import type { SuggestionChange, SuggestionSetting } from '@traders/shared';

import { query, queryOne, transaction } from '../pool.js';

/**
 * The agent review's reads and writes (D335-D338): the window of scans a
 * review looks at, with the ledger figures beside it, and the suggestions it
 * stores (migration 0079). Apply changes one `agents` column and closes the
 * suggestion in one transaction.
 */

/** A window of counted scans and the ledger as the review reads it. Money and counts as text. */
export interface ReviewWindowRow {
  /** Every counted scan the agent has run. */
  counted: string;
  /** The window: the newest `size` counted scans. */
  scans: string;
  trade_scans: string;
  since: Date | null;
  last_scan_id: string | null;
  /** The agent's own fills since the window's first scan. */
  fills: string;
  fees_minor: string;
  deposits_minor: string;
  cash_minor: string | null;
}

export function readReviewWindow(
  userId: string,
  agentId: string,
  outcomes: readonly string[],
  size: number,
): Promise<ReviewWindowRow | null> {
  return queryOne<ReviewWindowRow>(
    `WITH counted AS (
       SELECT id, started_at, outcome FROM agent_scans
        WHERE user_id = $1 AND agent_id = $2
          AND trigger IN ('manual', 'schedule') AND outcome = ANY($3::text[])
     ), win AS (
       SELECT * FROM counted ORDER BY started_at DESC, id DESC LIMIT $4
     ), since AS (SELECT min(started_at) AS at FROM win)
     SELECT (SELECT count(*) FROM counted)::text AS counted,
            (SELECT count(*) FROM win)::text AS scans,
            (SELECT count(*) FROM win WHERE outcome = 'trade')::text AS trade_scans,
            (SELECT at FROM since) AS since,
            (SELECT id FROM win ORDER BY started_at DESC, id DESC LIMIT 1) AS last_scan_id,
            (SELECT count(*) FROM fills f
              WHERE f.user_id = $1 AND f.agent_id = $2 AND f.source = 'agent'
                AND f.created_at >= (SELECT at FROM since))::text AS fills,
            (SELECT coalesce(sum(f.fee_minor), 0) FROM fills f
              WHERE f.user_id = $1 AND f.agent_id = $2 AND f.source = 'agent'
                AND f.created_at >= (SELECT at FROM since))::text AS fees_minor,
            (SELECT coalesce(sum(m.amount_minor), 0) FROM cash_movements m
              WHERE m.user_id = $1 AND m.agent_id = $2
                AND m.kind IN ('opening_deposit', 'top_up'))::text AS deposits_minor,
            (SELECT c.balance_minor::text FROM agent_cash c
              WHERE c.user_id = $1 AND c.agent_id = $2) AS cash_minor`,
    [userId, agentId, outcomes, size],
  );
}

export interface AgentSuggestionRow {
  id: string;
  agent_id: string;
  rule: string;
  status: string;
  evidence: Record<string, unknown>;
  change: SuggestionChange | null;
  created_at: Date;
  decided_at: Date | null;
}

const COLUMNS = 'id, agent_id, rule, status, evidence, change, created_at, decided_at';

export interface NewSuggestion {
  rule: string;
  dedupeKey: string;
  evidence: object;
  change: SuggestionChange | null;
}

/**
 * Store a review's suggestions, once per window (`dedupe_key`). A suggestion
 * that is new replaces the agent's open one of the same rule, which becomes
 * `superseded`: the later window's figures are the ones to act on. Returns the
 * ids written; a repeat of the same window writes nothing.
 */
export function insertSuggestions(userId: string, agentId: string, suggestions: NewSuggestion[]): Promise<string[]> {
  if (suggestions.length === 0) return Promise.resolve([]);
  return transaction(async (client) => {
    const written: string[] = [];
    for (const suggestion of suggestions) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO agent_suggestions (user_id, agent_id, rule, dedupe_key, evidence, change)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
         ON CONFLICT (agent_id, dedupe_key) DO NOTHING
         RETURNING id`,
        [
          userId,
          agentId,
          suggestion.rule,
          suggestion.dedupeKey,
          JSON.stringify(suggestion.evidence),
          suggestion.change === null ? null : JSON.stringify(suggestion.change),
        ],
      );
      const id = inserted.rows[0]?.id;
      if (id === undefined) continue;
      await client.query(
        `UPDATE agent_suggestions SET status = 'superseded', decided_at = now()
          WHERE user_id = $1 AND agent_id = $2 AND rule = $3 AND status = 'open' AND id <> $4`,
        [userId, agentId, suggestion.rule, id],
      );
      written.push(id);
    }
    return written;
  });
}

/** The agent's open suggestions, newest first. */
export function listOpenSuggestions(userId: string, agentId: string): Promise<AgentSuggestionRow[]> {
  return query<AgentSuggestionRow>(
    `SELECT ${COLUMNS} FROM agent_suggestions
      WHERE user_id = $1 AND agent_id = $2 AND status = 'open'
      ORDER BY created_at DESC, id`,
    [userId, agentId],
  );
}

/** Dismiss an open suggestion; false when there is none open by that id. */
export async function dismissSuggestion(userId: string, agentId: string, suggestionId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE agent_suggestions SET status = 'dismissed', decided_at = now()
      WHERE user_id = $1 AND agent_id = $2 AND id = $3 AND status = 'open'
      RETURNING id`,
    [userId, agentId, suggestionId],
  );
  return row !== null;
}

/**
 * Each setting a suggestion may write, with its column's type. The column name
 * is spliced into SQL, so only these names ever are.
 */
const SETTING_TYPES: Record<SuggestionSetting, string> = {
  cash_buffer_bps: 'integer',
  market_caps: 'text[]',
  risk_level: 'smallint',
  max_decisions: 'smallint',
  scan_every_hours: 'smallint',
  max_position_bps: 'integer',
  allow_etfs: 'boolean',
};

export type ApplyResult =
  | { status: 'applied' }
  | { status: 'not_found' }
  | { status: 'closed' }
  | { status: 'nothing_to_apply' }
  | { status: 'agent_archived' }
  | { status: 'stale' };

/**
 * Apply an open suggestion: its setting is written only while the agent still
 * holds the value the review read (`from`), and the suggestion is marked
 * applied in the same transaction. A setting changed since makes it `stale` -
 * written, so the card leaves - and nothing else changes. An archived agent is
 * read-only history: refused, and the suggestion stays open.
 */
export function applySuggestion(userId: string, agentId: string, suggestionId: string): Promise<ApplyResult> {
  return transaction(async (client) => {
    const found = await client.query<{ status: string; change: SuggestionChange | null }>(
      `SELECT status, change FROM agent_suggestions
        WHERE user_id = $1 AND agent_id = $2 AND id = $3
        FOR UPDATE`,
      [userId, agentId, suggestionId],
    );
    const suggestion = found.rows[0];
    if (!suggestion) return { status: 'not_found' };
    if (suggestion.status !== 'open') return { status: 'closed' };
    const change = suggestion.change;
    if (change === null) return { status: 'nothing_to_apply' };
    // Own keys only: the name is spliced into SQL, and `constructor` is on every object.
    if (!Object.hasOwn(SETTING_TYPES, change.setting)) return { status: 'nothing_to_apply' };
    const type = SETTING_TYPES[change.setting];

    // NO KEY: a review inserting a suggestion holds the agent's key-share lock (its foreign
    // key) and then supersedes this row; FOR UPDATE would deadlock against it.
    const agent = await client.query<{ state: string }>(
      `SELECT state FROM agents WHERE user_id = $1 AND id = $2 AND NOT is_primary FOR NO KEY UPDATE`,
      [userId, agentId],
    );
    if (!agent.rows[0]) return { status: 'not_found' };
    if (agent.rows[0].state === 'archived') return { status: 'agent_archived' };

    const updated = await client.query(
      `UPDATE agents SET ${change.setting} = $3::${type}
        WHERE user_id = $1 AND id = $2 AND ${change.setting} IS NOT DISTINCT FROM $4::${type}
        RETURNING id`,
      [userId, agentId, change.to, change.from],
    );
    const status = updated.rowCount === 1 ? 'applied' : 'stale';
    await client.query(
      `UPDATE agent_suggestions SET status = $4, decided_at = now()
        WHERE user_id = $1 AND agent_id = $2 AND id = $3`,
      [userId, agentId, suggestionId, status],
    );
    return { status };
  });
}
