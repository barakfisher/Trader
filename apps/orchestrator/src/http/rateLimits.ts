/**
 * How often one caller may do something that costs money, shared quota or a
 * password hash (D257).
 *
 * **What is limited, keyed on what:**
 * - signing in: failed attempts, per account (the email in the body) and per
 *   client address. Only failures count, so a user who signs in often is never
 *   refused; a success clears the account's count.
 * - asking to join: every request, per address and per email. Reset and
 *   verification requests (D258-D260) take the same two keys when they exist.
 * - the routes that spend the model, the embedder or the market-data quota every
 *   user shares: per signed-in user. The assistant and a re-check count the same
 *   whether they come from the page or from Telegram.
 *
 * **Where the counts live:** in Redis, so they survive a restart and are shared
 * by every replica. Each limit is a fixed window of `durationSeconds`; once
 * spent, the caller is refused until the window ends, and the refusal says when
 * that is (429 with `Retry-After`).
 *
 * The numbers are named here and nowhere else; tests read them from here
 * (convention 1).
 */

import type { Context, MiddlewareHandler } from 'hono';
import { Redis } from 'ioredis';
import {
  RateLimiterMemory,
  RateLimiterRedis,
  RateLimiterRes,
  type RateLimiterAbstract,
} from 'rate-limiter-flexible';

import { logger } from '../logger.js';
import type { AppEnv } from './app.js';
import { requestClientAddress } from './clientAddress.js';
import { ApiProblem, unauthorized } from './errors.js';

export interface RateLimit {
  /** How many the window allows. */
  points: number;
  /** The window's length. */
  durationSeconds: number;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;

/**
 * Every limit. Measured before choosing (compose, 2026-09-30 to 2026-10-22, two
 * users): the busiest hour held 3 assistant questions, 2 manual scans, 2
 * instruction checks and 1 re-check; the busiest minute 7 holdings and 6 topics
 * created (an import, a topic burst). Each limit leaves a person working by
 * hand well inside it and stops a script within the hour.
 */
export const RATE_LIMITS = {
  /** Wrong passwords for one account, from anywhere. */
  loginFailuresPerAccount: { points: 10, durationSeconds: 15 * MINUTE },
  /** Wrong passwords from one address, for any account: a shared office still fits. */
  loginFailuresPerAddress: { points: 50, durationSeconds: HOUR },
  /** Requests to join from one address. */
  signupPerAddress: { points: 5, durationSeconds: HOUR },
  /** Requests to join with one email: each sends that address a mail (D303). */
  signupPerEmail: { points: 3, durationSeconds: HOUR },
  /** New verification links for one account, asked from sign-in (D306): each is a mail. */
  verificationResendPerAccount: { points: 3, durationSeconds: HOUR },
  /** Reset links asked for from one address, for any email (D260). */
  resetRequestPerAddress: { points: 5, durationSeconds: HOUR },
  /** Reset links asked for one email: each is a mail to it (D260). */
  resetRequestPerEmail: { points: 3, durationSeconds: HOUR },
  /** Sign-ins through Google or GitHub started from one address: each is a round trip to the provider (D262). */
  oauthStartPerAddress: { points: 30, durationSeconds: HOUR },
  /** New passwords sent with a reset link from one address: each may cost an argon2 hash (D312). */
  resetAttemptPerAddress: { points: 20, durationSeconds: HOUR },
  /** Address changes asked for by one user: each mails the new address and the old (D259). */
  emailChangePerUser: { points: 5, durationSeconds: HOUR },
  /** Exports of one user's data: each reads every row the account holds (D264). */
  dataExportPerUser: { points: 5, durationSeconds: HOUR },
  /** *Run a scan now*: three active agents, each a few times an hour. */
  agentScan: { points: 10, durationSeconds: HOUR },
  /** Questions to the assistant, on the Ask page and in Telegram together. */
  assistantQuestion: { points: 30, durationSeconds: HOUR },
  /** An agent's instructions checked against its mandate. */
  instructionsCheck: { points: 20, durationSeconds: HOUR },
  /** Research on the main portfolio started now: a model call per holding (D254). */
  researchRun: { points: 6, durationSeconds: HOUR },
  /** An expired proposal re-checked, on the page and in Telegram together. */
  proposalRecheck: { points: 20, durationSeconds: HOUR },
  /** A holding added or a file previewed: each resolves symbols against market data. */
  symbolResolve: { points: 60, durationSeconds: HOUR },
  /**
   * A symbol searched at the market-data provider or a price read for the
   * add-holding form (D324). Generous, since the form asks only when the local
   * list has no match and the AI service caches each query for a day; it
   * caps a script, not a typist.
   */
  symbolLookup: { points: 240, durationSeconds: HOUR },
  /**
   * The same lookups per minute. Each distinct query misses the AI service's
   * cache and spends one call from the installation's shared Yahoo budget (60 a
   * minute), so a burst from one account must not empty it for everyone
   * (security review of PRs 1-3, 2026-10-27). A typist pausing 300 ms between
   * queries stays well inside it.
   */
  symbolLookupBurst: { points: 20, durationSeconds: MINUTE },
  /** A topic resolved, created or renamed: an embedding and a market-data resolve. */
  topicResolve: { points: 60, durationSeconds: HOUR },
  /** A concept searched: an embedding. */
  conceptSearch: { points: 120, durationSeconds: HOUR },
} as const satisfies Record<string, RateLimit>;

export type RateLimitScope = keyof typeof RATE_LIMITS;

/** The scopes keyed per signed-in user. */
export type UserRateLimitScope = Exclude<
  RateLimitScope,
  | 'loginFailuresPerAccount'
  | 'loginFailuresPerAddress'
  | 'signupPerAddress'
  | 'signupPerEmail'
  | 'verificationResendPerAccount'
  | 'resetRequestPerAddress'
  | 'resetRequestPerEmail'
  | 'resetAttemptPerAddress'
  | 'oauthStartPerAddress'
>;

/** Redis keys start with this, then the scope: `rate:agentScan:user:<id>`. */
export const RATE_LIMIT_KEY_PREFIX = 'rate';

/** The error code a refusal carries; the web translates it (`api.rateLimited`). */
export const RATE_LIMITED = 'rate_limited';

/** What a refusal carries: when to try again, in whole seconds, at least one. */
export interface RateLimitRefusal {
  retryAfterSeconds: number;
}

export function rateLimited(refusal: RateLimitRefusal): ApiProblem {
  return new ApiProblem(
    429,
    RATE_LIMITED,
    `too many requests; try again in ${refusal.retryAfterSeconds} s`,
    refusal,
    { 'retry-after': String(refusal.retryAfterSeconds) },
  );
}

function refusalOf(result: RateLimiterRes): RateLimitRefusal {
  return { retryAfterSeconds: Math.max(1, Math.ceil(result.msBeforeNext / 1000)) };
}

/** A client address as a key part; one bucket for requests whose address is unknown. */
export function addressKey(address: string | null): string {
  return `address:${address ?? 'unknown'}`;
}

export function emailKey(email: string): string {
  return `email:${email}`;
}

export function userKey(userId: string): string {
  return `user:${userId}`;
}

/**
 * The limits, one limiter per scope. Built over Redis by `redisRateLimits`, or
 * in memory by `memoryRateLimits` (tests, and the fallback inside the Redis one).
 */
export class RateLimits {
  constructor(private readonly limiters: Record<RateLimitScope, RateLimiterAbstract>) {}

