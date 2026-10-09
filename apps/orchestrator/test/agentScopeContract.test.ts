/**
 * Every statement on an agent-owned table names its agent, or says why not.
 *
 * Migration 0036 put `agent_id` on nine tables so the real portfolio and the
 * simulated ones can never be mixed. The column only protects anything if the
 * queries use it, and the query that forgets it reads correct in isolation -
 * `WHERE user_id = $1` returns the right rows for as long as a user has one
 * agent, which is exactly as long as nobody is looking. This is that mistake
 * as a failing build instead of a blended figure in front of the user
 * (docs/PROPOSAL-MULTI-AGENT.md §3.2, §12 PR 2).
 *
 * A statement that is legitimately every agent's - a row addressed by its own
 * id, an installation sweep, what is sent to the user - carries a SQL comment
 * `-- agent-blind: <why>` beside the query, so the reason is read where the
 * query is, and a new exception has to be argued in the diff that adds it.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const QUERIES = join(import.meta.dirname, '..', 'src', 'db', 'queries');

/** The tables migration 0036 gave an `agent_id`, and those born with one since. */
const OWNED_TABLES = [
  'holdings',
  'observations',
  'proposals',
  'intents',
  'runs',
  'portfolio_snapshots',
  'target_weights',
  'notifications',
  'proposal_episodes',
  // Decision 132 (migration 0049), agent-owned from its first row.
  'finding_episodes',
  // The ledger (migration 0040), agent-owned from its first row.
  'agent_cash',
  'cash_movements',
  'fills',
];

const TOUCHES_OWNED = new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE)\\s+(?:${OWNED_TABLES.join('|')})\\b`, 'i');
/** The reason must be on the comment's own line: a bare marker followed by the query is not one. */
const BLIND_WITH_REASON = /--[ \t]*agent-blind:[ \t]*\S/;

interface Statement {
  file: string;
  line: number;
  sql: string;
}

/** Every string literal in `source` that reads or writes an owned table. */
function ownedStatements(file: string, source: string): Statement[] {
  const found: Statement[] = [];
  for (const match of source.matchAll(/`([^`]*)`|'([^'\n]*)'/g)) {
    const sql = match[1] ?? match[2] ?? '';
    if (!TOUCHES_OWNED.test(sql)) continue;
    found.push({ file, line: source.slice(0, match.index).split('\n').length, sql });
  }
  return found;
}

function unscoped(statements: Statement[]): string[] {
  return statements
    .filter(({ sql }) => !/\bagent_id\b/.test(sql) && !BLIND_WITH_REASON.test(sql))
    .map(({ file, line }) => `${file}:${line}`);
}

const statements = readdirSync(QUERIES)
  .filter((name) => name.endsWith('.ts'))
  .flatMap((name) => ownedStatements(name, readFileSync(join(QUERIES, name), 'utf8')));

describe('agent scope', () => {
  it('finds the statements it is meant to check', () => {
    // A parser that matched nothing would pass every build having checked nothing.
    expect(statements.length).toBeGreaterThan(40);
  });

  it('every statement on an owned table names agent_id or argues agent-blind', () => {
    expect(unscoped(statements)).toEqual([]);
  });

  it('fails a forgotten filter and accepts an argued one', () => {
    const forgotten = ownedStatements('x.ts', "query('SELECT * FROM holdings WHERE user_id = $1')");
    const scoped = ownedStatements('x.ts', "query('SELECT * FROM holdings WHERE agent_id = $1')");
    const argued = ownedStatements('x.ts', 'query(`-- agent-blind: by id.\n SELECT 1 FROM runs`)');
    const unargued = ownedStatements('x.ts', 'query(`-- agent-blind:\n SELECT 1 FROM runs`)');
    expect(unscoped(forgotten)).toEqual(['x.ts:1']);
    expect(unscoped([...scoped, ...argued])).toEqual([]);
    expect(unscoped(unargued)).toEqual(['x.ts:1']);
  });
});
