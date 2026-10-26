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

import type { Context as HonoContext, Hono } from 'hono';
import { z } from 'zod';

import {
  claimRun,
  deleteExpiredAuthTokens,
  deleteExpiredSessions,
  deleteStaleUnverifiedSignups,
  findInstrumentsBySymbols,
  finishRun,
  getUser,
  listActiveUserIds,
  listActiveUsersAnalysedInstruments,
  listActiveUsersTradedInstruments,
  listRuns,
  primaryAgentId,
  type UserRow,
} from '../../db/queries.js';
import { backfillInstrumentNames } from '../../services/instrumentMetadata.js';
import { AUTH_TOKEN_RETENTION_DAYS, UNVERIFIED_SIGNUP_DAYS } from '../linkTokens.js';
import { runPortfolioScan } from '../../services/portfolioScan.js';
import { marketRetentionDays, runTopicDiscovery } from '../../services/topicDiscovery.js';
import { HISTORY_BACKFILL_DAYS, runTopicScan } from '../../services/topicScan.js';
import { sendDigest } from '../../services/notifications.js';
import { RESCREEN_KIND, startRescreen } from '../../services/universeRescreen.js';
import { EVERY_ACTIVE_USER, INSTALLATION_KINDS } from '../../runKinds.js';
import { MARKET_BENCHMARK_SYMBOLS } from '../../services/marketBenchmarks.js';
import { BENCHMARK_SYMBOL } from '../../services/performance.js';
import { sweepExpiredProposals } from '../../services/proposals.js';
import { planScheduledScans } from '../../services/scheduledScans.js';
import { logger } from '../../logger.js';
import { localDate, takeSnapshot } from '../../services/snapshot.js';
import { currentUserId, type AppEnv } from '../app.js';
import { safeEqual } from '../auth.js';
import { ApiProblem, badRequest, conflict, notFound } from '../errors.js';

/**
 * How often a kind of run is allowed to do work, expressed as the bucket its
 * default run key falls into.
 *
 * The policy lives here rather than in the caller so that the local timer and a
 * Kubernetes CronJob inherit the same behaviour: a trigger is a request to run,
 * and this endpoint decides whether that request is a repeat. A snapshot is the
 * day's closing value, so a second trigger the same day has nothing to add. A
 * scan looks for new findings, so it may run through the day - but two triggers
 * minutes apart would analyse identical data, which is why the bucket is a
 * window rather than an instant.
 */
const RUN_BUCKET_MINUTES: Record<string, number> = {
  snapshot: 24 * 60,
  portfolio_scan: 30,
  // Same cadence as the portfolio scan: both read the same daily closes, and a
  // topic that moved should not be announced half an hour after the holding.
  topic_scan: 30,
  // News moves faster than daily closes, but the only provider today is a
  // fixture, and a real one (GDELT) is polite at this rate. Matches the scans so
  // a story collected in one bucket can be read by the scans of the next.
  news_collect: 30,
  // Discovery reads a week of headlines for themes that last, so a second pass
  // the same day would read nearly the same week and, with the open-proposal
  // bound, usually have nowhere to write. Once a day also keeps it to at most
  // a handful of resolver embeddings a day.
  topic_discovery: 24 * 60,
  // Daily closes appear once a day, so asking more often fetches the same
  // series and writes nothing. The provider quota is the reason to care.
  backfill: 24 * 60,
  // The sweep only writes expiries the clock has already made true, so running
  // it more often costs an indexed scan of a partial index and nothing else.
  // Fifteen minutes bounds how long a dead proposal can sit in the inbox
  // looking answerable - and `effectiveState` means it never actually is.
  proposal_sweep: 15,
  // An expired session or link is already refused by its lookup (D261, D260);
  // the sweep only removes the rows - and the addresses and user agents they
  // keep - so once a day bounds how long that personal data outlives them.
  auth_sweep: 24 * 60,
  // One digest a day, which is what makes it a digest. A second one the same
  // day would split the day's deferred findings across two messages and defeat
  // the batching that is the entire point of deferring them.
  daily_digest: 24 * 60,
  // A name Yahoo does not publish today is unlikely to appear by the afternoon,
  // and every examined row costs an upstream request. Once a day is enough to
  // heal rows created while the provider could not name them.
  instrument_metadata: 24 * 60,
  // The ask for agents' scheduled scans (D69): every quarter hour is enough to
  // start a slot within minutes of its time, and a slot's window is hours long.
  agent_scans: 15,
};

