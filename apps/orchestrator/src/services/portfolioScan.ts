/**
 * The scheduled scan: value the portfolio, analyse it, store what is new.
 *
 * The division of labour matters. This process owns the portfolio, the FX rates
 * and the single rounding boundary, so it values the holdings and sends the
 * result. The AI service owns the price history, the rules and the words. And
 * the write stays here, because idempotency belongs to whoever holds the run
 * key - one process is responsible for not saying the same thing twice.
 */

import type { AiClient } from '@traders/shared/ai';

import {
  getOrCreateUserSettings,
  insertObservations,
  listHoldings,
  listRecentDedupeKeys,
  listTargetWeights,
  type ObservationToStore,
  type UserRow,
} from '../db/queries.js';
import { logger } from '../logger.js';
import { mayRaiseProposal, startProposalLifecycle } from '../mastra/proposalLifecycle.js';
import type { Notifier } from '../notify/notifier.js';
import { fanOut, settingsForNotification, type NotifiableFinding } from './notifications.js';
import { valuePortfolio } from './valuation.js';

export interface ScanResult {
  holdings: number;
  priced: number;
  findings: number;
  created: number;
  /** Skipped before narration, because the feed already had them. */
  alreadyKnown: number;
  /** Lost a race with a concurrent scan. Expected to be zero. */
  suppressed: number;
  narratedByLlm: number;
  narrationFallbacks: Record<string, number>;
  /** Present when a rule declined to run, and why. Never silently absent. */
  skipped: string[];
  degraded: boolean;
  /** New findings that warranted a decision, and how many became one. */
  proposalsSelected: number;
  proposalsCreated: number;
  /** Where the new findings went: pushed now, deferred to the digest, or already sent. */
  notified: { pushed: number; deferred: number; duplicate: number; failed: number };
}

