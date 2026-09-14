/**
 * Probes. `/healthz` is liveness (is the process up), `/readyz` is readiness
 * (can it actually serve: database reachable, AI service reachable).
 */

import type { Hono } from 'hono';

import { queryOne } from '../../db/pool.js';
import type { AppEnv } from '../app.js';

export const VERSION = '0.1.0';

export function registerHealthRoutes(app: Hono<AppEnv>): void {
  app.get('/healthz', (context) =>
    context.json({ status: 'ok', service: 'orchestrator', version: VERSION }),
  );

  app.get('/readyz', async (context) => {
    const checks: Record<string, string> = {};

    try {
      await queryOne('SELECT 1 AS ok');
      checks.postgres = 'ok';
    } catch (error) {
      checks.postgres = `error: ${(error as Error).message}`;
    }

    try {
      const health = await context.get('ai').health(context.get('requestId'));
      checks.aiService = health.status;
      checks.providers = health.checks?.providers ?? 'unknown';
    } catch (error) {
      checks.aiService = `error: ${(error as Error).message}`;
    }

    const degraded = Object.values(checks).some(
      (value) => value.startsWith('error') || value === 'degraded',
    );
    return context.json(
      { status: degraded ? 'degraded' : 'ok', service: 'orchestrator', version: VERSION, checks },
      degraded ? 503 : 200,
    );
  });
}
