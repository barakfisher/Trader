/**
 * Internal routes: the entrypoint scheduled work calls into.
 *
 * There is exactly one trigger path for scheduled work (DESIGN.md section 2):
 * locally a timer in this process calls it, in Kubernetes a CronJob does. Both
 * carry a run key, and the `runs` table decides who gets to do the work.
 *
 * The claim lives in Postgres rather than in this process because a restart
 * used to wipe it: the timer fires ten seconds after boot, so three restarts
 * meant three extra runs. That was survivable only because the snapshot table
 * has a unique constraint. It stops being survivable in Milestone 4, where the
 * same mechanism gates Telegram alerts - and a sent message cannot be
 * deduplicated after the fact.
 */

import type { Hono } from 'hono';
import { z } from 'zod';

import { claimRun, finishRun, getUser, listRuns } from '../../db/queries.js';
import { runPortfolioScan } from '../../services/portfolioScan.js';
import { logger } from '../../logger.js';
import { localDate, takeSnapshot } from '../../services/snapshot.js';
import { currentUserId, type AppEnv } from '../app.js';
import { ApiProblem, badRequest, notFound } from '../errors.js';

const runSchema = z.object({
  kind: z.enum(['snapshot', 'portfolio_scan']),
  userId: z.string().uuid().optional(),
  runKey: z.string().max(200).optional(),
  trigger: z.string().max(40).optional(),
});

export function registerInternalRoutes(app: Hono<AppEnv>): void {
  app.post('/internal/runs', async (context) => {
    const config = context.get('config');
    if (context.req.header('x-internal-key') !== config.INTERNAL_API_KEY) {
      throw new ApiProblem(401, 'unauthorized', 'invalid internal API key');
    }

    const parsed = runSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      throw badRequest('invalid_body', 'expected { kind, userId?, runKey?, trigger? }', parsed.error.issues);
    }

    const userId = parsed.data.userId ?? config.SINGLE_USER_ID;
    const user = await getUser(userId);
    if (!user) throw notFound('user not found');

    const runKey = parsed.data.runKey ?? `${parsed.data.kind}:${userId}:${localDate(user.timezone)}`;
    const claim = await claimRun({
      userId,
      kind: parsed.data.kind,
      runKey,
      trigger: parsed.data.trigger ?? 'unknown',
    });

    if (!claim.claimed) {
      logger().info({ runKey, existingStatus: claim.existingStatus }, 'run skipped: already claimed');
      return context.json({
        kind: parsed.data.kind,
        runKey,
        status: 'skipped',
        reason: `this run key was already claimed (${claim.existingStatus ?? 'unknown'})`,
      });
    }

    const runId = claim.runId as string;
    try {
      if (parsed.data.kind === 'portfolio_scan') {
        const scan = await runPortfolioScan(
          user,
          context.get('ai'),
          runId,
          context.get('requestId'),
        );
        // A scan that found nothing is a legitimate outcome, but one that could
        // not look properly is not the same thing - hence 'degraded' rather than
        // 'ok' whenever a rule declined to run or a holding could not be priced.
        await finishRun(runId, scan.degraded ? 'degraded' : 'ok', scan);
        return context.json({
          kind: parsed.data.kind,
          runKey,
          runId,
          status: scan.degraded ? 'degraded' : 'ok',
          result: scan,
        });
      }

      const result = await takeSnapshot(user, context.get('ai'), context.get('requestId'));
      const status = result.skipped ? 'skipped' : result.degraded ? 'degraded' : 'ok';
      await finishRun(runId, status, result);
      return context.json({ kind: parsed.data.kind, runKey, runId, status, result });
    } catch (error) {
      // A failed run must be recorded as failed, not left claimed: otherwise the
      // key blocks every later attempt until the stale-claim window elapses.
      await finishRun(runId, 'failed', { error: (error as Error).message });
      throw error;
    }
  });

  /**
   * Run history. The useful question it answers is not "is the process alive?"
   * but "did the work actually happen?" - the failure a liveness probe cannot
   * see, because a scheduler that is silently rejected looks exactly like a
   * quiet market.
   */
  app.get('/runs', async (context) => {
    const userId = currentUserId(context);
    const kind = context.req.query('kind');
    const rows = await listRuns(userId, kind, 50);
    return context.json({
      runs: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        runKey: row.run_key,
        status: row.status,
        startedAt: new Date(row.started_at).toISOString(),
        finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
      })),
    });
  });
}
