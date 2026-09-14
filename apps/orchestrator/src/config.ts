/**
 * Typed configuration. Parsed and validated once, at boot: a missing or malformed
 * value stops the process immediately with a readable message rather than
 * surfacing as an obscure failure on the first request.
 */

import { z } from 'zod';

const schema = z.object({
  APP_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  BASE_CURRENCY: z.string().length(3).default('USD'),
  APP_TIMEZONE: z.string().default('Asia/Jerusalem'),

  ORCHESTRATOR_PORT: z.coerce.number().int().positive().default(8080),
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),

  APP_PASSPHRASE: z.string().min(8, 'APP_PASSPHRASE must be at least 8 characters'),
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24 * 7),

  DATABASE_URL: z.string().url(),
  AI_SERVICE_URL: z.string().url(),
  INTERNAL_API_KEY: z.string().min(8),

  /** Fixed single-user id, seeded by migration 0001. Replaced by real auth later. */
  SINGLE_USER_ID: z.string().uuid().default('00000000-0000-0000-0000-000000000001'),
});

export type Config = z.infer<typeof schema> & {
  allowedOrigins: string[];
  isProduction: boolean;
};

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = {
    ...parsed.data,
    allowedOrigins: parsed.data.ALLOWED_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    isProduction: parsed.data.APP_ENV === 'production',
  };
  return cached;
}

/** Test helper: forget the memoised config so a new environment can be loaded. */
export function resetConfigForTests(): void {
  cached = null;
}
