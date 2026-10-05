/**
 * Portfolio read endpoints. Valuation is computed on demand: quotes are cached
 * in the AI service, so a refresh is cheap and always reflects the current
 * holdings rather than a stale materialised view.
 */

import type { Hono } from 'hono';
import type { SnapshotsResponse } from '@traders/shared';

import {
  countObservations,
  getUser,
  listHoldings,
  listLatestNarrationProvenance,
  listObservations,
  listSnapshots,
  primaryAgentId,
  recordQuotes,
} from '../../db/queries.js';
import { logger } from '../../logger.js';
import { narrationStateFrom } from '../../services/narrationHealth.js';
import { SEVERITY_RANK } from '../../services/notificationPolicy.js';
import { valuePortfolio } from '../../services/valuation.js';
import { currentUserId, type AppEnv } from '../app.js';
import { badRequest, notFound } from '../errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every `subject_ref` a finding about `symbol` is stored under: the per-instrument
 * rules write `instrument:NVDA`, allocation drift writes `portfolio:allocation:NVDA`
 * (`services/ai/app/analysis/findings.py`). A holding page asks for both.
 */
export function subjectRefsFor(symbol: string): string[] {
  return [`instrument:${symbol}`, `portfolio:allocation:${symbol}`];
}

export function registerPortfolioRoutes(app: Hono<AppEnv>): void {
  app.get('/portfolio', async (context) => {
    const userId = currentUserId(context);
    const user = await getUser(userId);
    if (!user) throw notFound('user not found');

    const rows = await listHoldings(userId, await primaryAgentId(userId));
    const portfolio = await valuePortfolio(rows, {
      baseCurrency: user.base_currency,
      ai: context.get('ai'),
      requestId: context.get('requestId'),
    });

    // Persist the quotes we just used, so M2's analysis has a price history to
    // work from without a separate backfill. Failure here must not fail the read.
    const quotesToStore = portfolio.holdings
      .filter((holding) => holding.quote && !holding.quote.stale)
      .map((holding) => ({
        instrumentId: holding.instrument.id,
        asOf: holding.quote!.asOf,
        priceMinor: holding.quote!.priceMinor,
        currency: holding.quote!.currency,
        source: holding.quote!.source,
        delaySeconds: holding.quote!.delaySeconds,
      }));
    recordQuotes(quotesToStore).catch((error) =>
      logger().warn({ err: error }, 'failed to record quote history'),
    );

    return context.json(portfolio);
  });

  /**
   * The observations feed: what the analysis engine has found, newest first,
   * and within one scan the most severe first.
   *
   * - `?symbol=NVDA` keeps the findings about one instrument (its holding page);
   * - `?severity=notable` keeps findings at least that severe (notable and high);
   * - `?before=<id>` continues after the last finding the reader has.
   *
   * `total` is how many findings the filter matches in all, and `nextCursor` the
   * id to pass as `before` for the next page - null when there is none, so
   * "no more" is said by the server rather than guessed from a short page.
   *
   * `evidence` is returned in full rather than summarised. It is what makes a
   * claim checkable, and a claim the reader cannot check is the thing this
   * product exists not to make.
   */
  app.get('/observations', async (context) => {
    const userId = currentUserId(context);
    const requested = Number(context.req.query('limit') ?? 50);
    const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 200) : 50;
    const symbol = context.req.query('symbol')?.trim().toUpperCase();
    const severity = context.req.query('severity');
    if (severity !== undefined && !(severity in SEVERITY_RANK)) {
      throw badRequest('invalid_severity', 'severity must be one of info, notable, high');
    }
    const before = context.req.query('before');
    if (before !== undefined && !UUID.test(before)) {
      throw badRequest('invalid_cursor', 'before must be the id of a finding');
    }
    const filter = {
      subjectRefs: symbol ? subjectRefsFor(symbol) : null,
      minRank: severity === undefined ? null : SEVERITY_RANK[severity]!,
    };
    // One more than a page, so whether another page exists is known, not guessed.
    const agentId = await primaryAgentId(userId);
    const [rows, total] = await Promise.all([
      listObservations(userId, agentId, limit + 1, filter, before ?? null),
      countObservations(userId, agentId, filter),
    ]);
    const page = rows.slice(0, limit);
    return context.json({
      total,
      nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
      observations: page.map((row) => ({
        id: row.id,
        kind: row.kind,
        severity: row.severity,
        subjectKind: row.subject_kind,
        subjectRef: row.subject_ref,
        headline: row.headline,
        explanation: row.explanation,
        evidence: row.evidence,
        conceptRefs: row.concept_refs,
        narrationSource: row.narration_source as 'llm' | 'template' | null,
        fallbackReason: row.fallback_reason,
        localized: row.localized,
        createdAt: new Date(row.created_at).toISOString(),
      })),
    });
  });

  /**
   * Whether explanations are being written by a model, and if not, why not.
   *
   * Served here rather than folded into `/observations` because it is a fact
   * about the *system*, not about any one finding, and the page shows it in the
   * header whether or not the feed has anything in it.
   *
   * A failure to reach the AI service degrades to `unknown` rather than to an
   * error: this endpoint reports the health of something else, and an indicator
   * that takes the page down when it cannot read its own subject is worse than
   * one that says it does not know.
   */
  app.get('/narration', async (context) => {
    const userId = currentUserId(context);
    const ai = context.get('ai');

    let config: Awaited<ReturnType<typeof ai.narrationConfig>> | null = null;
    try {
      config = await ai.narrationConfig(context.get('requestId'));
    } catch {
      config = null;
    }

    const rows = config === null ? [] : await listLatestNarrationProvenance(userId);
    const tier = config?.tier ?? 'none';
    const { state, lastFallbackReason } =
      config === null
        ? { state: 'unknown' as const, lastFallbackReason: null }
        : narrationStateFrom(rows, tier);

    return context.json({
      state,
      tier: config === null ? 'none' : tier,
      model: config?.model ?? null,
      sampleSize: rows.length,
      lastFallbackReason,
    });
  });

  app.get('/portfolio/snapshots', async (context) => {
    const userId = currentUserId(context);
    const limit = Number(context.req.query('limit') ?? 365);
    const rows = await listSnapshots(
      userId,
      await primaryAgentId(userId),
      Number.isFinite(limit) ? Math.min(limit, 3650) : 365,
    );
    const response: SnapshotsResponse = {
      snapshots: rows
        .map((row) => ({
          asOf: row.as_of,
          totalMinor: Number(row.total_minor),
          costMinor: Number(row.cost_minor),
          currency: row.currency,
          // Provenance travels with every point: a client charting the series
          // has to be able to mark an approximate total as approximate.
          holdingsCount: Number(row.holdings_count),
          pricedCount: Number(row.priced_count),
          degraded: row.degraded,
        }))
        .reverse(),
    };
    return context.json(response);
  });
}
