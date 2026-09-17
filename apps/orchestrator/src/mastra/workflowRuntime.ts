/**
 * The Mastra runtime: one instance, one storage adapter, one registered
 * workflow.
 *
 * This module exists so that exactly one place in the codebase knows how the
 * workflow engine is wired, and so that every other place can ask for it and be
 * told `null`. That second part is the important one. Mastra is a coordinator
 * here, not a system of record: the proposal state machine is correct with or
 * without it, and a durable-workflow layer that can refuse a user's decision
 * because its storage is unreachable would be a downgrade from what exists
 * today. So `getWorkflowRuntime()` returns `null` when the runtime was never
 * initialised - in tests, in a process that boots before migration 0007 has
 * run - and every caller has a path that works anyway.
 *
 * **Storage is scoped to one domain and one schema.** `PostgresStore` speaks
 * for twenty-four storage domains and creates forty-three tables when it
 * initialises; this product uses `workflows` and nothing else. `disableInit`
 * stops the library issuing DDL at all - migration 0007 owns that - and the
 * composite store routes only the `workflows` domain at it, so a future import
 * that quietly starts using Mastra memory or observability fails loudly instead
 * of silently writing to a table nobody migrated.
 */

import { Mastra } from '@mastra/core';
import { MastraCompositeStore } from '@mastra/core/storage';
import type { Workflow } from '@mastra/core/workflows';
import { PostgresStore } from '@mastra/pg';

import { getPool } from '../db/pool.js';
import { logger } from '../logger.js';

/**
 * The Postgres schema migration 0007 creates for Mastra's own tables. A
 * constant rather than configuration: the migration hard-codes it too, and a
 * schema name that could differ between the two would be a way for the store to
 * silently find nothing.
 */
export const MASTRA_SCHEMA = 'mastra';

/**
 * Mastra reports feature usage to a third-party analytics endpoint unless this
 * is set. A portfolio copilot does not send anything about itself to a vendor
 * the user never agreed to, and this is set in code rather than in `.env`
 * because a beacon that depends on an environment variable being remembered is
 * a beacon that eventually fires. Read per call inside the library, so setting
 * it before the first Mastra construction is enough.
 */
process.env.MASTRA_TELEMETRY_DISABLED ??= '1';

export interface WorkflowRuntime {
  /** Look a workflow up by the key it was registered under. */
  getWorkflow: (id: string) => Workflow;
  /** Release anything the runtime owns. Safe to call twice. */
  close: () => Promise<void>;
}

let runtime: WorkflowRuntime | null = null;

/**
 * Build a runtime backed by the orchestrator's own connection pool.
 *
 * The pool is shared rather than a second one opened: Mastra would default to
 * twenty connections of its own, which against a single-user product is twenty
 * idle connections bought to hold at most a handful of suspended runs. Sharing
 * also means the store is closed exactly when the rest of the process is.
 */
export function initWorkflowRuntime(options: {
  workflows: Record<string, Workflow>;
}): WorkflowRuntime {
  const store = new PostgresStore({
    id: 'traders-workflow-state',
    pool: getPool(),
    schemaName: MASTRA_SCHEMA,
    // Migration 0007 owns the DDL. See the module docstring, and 0007 itself.
    disableInit: true,
  });

  const storage = new MastraCompositeStore({
    id: 'traders-workflow-domains',
    name: 'traders-workflow-domains',
    domains: { workflows: store.stores.workflows },
  });

  return installRuntime(new Mastra({ storage, workflows: options.workflows }), async () => {
    // The pool belongs to `db/pool.ts`, which closes it on shutdown. Closing the
    // store as well would be closing somebody else's pool, and `PostgresStore`
    // documents that a caller-supplied pool is left alone - so this is a no-op
    // that exists to keep the shape of the interface honest.
  });
}

/**
 * Build a runtime with in-memory storage. For tests only, and named so that a
 * production call site reads as obviously wrong.
 */
export function initInMemoryWorkflowRuntimeForTests(options: {
  workflows: Record<string, Workflow>;
}): WorkflowRuntime {
  return installRuntime(new Mastra({ workflows: options.workflows }), async () => {});
}

function installRuntime(mastra: Mastra, close: () => Promise<void>): WorkflowRuntime {
  runtime = {
    getWorkflow: (id: string) => mastra.getWorkflow(id) as unknown as Workflow,
    close: async () => {
      runtime = null;
      await close();
    },
  };
  logger().info('workflow runtime initialised');
  return runtime;
}

/** The runtime, or `null` when there is none. Callers must handle `null`. */
export function getWorkflowRuntime(): WorkflowRuntime | null {
  return runtime;
}

export async function closeWorkflowRuntime(): Promise<void> {
  await runtime?.close();
  runtime = null;
}