/**
 * The kinds whose failed run is claimed again under the same key - the next
 * hourly ask retries it the same day (decision 150). The backfill: its key is
 * daily, so without a retry one failure - the AI service answering 500 for a
 * minute after the Mac wakes - leaves the day's closes, the benchmarks' among
 * them, missing until tomorrow, while every other kind recovers within the
 * hour. A day-long outage costs at most one attempt an hour. Not the other
 * daily kinds: a failed digest may have sent part of its message.
 */
export const RETRY_FAILED_KINDS: ReadonlySet<string> = new Set(['backfill']);

/** The bucket a moment falls into, as a readable suffix for the run key. */
export function runBucket(kind: string, localDate: string, now: Date = new Date()): string {
  const minutes = RUN_BUCKET_MINUTES[kind] ?? 24 * 60;
  if (minutes >= 24 * 60) return localDate;
  const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
  const slot = Math.floor(minuteOfDay / minutes);
  // Zero-padded so keys sort chronologically when read in psql.
  return `${localDate}:${String(slot).padStart(2, '0')}`;
}

/**
 * How far back each collection asks. Two days, so a run missed overnight is
 * caught up by the next one; dedupe makes the overlap free.
 */
const NEWS_LOOKBACK_HOURS = 48;

const runSchema = z.object({
  kind: z.enum([
    'snapshot',
    'portfolio_scan',
    'topic_scan',
    'news_collect',
    'topic_discovery',
    'backfill',
    'proposal_sweep',
    'auth_sweep',
    'daily_digest',
    'instrument_metadata',
    'universe_rescreen',
    'agent_scans',
  ]),
  userId: z.string().uuid().optional(),
  for: z.literal(EVERY_ACTIVE_USER).optional(),
  runKey: z.string().max(200).optional(),
  trigger: z.string().max(40).optional(),
});

type RunRequest = z.infer<typeof runSchema>;
type Context = HonoContext<AppEnv>;
type FinishedStatus = 'ok' | 'degraded' | 'failed' | 'skipped';

/** What one run answered: the body, and whether it failed. */
interface RunOutcome {
  kind: string;
  runKey: string;
  runId?: string;
  status: string;
  reason?: string;
  result?: unknown;
}

/**
 * Claim a run and, when it is this caller's, do it. A claim already held is the
 * common answer of a timer that asks more often than the work is due.
 */
async function claimAnd(
  claim: { userId: string | null; agentId: string | null; kind: string; runKey: string; trigger: string },
  work: (runId: string) => Promise<RunOutcome>,
): Promise<RunOutcome> {
  const claimed = await claimRun({ ...claim, retryFailed: RETRY_FAILED_KINDS.has(claim.kind) });
  if (!claimed.claimed) {
    logger().info({ runKey: claim.runKey, existingStatus: claimed.existingStatus }, 'run skipped: already claimed');
    return {
      kind: claim.kind,
      runKey: claim.runKey,
      status: 'skipped',
      reason: `this run key was already claimed (${claimed.existingStatus ?? 'unknown'})`,
    };
  }
  const runId = claimed.runId as string;
  try {
    return await work(runId);
  } catch (error) {
    // A failed run must be recorded as failed, not left claimed: otherwise the
    // key blocks every later attempt until the stale-claim window elapses.
    await finishRun(runId, 'failed', { error: (error as Error).message });
    throw error;
  }
}

