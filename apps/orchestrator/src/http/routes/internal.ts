/**
 * Internal routes: the entrypoint scheduled work calls into.
 *
 * There is exactly one trigger path for scheduled work (DESIGN.md section 2):
 * locally a timer in this process calls it, in Kubernetes a CronJob does. Runs
 * carry a `runKey` so a double trigger is a no-op rather than duplicate work -
 * the property the whole M4 notification pipeline depends on.
 */

import type { Hono } from 'hono';
import { z } from 'zod';

import { getUser } from '../../db/queries.js';
import { logger } from '../../logger.js';
import { localDate, takeSnapshot } from '../../services/snapshot.js';
import type { AppEnv } from '../app.js';
import { ApiProblem, badRequest, notFound } from '../errors.js';

const runSchema = z.object({
  kind: z.enum(['snapshot']),
  userId: z.string().uuid().optional(),
  runKey: z.string().max(200).optional(),
});

/** Run keys seen in this process. Moves to the `runs` table in M2. */
const seenRunKeys = new Map<string, number>();
const RUN_KEY_TTL_MS = 6 * 60 * 60 * 1000;

function alreadyRan(runKey: string): boolean {
  const now = Date.now();
  for (const [key, at] of seenRunKeys) {
    if (now - at > RUN_KEY_TTL_MS) seenRunKeys.delete(key);
  }
  if (seenRunKeys.has(runKey)) return true;
  seenRunKeys.set(runKey, now);
  return false;
}

export function registerInternalRoutes(app: Hono<AppEnv>): void {
  app.post('/internal/runs', async (context) => {
    const config = context.get('config');
    if (context.req.header('x-internal-key') !== config.INTERNAL_API_KEY) {
      throw new ApiProblem(401, 'unauthorized', 'invalid internal API key');
    }

    const parsed = runSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      throw badRequest('invalid_body', 'expected { kind, userId?, runKey? }', parsed.error.issues);
    }

    const userId = parsed.data.userId ?? config.SINGLE_USER_ID;
    const user = await getUser(userId);
    if (!user) throw notFound('user not found');

    const runKey = parsed.data.runKey ?? `${parsed.data.kind}:${userId}:${localDate(user.timezone)}`;
    if (alreadyRan(runKey)) {
      logger().info({ runKey }, 'run skipped: already executed');
      return context.json({ kind: parsed.data.kind, runKey, status: 'skipped', reason: 'duplicate run key' });
    }

    const result = await takeSnapshot(user, context.get('ai'), context.get('requestId'));
    return context.json({ kind: parsed.data.kind, runKey, status: result.skipped ? 'skipped' : 'ok', result });
  });
}

export function resetRunKeysForTests(): void {
  seenRunKeys.clear();
}
