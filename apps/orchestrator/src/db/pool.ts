/**
 * Postgres connection pool.
 *
 * The AI service owns the schema (Alembic); this process reads and writes the
 * same tables through hand-written SQL. Queries live in `src/db/queries.ts` so
 * every statement in the codebase is visible in one place.
 */

import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import { logger } from '../logger.js';

let pool: Pool | null = null;

export function initPool(databaseUrl: string): Pool {
  pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  pool.on('error', (error) => logger().error({ err: error }, 'postgres pool error'));
  return pool;
}

export function getPool(): Pool {
  if (!pool) throw new Error('database pool not initialised; call initPool first');
  return pool;
}

export async function query<T extends QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(sql, params);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/** Run `fn` inside a transaction, rolling back on any thrown error. */
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = null;
}
