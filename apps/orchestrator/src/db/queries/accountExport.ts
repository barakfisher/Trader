/**
 * A user's own rows, as one JSON document (D264's export).
 *
 * What is in it is listed here, table by table, and nothing is added by
 * walking the schema: a new table holding a secret must never reach a file a
 * user downloads because it has a `user_id`. Never the model key, sessions,
 * links, Telegram binding codes or the password hash.
 *
 * Built by Postgres and returned as text, never parsed here: quantities and
 * weights are `numeric` and leave as decimal strings (guideline 4), and money
 * stays the integers it is stored as - a JSON number in text, which this
 * process never turns into a float.
 */

import { queryOne } from '../pool.js';

/** One table's rows of the user, as a JSON array; `t` is the row, `$1` the user. */
function rows(table: string, order: string, extra = ''): string {
  return `coalesce((SELECT jsonb_agg((to_jsonb(t) - 'user_id')${extra} ORDER BY ${order})
                      FROM ${table} t WHERE t.user_id = $1), '[]'::jsonb)`;
}

/** The instrument's symbol beside its id, so a reader can tell what was held. */
const SYMBOL = `|| jsonb_build_object('symbol', (SELECT i.symbol FROM instruments i WHERE i.id = t.instrument_id))`;

const EXPORT_SQL = `
SELECT jsonb_build_object(
  'format', 'traders-export-1',
  'exportedAt', now(),
  'account', (SELECT jsonb_build_object(
                'email', u.email,
                'baseCurrency', u.base_currency,
                'timezone', u.timezone,
                'createdAt', u.created_at,
                'emailVerifiedAt', u.email_verified_at,
                'lastSignInAt', u.last_sign_in_at,
                'monthlyCapMicroUsd', u.llm_cap_micro_usd)
                FROM users u WHERE u.id = $1),
  'settings', (SELECT to_jsonb(t) - 'user_id' FROM user_settings t WHERE t.user_id = $1),
  'legalAcceptances', ${rows('legal_acceptances', 't.accepted_at, t.version')},
  'agents', ${rows('agents', 't.created_at, t.id')},
  'agentScans', ${rows('agent_scans', 't.started_at, t.id')},
  'holdings', ${rows('holdings', 't.created_at, t.id', ` || jsonb_build_object('quantity', t.quantity::text) ${SYMBOL}`)},
  'targetWeights', ${rows('target_weights', 't.agent_id, t.instrument_id', ` || jsonb_build_object('weight', t.weight::text) ${SYMBOL}`)},
  'ledgers', jsonb_build_object(
    'cash', ${rows('agent_cash', 't.agent_id')},
    'cashMovements', ${rows('cash_movements', 't.created_at, t.id')},
    'fills', ${rows('fills', 't.created_at, t.id', ` || jsonb_build_object('quantity', t.quantity::text) ${SYMBOL}`)}),
  'proposals', ${rows('proposals', 't.created_at, t.id')},
  'proposalTransitions', ${rows('proposal_transitions', 't.created_at, t.id')},
  'observations', ${rows('observations', 't.created_at, t.id')},
  'topics', ${rows('topics', 't.created_at, t.id')},
  'topicInstruments', ${rows('topic_instruments', 't.topic_id, t.instrument_id', SYMBOL)},
  'conversations', ${rows(
    'assistant_conversations',
    't.created_at, t.id',
    ` || jsonb_build_object('messages', coalesce(
           (SELECT jsonb_agg(to_jsonb(m) - 'user_id' - 'conversation_id' ORDER BY m.created_at, m.id)
              FROM assistant_messages m WHERE m.conversation_id = t.id AND m.user_id = $1), '[]'::jsonb))`,
  )}
)::text AS document`;

/** The signed-in user's export, as JSON text. */
export async function exportAccount(userId: string): Promise<string> {
  const row = await queryOne<{ document: string }>(EXPORT_SQL, [userId]);
  if (!row) throw new Error('the export query returned no row');
  return row.document;
}
