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

import { claimRun, finishRun, getUser, listAnalysedInstruments, listRuns } from '../../db/queries.js';
import { sweepAndCloseLifecycles } from '../../mastra/proposalLifecycle.js';
import { backfillInstrumentNames } from '../../services/instrumentMetadata.js';
import { runPortfolioScan } from '../../services/portfolioScan.js';
import { marketRetentionDays, runTopicDiscovery } from '../../services/topicDiscovery.js';
import { HISTORY_BACKFILL_DAYS, runTopicScan } from '../../services/topicScan.js';
import { sendDigest } from '../../services/notifications.js';
import { sweepExpiredProposals } from '../../services/proposals.js';
import { logger } from '../../logger.js';
import { localDate, takeSnapshot } from '../../services/snapshot.js';
import { currentUserId, type AppEnv } from '../app.js';
import { ApiProblem, badRequest, notFound } from '../errors.js';

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
  // One digest a day, which is what makes it a digest. A second one the same
  // day would split the day's deferred findings across two messages and defeat
  // the batching that is the entire point of deferring them.
  daily_digest: 24 * 60,
  // A name Yahoo does not publish today is unlikely to appear by the afternoon,
  // and every examined row costs an upstream request. Once a day is enough to
  // heal rows created while the provider could not name them.
  instrument_metadata: 24 * 60,
};

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
    'daily_digest',
    'instrument_metadata',
  ]),
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

    const runKey =
      parsed.data.runKey ??
      `${parsed.data.kind}:${userId}:${runBucket(parsed.data.kind, localDate(user.timezone))}`;
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
      if (parsed.data.kind === 'backfill') {
        const instruments = await listAnalysedInstruments(userId);
        if (instruments.length === 0) {
          await finishRun(runId, 'skipped', { reason: 'no holdings and no topics' });
          return context.json({ kind: parsed.data.kind, runKey, runId, status: 'skipped' });
        }
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
        const degraded = (result.without_history ?? []).length > 0;
        await finishRun(runId, degraded ? 'degraded' : 'ok', result);
        return context.json({
          kind: parsed.data.kind,
          runKey,
          runId,
          status: degraded ? 'degraded' : 'ok',
          result,
        });
      }

      if (parsed.data.kind === 'instrument_metadata') {
        const result = await backfillInstrumentNames(context.get('ai'), context.get('requestId'));
        // Nothing to examine is a clean run, not a skipped one: the run asked
        // the only question it exists to ask and the answer was "no gaps".
        // A symbol the provider still cannot name is not a failure either - a
        // null name is a legitimate answer that the UI already renders - so only
        // a resolution that errored degrades the run.
        const status = result.failed.length > 0 ? 'degraded' : 'ok';
        await finishRun(runId, status, result);
        return context.json({ kind: parsed.data.kind, runKey, runId, status, result });
      }

      if (parsed.data.kind === 'daily_digest') {
        const digest = await sendDigest(user, context.get('notifier'));
        // A digest with nothing in it is not a failure and not a success worth
        // claiming: 'skipped' says the run happened and found nothing to say,
        // which is exactly what GET /runs is read to distinguish.
        const status =
          digest.entries === 0 && digest.topics === 0
            ? 'skipped'
            : digest.delivered
              ? 'ok'
              : 'degraded';
        await finishRun(runId, status, digest);
        return context.json({
          kind: parsed.data.kind,
          runKey,
          runId,
          status,
          result: digest,
        });
      }

      if (parsed.data.kind === 'proposal_sweep') {
        // Deliberately not scoped to `userId`: a deadline is a deadline for
        // everybody, and a sweep that only expired the triggering user's
        // proposals would leave every other account's inbox stale for as long
        // as that account stayed quiet.
        // The sweep also ends the workflow runs suspended on what it expired;
        // a deadline nobody is told about leaves a run waiting forever.
        const expired = await sweepAndCloseLifecycles();
        await finishRun(runId, 'ok', { expired });
        return context.json({
          kind: parsed.data.kind,
          runKey,
          runId,
          status: 'ok',
          result: { expired },
        });
      }

      if (parsed.data.kind === 'news_collect') {
        // Held and topic instruments only - never the universe. The reason is
        // in app/news/collection.py: a matcher that knows "Target" and "Block"
        // links half of every article to something.
        const instruments = await listAnalysedInstruments(userId);
        if (instruments.length === 0) {
          await finishRun(runId, 'skipped', { reason: 'no holdings and no topics' });
          return context.json({ kind: parsed.data.kind, runKey, runId, status: 'skipped' });
        }
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
        const status = (result.provider_failures ?? []).length > 0 ? 'degraded' : 'ok';
        await finishRun(runId, status, result);
        return context.json({ kind: parsed.data.kind, runKey, runId, status, result });
      }

      if (parsed.data.kind === 'topic_discovery') {
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
        const status = result.degraded
          ? 'degraded'
          : result.headlines === 0
            ? 'skipped'
            : 'ok';
        await finishRun(runId, status, result);
        return context.json({ kind: parsed.data.kind, runKey, runId, status, result });
      }

      if (parsed.data.kind === 'topic_scan') {
        const scan = await runTopicScan(
          user,
          context.get('ai'),
          context.get('notifier'),
          runId,
          context.get('requestId'),
        );
        if (scan === null) {
          await finishRun(runId, 'skipped', { reason: 'no active topics' });
          return context.json({ kind: parsed.data.kind, runKey, runId, status: 'skipped' });
        }
        const status = scan.degraded ? 'degraded' : 'ok';
        await finishRun(runId, status, scan);
        return context.json({ kind: parsed.data.kind, runKey, runId, status, result: scan });
      }

      if (parsed.data.kind === 'portfolio_scan') {
        const scan = await runPortfolioScan(
          user,
          context.get('ai'),
          context.get('notifier'),
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
