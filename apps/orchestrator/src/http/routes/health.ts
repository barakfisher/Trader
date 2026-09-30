/**
 * Probes. `/healthz` is liveness (is the process up), `/readyz` is readiness
 * (can it actually serve: database reachable). `/readyz` also reports whether
 * the AI service answers, in the body only - see the status code below.
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
    // The body reports everything; the status code answers only "should
    // traffic come to this process?" - which is what a Kubernetes readiness
    // probe reads. Postgres gates it: without it this process can serve
    // nothing. The AI service does not: sign-in, holdings and every stored
    // finding work without it, and a probe that failed with it would turn an
    // AI outage into a whole-app outage by taking this pod out of rotation too.
    const unservable = checks.postgres !== 'ok';
    return context.json(
      { status: degraded ? 'degraded' : 'ok', service: 'orchestrator', version: VERSION, checks },
      unservable ? 503 : 200,
    );
  });
}