/** The installation's work (D238): no user, no agent, the installation's day. */
async function runForInstallation(context: Context, request: RunRequest): Promise<RunOutcome> {
  const config = context.get('config');
  const kind = request.kind;
  const runKey =
    request.runKey ?? `${kind}:installation:${runBucket(kind, localDate(config.APP_TIMEZONE))}`;
  const done = async (runId: string, status: FinishedStatus, result: unknown): Promise<RunOutcome> => {
    await finishRun(runId, status, result);
    return { kind, runKey, runId, status, result };
  };

  return claimAnd({ userId: null, agentId: null, kind, runKey, trigger: request.trigger ?? 'unknown' }, async (runId) => {
    if (kind === 'backfill') {
      // Beside what is held and followed: every instrument an agent has ever
      // traded, so a past day stays valued after a sale, and the benchmarks,
      // always: SPY's closes are there before the first agent is (PR 7, D24),
      // and every index a move is set beside has its closes too (decision 149).
      // Every active user's, once: two users holding AAPL fetch it once.
      const [analysed, traded, benchmark] = await Promise.all([
        listActiveUsersAnalysedInstruments(),
        listActiveUsersTradedInstruments(),
        findInstrumentsBySymbols([...new Set([BENCHMARK_SYMBOL, ...MARKET_BENCHMARK_SYMBOLS])]),
      ]);
      const instruments = [
        ...new Map([...analysed, ...traded, ...benchmark].map((row) => [row.id, row])).values(),
      ];
      if (instruments.length === 0) return done(runId, 'skipped', { reason: 'no holdings and no topics' });
      const result = await context.get('ai').backfillHistory(
        {
          instruments: instruments.map((row) => ({ instrument_id: row.id, symbol: row.symbol })),
          days: HISTORY_BACKFILL_DAYS,
        },
        context.get('requestId'),
      );
      // A symbol with no series is a holding the engine cannot analyse, which
      // the user should be able to discover - so it degrades rather than
      // reporting a clean run.
      return done(runId, (result.without_history ?? []).length > 0 ? 'degraded' : 'ok', result);
    }

    if (kind === 'agent_scans') {
      // Only puts due attempts on the queue: the scans run on its worker (D73).
      const result = await planScheduledScans({
        userIds: await listActiveUserIds(),
        ai: context.get('ai'),
        queue: context.get('scanQueue')!,
        now: new Date(),
        requestId: context.get('requestId'),
      });
      return done(runId, 'ok', result);
    }

    if (kind === 'instrument_metadata') {
      const result = await backfillInstrumentNames(context.get('ai'), context.get('requestId'));
      // Nothing to examine is a clean run, not a skipped one: the run asked
      // the only question it exists to ask and the answer was "no gaps".
      // A symbol the provider still cannot name is not a failure either - a
      // null name is a legitimate answer that the UI already renders - so only
      // a resolution that errored degrades the run.
      return done(runId, result.failed.length > 0 ? 'degraded' : 'ok', result);
    }

    if (kind === 'proposal_sweep') {
      // A deadline is a deadline for everybody: one sweep expires every
      // account's proposals.
      return done(runId, 'ok', { expired: (await sweepExpiredProposals()).length });
    }

    if (kind === 'auth_sweep') {
      return done(runId, 'ok', {
        sessions: await deleteExpiredSessions(),
        tokens: await deleteExpiredAuthTokens(AUTH_TOKEN_RETENTION_DAYS),
        unverifiedSignups: await deleteStaleUnverifiedSignups(UNVERIFIED_SIGNUP_DAYS),
      });
    }

    // news_collect. Held and topic instruments only - never the universe. The
    // reason is in app/news/collection.py: a matcher that knows "Target" and
    // "Block" links half of every article to something.
    const instruments = await listActiveUsersAnalysedInstruments();
    if (instruments.length === 0) return done(runId, 'skipped', { reason: 'no holdings and no topics' });
    const result = await context.get('ai').collectNews(
      {
        instruments: instruments.map((row) => ({
          instrument_id: row.id,
          symbol: row.symbol,
          name: row.name,
          asset_class: row.asset_class,
        })),
        lookback_hours: NEWS_LOOKBACK_HOURS,
        market_retention_days: marketRetentionDays(config.TOPIC_PROPOSAL_TTL_DAYS),
      },
      context.get('requestId'),
    );
    // A provider that failed is news the user did not get, and a run that
    // says 'ok' over it would read as a quiet day.
    return done(runId, (result.provider_failures ?? []).length > 0 ? 'degraded' : 'ok', result);
  });
}

