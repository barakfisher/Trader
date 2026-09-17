/**
 * Migration 0007 against the shape Mastra actually expects.
 *
 * The orchestrator runs the workflow store with `disableInit`, so the library
 * never creates its own table and Alembic owns the DDL - which is what CLAUDE.md
 * asks for and what keeps a shared database's schema in one reviewable history.
 * The price of that choice is a copy: `0008_mastra_workflow_state.py` restates
 * what `WorkflowsPG` would have created, and a Mastra upgrade that adds a column
 * would leave the two silently disagreeing.
 *
 * "Silently" is the part this file removes. The failure without it is a
 * suspended run that cannot be written or read - a proposal that stops being
 * answerable, discovered by a user rather than by CI, days after the upgrade.
 * With it, `pnpm add @mastra/pg@latest` fails the build and names the column.
 *
 * It reads the migration as text on purpose. Executing it would need a
 * Postgres, and a test that needs infrastructure is a test that stops being
 * run.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WorkflowsPG } from '@mastra/pg';

import { MASTRA_SCHEMA } from '../src/mastra/workflowRuntime.js';

const MIGRATION = readFileSync(
  new URL('../../../services/ai/alembic/versions/0008_mastra_workflow_state.py', import.meta.url),
  'utf8',
);

/** The library's own DDL for the one storage domain this product uses. */
const LIBRARY_DDL = WorkflowsPG.getExportDDL(MASTRA_SCHEMA).join('\n');

/** `"name" TYPE` pairs, longest type alternative first so TIMESTAMPTZ wins. */
const COLUMN = /"(\w+)"\s+(TIMESTAMPTZ|TIMESTAMP|JSONB|TEXT)\b/g;

function columnsOf(ddl: string): Map<string, string> {
  const createTable = ddl.slice(ddl.indexOf('CREATE TABLE'), ddl.indexOf(');'));
  const columns = new Map<string, string>();
  for (const [, name, type] of createTable.matchAll(COLUMN)) columns.set(name!, type!);
  return columns;
}

describe('migration 0007 against @mastra/pg', () => {
  it('declares the table Mastra expects to find', () => {
    expect(MIGRATION).toContain(`${MASTRA_SCHEMA}.${WorkflowsPG.MANAGED_TABLES[0]}`);
  });

  it('declares every column the library would have created, with its type', () => {
    const expected = columnsOf(LIBRARY_DDL);
    // A guard on the guard: an extraction that quietly matched nothing would
    // make every assertion below vacuously true.
    expect(expected.size).toBeGreaterThan(0);

    const actual = columnsOf(MIGRATION);
    expect(actual).toEqual(expected);
  });

  it('declares the identity the library reads and writes runs by', () => {
    // (workflow_name, run_id) is how a suspended run is found again, and the
    // orchestrator leans on it a second time: the run id is the observation id,
    // so this constraint is also what stops a re-scan opening a second
    // lifecycle for a finding that already has one.
    for (const name of LIBRARY_DDL.matchAll(/mastra_mastra_workflow_snapshot\w*/g)) {
      expect(MIGRATION).toContain(name[0]);
    }
  });
});