  /** Count one against `key`; null if allowed, or when to retry if the window is spent. */
  async take(scope: RateLimitScope, key: string): Promise<RateLimitRefusal | null> {
    try {
      await this.limiters[scope].consume(key);
      return null;
    } catch (error) {
      if (error instanceof RateLimiterRes) return refusalOf(error);
      throw error;
    }
  }

  /** Count one against `key`, refusing the request with 429 if the window is spent. */
  async consume(scope: RateLimitScope, key: string): Promise<void> {
    const refusal = await this.take(scope, key);
    if (refusal !== null) throw rateLimited(refusal);
  }

  /** Refuse with 429 if `key` has nothing left, without counting this request. */
  async refuseIfSpent(scope: RateLimitScope, key: string): Promise<void> {
    const state = await this.limiters[scope].get(key);
    if (state !== null && state.remainingPoints <= 0) throw rateLimited(refusalOf(state));
  }

  /** Count one against `key` and never refuse: the next request is the one refused. */
  async record(scope: RateLimitScope, key: string): Promise<void> {
    await this.take(scope, key);
  }

  async reset(scope: RateLimitScope, key: string): Promise<void> {
    await this.limiters[scope].delete(key);
  }
}

function limiterOptions(scope: RateLimitScope) {
  const { points, durationSeconds } = RATE_LIMITS[scope];
  return { keyPrefix: `${RATE_LIMIT_KEY_PREFIX}:${scope}`, points, duration: durationSeconds };
}

function eachScope(build: (scope: RateLimitScope) => RateLimiterAbstract): Record<RateLimitScope, RateLimiterAbstract> {
  return Object.fromEntries(
    (Object.keys(RATE_LIMITS) as RateLimitScope[]).map((scope) => [scope, build(scope)]),
  ) as Record<RateLimitScope, RateLimiterAbstract>;
}

/** Limits counted in this process only. */
export function memoryRateLimits(): RateLimits {
  return new RateLimits(eachScope((scope) => new RateLimiterMemory(limiterOptions(scope))));
}

/**
 * Limits counted in Redis. While Redis cannot be reached, each limiter counts in
 * this process's memory instead (the package's insurance limiter): the same
 * numbers, per replica, and forgotten on restart - neither open nor shut.
 */
export function redisRateLimits(client: Redis): RateLimits {
  return new RateLimits(
    eachScope(
      (scope) =>
        new RateLimiterRedis({
          ...limiterOptions(scope),
          storeClient: client,
          // A down Redis answers at once rather than after a timeout.
          rejectIfRedisNotReady: true,
          insuranceLimiter: new RateLimiterMemory(limiterOptions(scope)),
        }),
    ),
  );
}

/**
 * The limits' own Redis connection. Commands are never queued while it is down
 * (the insurance limiter answers instead), and it keeps reconnecting.
 */
export function connectRateLimitRedis(url: string): Redis {
  const client = new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  client.on('error', (error: Error) => logger().warn({ err: error.message }, 'rate_limits.redis_error'));
  return client;
}

/**
 * A route spent per signed-in user. Mounted on the route itself, after the
 * session gate, so the user is always known here.
 */
export function limitPerUser(scope: UserRateLimitScope): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    const userId = context.get('userId');
    if (!userId) throw unauthorized();
    await context.get('rateLimits').consume(scope, userKey(userId));
    await next();
  };
}

/** The request's client address as a limit key, past the configured proxies. */
export function requestAddressKey(context: Context, trustedProxyHops: number): string {
  return addressKey(requestClientAddress(context, trustedProxyHops));
}