/** One user's run of a per-user kind, in that user's day (D161, D163). */
async function runForUser(
  context: Context,
  request: RunRequest,
  user: UserRow,
  runKeyOverride: string | undefined,
): Promise<RunOutcome> {
  const config = context.get('config');
  const kind = request.kind;
  // Resolved once, here at the edge, and passed down. Every user kind is the
  // primary's - the agent-blind ones (topics, digest) by convention, since they
  // are no agent's work (§3.3c).
  const agentId = await primaryAgentId(user.id);
  const runKey = runKeyOverride ?? `${kind}:${user.id}:${runBucket(kind, localDate(user.timezone))}`;
  const done = async (runId: string, status: FinishedStatus, result: unknown): Promise<RunOutcome> => {
    await finishRun(runId, status, result);
    return { kind, runKey, runId, status, result };
  };

  return claimAnd({ userId: user.id, agentId, kind, runKey, trigger: request.trigger ?? 'unknown' }, async (runId) => {
    if (kind === 'daily_digest') {
      const digest = await sendDigest(user, context.get('notifier'));
      // A digest with nothing in it is not a failure and not a success worth
      // claiming: 'skipped' says the run happened and found nothing to say,
      // which is exactly what GET /runs is read to distinguish.
      const status =
        digest.entries === 0 && digest.topics === 0 ? 'skipped' : digest.delivered ? 'ok' : 'degraded';
      return done(runId, status, digest);
    }

    if (kind === 'topic_discovery') {
      const result = await runTopicDiscovery(
        user,
        context.get('ai'),
        {
          cooldownDays: config.TOPIC_REJECTION_COOLDOWN_DAYS,
          proposalTtlDays: config.TOPIC_PROPOSAL_TTL_DAYS,
        },
        context.get('requestId'),
      );
      // No headlines is 'skipped', not 'ok': the run asked nothing, and the
      // reason says where to look. A run that examined phrases and proposed
      // none is 'ok' - every phrase carries its reason in `notProposed`.
      return done(runId, result.degraded ? 'degraded' : result.headlines === 0 ? 'skipped' : 'ok', result);
    }

    if (kind === 'topic_scan') {
      const scan = await runTopicScan(
        user,
        agentId,
        context.get('ai'),
        context.get('notifier'),
        runId,
        context.get('requestId'),
      );
      if (scan === null) return done(runId, 'skipped', { reason: 'no active topics' });
      return done(runId, scan.degraded ? 'degraded' : 'ok', scan);
    }

    if (kind === 'portfolio_scan') {
      const scan = await runPortfolioScan(
        user,
        agentId,
        context.get('ai'),
        context.get('notifier'),
        runId,
        context.get('requestId'),
      );
      // A scan that found nothing is a legitimate outcome, but one that could
      // not look properly is not the same thing - hence 'degraded' rather than
      // 'ok' whenever a rule declined to run or a holding could not be priced.
      return done(runId, scan.degraded ? 'degraded' : 'ok', scan);
    }

    const result = await takeSnapshot(user, agentId, context.get('ai'), context.get('requestId'));
    return done(runId, result.skipped ? 'skipped' : result.degraded ? 'degraded' : 'ok', result);
  });
}

