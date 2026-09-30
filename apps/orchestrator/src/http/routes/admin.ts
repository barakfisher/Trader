/**
 * The admin surface (M8). Operations views of the installation as a whole, as
 * opposed to one account's portfolio.
 *
 * No route here checks the role: `app.ts` gates every path under `/admin`
 * before any of these handlers run, and `adminGuard.test.ts` enumerates the
 * registered routes to prove it. A route added here is guarded by being here.
 */

import type { Hono } from 'hono';

import type { AdminAuditResponse, AdminRunsResponse } from '@traders/shared';

import { listAdminAudit, listAllRuns } from '../../db/queries.js';
import type { AppEnv } from '../app.js';
import { badRequest } from '../errors.js';

/** Enough to see a day of the half-hourly scans next to everything else. */
const ADMIN_RUNS_LIMIT = 100;
const ADMIN_AUDIT_LIMIT = 100;

export function registerAdminRoutes(app: Hono<AppEnv>): void {
  /**
   * Every run of every account and of none, newest first. `GET /runs` is one
   * account's history; this is the installation's, including the runs a
   * CronJob started for no user in particular.
   */
  app.get('/admin/runs', async (context) => {
    const kind = context.req.query('kind');
    if (kind !== undefined && !/^[a-z_]{1,64}$/.test(kind)) {
      throw badRequest('invalid_kind', 'kind is a run kind such as portfolio_scan');
    }
    const rows = await listAllRuns(kind, ADMIN_RUNS_LIMIT);
    const body: AdminRunsResponse = {
      runs: rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        kind: row.kind,
        runKey: row.run_key,
        trigger: row.trigger,
        status: row.status,
        startedAt: new Date(row.started_at).toISOString(),
        finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
      })),
    };
    return context.json(body);
  });

  /** The admin actions taken, newest first, as recorded before each one ran. */
  app.get('/admin/audit', async (context) => {
    const rows = await listAdminAudit(ADMIN_AUDIT_LIMIT);
    const body: AdminAuditResponse = {
      entries: rows.map((row) => ({
        id: row.id,
        adminUserId: row.admin_user_id,
        action: row.action,
        detail: row.detail,
        ipAddress: row.ip_address,
        requestId: row.request_id,
        occurredAt: new Date(row.occurred_at).toISOString(),
      })),
    };
    return context.json(body);
  });
}
