/**
 * Typed configuration. Parsed and validated once, at boot: a missing or malformed
 * value stops the process immediately with a readable message rather than
 * surfacing as an obscure failure on the first request.
 */

import { z } from 'zod';

/**
 * An optional setting whose *empty* value also means "not set".
 *
 * `z.string().min(1).optional()` is not enough, and the difference is not
 * academic: docker-compose passes through every variable named in
 * `.env.example`, so an unconfigured secret arrives as `''` rather than absent,
 * `.optional()` does not fire, and `.min(1)` then refuses the value - taking the
 * whole service down at boot over a setting documented as optional.
 *
 * Found by the compose smoke test, which is the only gate that starts the
 * service the way it is actually deployed. The unit tests pass their env in as
 * an object and simply omit the key, so they never saw it.
 */
const optionalSetting = (minLength = 1) =>
  z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(minLength).optional(),
  );

/** Rejection memory's default cooldown; see `TOPIC_REJECTION_COOLDOWN_DAYS`. */
export const DEFAULT_REJECTION_COOLDOWN_DAYS = 90;

/** How long an unanswered auto-proposal stays open; see `TOPIC_PROPOSAL_TTL_DAYS`. */
export const DEFAULT_PROPOSAL_TTL_DAYS = 14;

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

  /**
   * Telegram bot credential. Optional, and its absence is a supported state
   * rather than a misconfiguration: the notification fan-out, the dedupe
   * guarantee and quiet hours all work without a channel, and every suppressed
   * message is still recorded with its reason. An installation with no token
   * gets a NullNotifier that declines with that reason, exactly as the LLM
   * layer distinguishes deliberately-off from broken.
   */
  TELEGRAM_BOT_TOKEN: optionalSetting(),

  /** The bot's @name, needed to build the t.me deep link and nothing else. */
  TELEGRAM_BOT_USERNAME: optionalSetting(),

  /**
   * Echoed by Telegram on every webhook delivery, and used for **that and
   * nothing else**: it answers "is this request really from Telegram?".
   *
   * It is a *shared* value. Telegram holds a copy, it rides in the header of
   * every inbound request, and anywhere TLS terminates - an ingress, a proxy -
   * it is plaintext that request logging will happily capture. So its blast
   * radius is wide, and nothing may be signed with it.
   */
  TELEGRAM_WEBHOOK_SECRET: optionalSetting(16),

  /**
   * The signing key for everything this service mints: the inline-button
   * payloads and the "Connect Telegram" deep links.
   *
   * It never leaves this process, which is the whole point of it being separate
   * from the webhook secret. The first version signed bind tokens with the
   * webhook secret instead, and that was a real hole rather than an untidiness:
   * `SINGLE_USER_ID` defaults to a value published in this repository, so
   * anyone who read the shared secret out of a proxy log could mint a connect
   * link for that account, bind their own chat, and approve its proposals.
   *
   * One key signs two kinds of token, so each is signed over a domain tag -
   * see `bindToken.ts` - and neither can be presented as the other.
   */
  TELEGRAM_SIGNING_SECRET: optionalSetting(16),

  /**
   * The web app's public address, e.g. `https://traders.example.com`. When set,
   * a Telegram proposal carries an "Open in app" button to `/proposals/<id>`
   * (FR-21). Unset until the app has a public https address (M7): Telegram
   * refuses a URL button on `http://` or a private host - and refuses the whole
   * message with it - so a value that is not https is ignored with a warning
   * rather than sent (`notify/factory.ts`).
   */
  WEB_BASE_URL: optionalSetting(),

  /**
   * How taps and commands reach this service. `polling` pulls them with
   * `getUpdates` and is the default, because the webhook needs a public HTTPS
   * URL that no installation has until M7's ingress. `webhook` once one is
   * registered - Telegram refuses to serve both at once. `off` for a process
   * that must not consume updates, such as a second replica.
   *
   * Empty means unset, for the reason `optionalSetting` gives: compose passes a
   * blank line through as `''`, and an enum would refuse it at boot.
   */
  TELEGRAM_UPDATES: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.enum(['polling', 'webhook', 'off']).default('polling'),
  ),

  /**
   * How long a rejected auto-proposal is remembered (FR-11), in days.
   *
   * Rejection memory is a cooldown rather than forever, by the user's decision
   * on 2026-09-27: what a person follows changes, and a theme turned down in
   * spring may be the one they want in autumn. Inside the window, a proposal
   * that matches a rejected one is never shown (`topicMatching.ts` defines
   * "matches"). After it, the rejected row still exists - the history is kept -
   * but no longer suppresses anything.
   */
  TOPIC_REJECTION_COOLDOWN_DAYS: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.coerce.number().int().min(1).max(3650).default(DEFAULT_REJECTION_COOLDOWN_DAYS),
  ),

  /**
   * How long an auto-proposal waits for an answer before it expires, in days.
   *
   * At most `MAX_OPEN_PROPOSALS` proposals are open at once, so without an
   * expiry a few ignored ones stop discovery for good. Two weeks is two
   * discovery windows: long enough to be seen by someone who opens the app
   * weekly, short enough that a slot is not held by a story the news has left.
   * A product bound; nothing measured it. An expired proposal is kept, not
   * deleted (migration 0021).
   */
  TOPIC_PROPOSAL_TTL_DAYS: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.coerce.number().int().min(1).max(365).default(DEFAULT_PROPOSAL_TTL_DAYS),
  ),
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