export function registerInternalRoutes(app: Hono<AppEnv>): void {
  app.post('/internal/runs', async (context) => {
    const config = context.get('config');
    if (!safeEqual(context.req.header('x-internal-key') ?? '', config.INTERNAL_API_KEY)) {
      throw new ApiProblem(401, 'unauthorized', 'invalid internal API key');
    }

    const parsed = runSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      throw badRequest('invalid_body', `expected { kind, userId? | for?: "${EVERY_ACTIVE_USER}", runKey?, trigger? }`, parsed.error.issues);
    }
    const request = parsed.data;

    if (INSTALLATION_KINDS.has(request.kind)) {
      if (request.userId !== undefined || request.for !== undefined) {
        throw badRequest('installation_kind', `${request.kind} is the installation's work and names no user`);
      }
      if (request.kind === RESCREEN_KIND) {
        // The AI service finishes the run in the background, so the answer is
        // 202 once handed over. A trigger is a request to run; the run key
        // decides whether it is a repeat (the button and the CronJob share it).
        const started = await startRescreen(context.get('ai'), {
          timezone: config.APP_TIMEZONE,
          trigger: request.trigger ?? 'unknown',
          // Every caller of this endpoint is a timer or a CronJob: it asks hourly,
          // and the rescreen is done only when the universe is a quarter old.
          scheduled: true,
          requestId: context.get('requestId'),
          runKey: request.runKey,
        });
        return context.json({ kind: RESCREEN_KIND, ...started }, started.status === 'running' ? 202 : 200);
      }
      if (request.kind === 'agent_scans' && context.get('scanQueue') === null) {
        // D71: this installation does not schedule scans. Answered without a run
        // row - ninety-six "skipped" rows a day would say nothing new.
        return context.json({
          kind: request.kind,
          status: 'skipped',
          reason: 'scheduled scans are off on this installation (ENABLE_SCHEDULED_SCANS)',
        });
      }
      return context.json(await runForInstallation(context, request));
    }

    // A user's kind: one named user, or every active one. Never a default - a
    // run that names nobody used to run as the first account (D161).
    if (request.userId !== undefined && request.for !== undefined) {
      throw badRequest('ambiguous_target', 'name either userId or for, not both');
    }
    if (request.userId === undefined && request.for === undefined) {
      throw badRequest('no_user', `${request.kind} is a user's work: name a userId or for: "${EVERY_ACTIVE_USER}"`);
    }
    if (request.userId !== undefined) {
      const user = await getUser(request.userId);
      if (!user) throw notFound('user not found');
      if (user.status !== 'active') throw conflict('user_not_active', `the user is ${user.status}`);
      return context.json(await runForUser(context, request, user, request.runKey));
    }
    if (request.runKey !== undefined) {
      throw badRequest('run_key_with_fan_out', 'a fan-out keys each user\'s run itself');
    }

    // In turn, one user at a time (D161): a failure is that user's, recorded on
    // their run, and the next user still runs.
    const userIds = await listActiveUserIds();
    const results: (RunOutcome & { userId: string; error?: string })[] = [];
    for (const userId of userIds) {
      const user = await getUser(userId);
      if (!user) continue;
      try {
        results.push({ userId, ...(await runForUser(context, request, user, undefined)) });
      } catch (error) {
        logger().warn({ kind: request.kind, userId, err: error }, 'run failed for one user');
        results.push({ userId, kind: request.kind, runKey: '', status: 'failed', error: (error as Error).message });
      }
    }
    const failed = results.filter((result) => result.status === 'failed').length;
    // A failure answers 500 so a CronJob's Job shows it (--fail-with-body); the
    // body still says who ran and who did not.
    return context.json(
      { kind: request.kind, for: EVERY_ACTIVE_USER, users: userIds.length, failed, results },
      failed > 0 ? 500 : 200,
    );
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