export async function runPortfolioScan(
  user: UserRow,
  ai: AiClient,
  notifier: Notifier,
  runId: string | null,
  requestId?: string,
): Promise<ScanResult> {
  const rows = await listHoldings(user.id);
  if (rows.length === 0) {
    return {
      holdings: 0,
      priced: 0,
      findings: 0,
      created: 0,
      alreadyKnown: 0,
      suppressed: 0,
      narratedByLlm: 0,
      narrationFallbacks: {},
      skipped: ['no holdings to analyse'],
      degraded: false,
      proposalsSelected: 0,
      proposalsCreated: 0,
      notified: { pushed: 0, deferred: 0, duplicate: 0, failed: 0 },
    };
  }

  // The user's own statement of the allocation they meant to hold. Read here
  // rather than defaulted to `{}`: until this call existed the drift rule had
  // nothing to compare against and every scan reported it as skipped.
  const targets = await listTargetWeights(user.id);

  const knownKeys = await listRecentDedupeKeys(user.id);

  const portfolio = await valuePortfolio(rows, {
    baseCurrency: user.base_currency,
    ai,
    requestId,
  });

  const response = await ai.portfolioScan(
    {
      base_currency: portfolio.summary.baseCurrency,
      holdings: portfolio.holdings.map((holding) => ({
        instrument_id: holding.instrument.id,
        symbol: holding.instrument.symbol,
        // Null rather than zero: an unpriced holding is a known unknown, and the
        // scan needs to see it to report that drift was skipped.
        value_minor: holding.valueMinor,
        currency: portfolio.summary.baseCurrency,
        // The observation time behind the value, not the time we fetched it.
        // Allocation drift dates a weight by its stalest input, and a position
        // without this cannot take part in the calculation at all.
        as_of: holding.quote?.asOf ?? null,
      })),
      // Symbol -> decimal string, exactly as stored. The weight never becomes a
      // number on this side of the wire.
      target_weights: Object.fromEntries(targets.map((target) => [target.symbol, target.weight])),
      // What the feed already holds. The scan skips these before narrating, so a
      // repeated finding costs a hash rather than a model call - which matters
      // at a thirty-minute cadence, where most of what a scan finds is what the
      // last one found.
      known_dedupe_keys: knownKeys,
    },
    requestId,
  );

  const toStore: ObservationToStore[] = response.observations.map((observation) => ({
    userId: user.id,
    runId,
    kind: observation.kind,
    severity: observation.severity,
    subjectKind: observation.subject_ref.startsWith('portfolio') ? 'portfolio' : 'instrument',
    subjectRef: observation.subject_ref,
    headline: observation.headline,
    explanation: observation.explanation,
    evidence: observation.evidence ?? {},
    conceptRefs: observation.concept_refs ?? [],
    dedupeKey: observation.dedupe_key,
    // The AI service has always reported both and this mapping used to drop
    // them on the floor. `?? null` rather than a default: a response that omits
    // them is a response that does not know, and inventing 'template' here
    // would attribute authorship nobody checked.
    narrationSource: observation.narration_source ?? null,
    fallbackReason: observation.fallback_reason ?? null,
  }));

  const { created, suppressed, inserted } = await insertObservations(toStore);

  /**
   * Proposals are raised only for observations this scan actually created. A
   * suppressed finding is one the feed already reported, and it either raised a
   * proposal at the time or was not the kind that does - either way, asking the
   * user about it again because the market has not moved is how an approvals
   * inbox becomes something people stop reading.
   *
   * The settings read is per scan rather than per finding: the thresholds are
   * the user's, so they cannot come from `config`, but they also cannot change
   * halfway through one scan's results without making that scan's output
   * incoherent.
   */
  const settings = await getOrCreateUserSettings(user.id);
  const proposalSettings = {
    proposalSeverity: settings.proposal_severity,
    proposalTtlHours: settings.proposal_ttl_hours,
  };

  /**
   * One lifecycle per candidate, rather than one batch insert for all of them.
   *
   * The raise itself still happens inside `raiseProposals`, called by the
   * workflow's first step - what changed is that a proposal is now raised *by*
   * the run that will wait for its answer, so there is no window in which a
   * question exists and nothing is holding it open. The cost is one INSERT per
   * proposal instead of one for the batch, which at the current policy (one
   * proposable kind, one finding at a time) is the same INSERT.
   */
  const candidates = inserted
    .map((observation) => ({
      id: observation.id,
      kind: observation.kind,
      severity: observation.severity,
      subjectRef: observation.subject_ref,
      evidence: observation.evidence,
    }))
    .filter((finding) => mayRaiseProposal(finding, settings.proposal_severity));

  const raised: { proposalId: string | null }[] = [];
  for (const finding of candidates) {
    raised.push(
      await startProposalLifecycle({ userId: user.id, finding, settings: proposalSettings }),
    );
  }

  const skipped: string[] = [];
  if (response.stats.drift_skipped_reason) {
    skipped.push(`allocation drift: ${response.stats.drift_skipped_reason}`);
  }
  if (response.stats.insufficient_history?.length) {
    skipped.push(
      `insufficient price history: ${response.stats.insufficient_history.join(', ')}`,
    );
  }

  /**
   * Tell the user about what was found - but only about findings this scan
   * actually created, for the same reason proposals are only raised for those:
   * a repeated finding has already been announced, and announcing it again
   * because the market has not moved is how a notification channel becomes one
   * the user mutes.
   *
   * The fan-out runs after the proposals are raised so that a finding the user
   * can act on carries its proposal id, and a channel can offer the buttons
   * rather than a link to go and find them.
   */
  /**
   * Which findings became answerable questions, by observation.
   *
   * Zipped by index against `candidates` because the lifecycle reports only the
   * proposal it raised - the loop above walks the candidates in order, so the
   * positions correspond. A proposal id of null means this scan did not raise
   * one (an earlier run already had), and that finding gets no buttons.
   */
  const proposalByObservation = new Map(
    candidates
      .map((finding, index) => [finding.id, raised[index]?.proposalId ?? null] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== null),
  );
  const notifiable: NotifiableFinding[] = inserted.map((observation) => {
    const proposalId = proposalByObservation.get(observation.id);
    return {
      refKind: 'observation' as const,
      refId: observation.id,
      severity: observation.severity,
      headline: observation.headline,
      explanation: observation.explanation,
      // Only set when this finding actually became a question. A channel uses
      // it to render Approve/Reject inline, so attaching one to a finding with
      // no proposal behind it would put buttons on a message that cannot be
      // answered.
      ...(proposalId === undefined ? {} : { proposalId }),
    };
  });
  const notified = await fanOut(
    user.id,
    notifiable,
    settingsForNotification(settings, user.timezone),
    notifier,
  );

  const result: ScanResult = {
    holdings: rows.length,
    priced: portfolio.summary.pricedCount,
    findings: response.stats.findings,
    created,
    alreadyKnown: response.stats.already_known ?? 0,
    suppressed,
    narratedByLlm: response.stats.narrated_by_llm,
    narrationFallbacks: response.stats.narration_fallbacks ?? {},
    skipped,
    // A scan that could not price everything, or whose rules declined to run,
    // did less than it appears to have done. Recording that is the difference
    // between "nothing happened" and "we did not look".
    degraded: portfolio.summary.degraded || skipped.length > 0,
    proposalsSelected: candidates.length,
    proposalsCreated: raised.filter((lifecycle) => lifecycle.proposalId !== null).length,
    notified: {
      pushed: notified.pushed,
      deferred: notified.deferred,
      duplicate: notified.duplicate,
      failed: notified.failed,
    },
  };

  logger().info({ userId: user.id, ...result }, 'portfolio scan complete');
  return result;
}
