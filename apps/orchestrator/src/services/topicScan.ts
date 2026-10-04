/**
 * The scheduled topic scan (FLOWS F5): measure each confirmed topic, store what is new.
 *
 * The same division of labour as `portfolioScan.ts`. This process owns which
 * topics exist and which instruments the user confirmed for each; the AI service
 * owns the price history, the rule and the words; the write stays here, with the
 * run key.
 *
 * Two things it deliberately does not do. It raises no proposals: a theme moving
 * is something to know, not something to approve, and `PROPOSABLE_KINDS` is the
 * one place that policy would change. And it says nothing about news, because no
 * news is collected yet - a scan that implied it had looked would be the silent
 * absence this project keeps designing against.
 */

import type { AiClient, BackfillRequest, TopicScanRequest } from '@traders/shared/ai';

import {
  getOrCreateUserSettings,
  insertObservations,
  listActiveTopicInstruments,
  listRecentDedupeKeys,
  type ActiveTopicInstrumentRow,
  type ObservationToStore,
  type UserRow,
} from '../db/queries.js';
import { logger } from '../logger.js';
import type { Notifier } from '../notify/notifier.js';
import { watchNarration, type NarrationWatchOutcome } from './narrationWatch.js';
import { fanOut, settingsForNotification, type NotifiableFinding } from './notifications.js';

/**
 * Days of daily closes fetched for an instrument the analysis reads. The daily
 * backfill run and the backfill a confirm triggers share it, so a topic confirmed
 * this morning has the same history as one confirmed last month.
 */
export const HISTORY_BACKFILL_DAYS = 180;

export interface TopicScanResult {
  topics: number;
  measured: number;
  instruments: number;
  findings: number;
  created: number;
  alreadyKnown: number;
  suppressed: number;
  narratedByLlm: number;
  narrationFallbacks: Record<string, number>;
  /** Topic label -> why it could not be measured. A quiet topic is not listed. */
  skipped: Record<string, string>;
  degraded: boolean;
  notified: { pushed: number; deferred: number; duplicate: number; failed: number };
  /** What this scan learned about who writes the explanations (`narrationWatch.ts`). */
  narration: NarrationWatchOutcome;
}

/** Rows of one topic are adjacent (the query orders them), so grouping is one pass. */
export function groupTopics(rows: ActiveTopicInstrumentRow[]): TopicScanRequest['topics'] {
  const topics: TopicScanRequest['topics'] = [];
  for (const row of rows) {
    let topic = topics[topics.length - 1];
    if (!topic || topic.topic_id !== row.topic_id) {
      topic = { topic_id: row.topic_id, label: row.label, instruments: [] };
      topics.push(topic);
    }
    topic.instruments.push({ instrument_id: row.instrument_id, symbol: row.symbol });
  }
  return topics;
}

export async function runTopicScan(
  user: UserRow,
  ai: AiClient,
  notifier: Notifier,
  runId: string | null,
  requestId?: string,
): Promise<TopicScanResult | null> {
  const topics = groupTopics(await listActiveTopicInstruments(user.id));
  // Null rather than an empty result: "no topics to scan" is a skipped run,
  // and the caller records it as one.
  if (topics.length === 0) return null;

  const knownKeys = await listRecentDedupeKeys(user.id);
  const response = await ai.topicScan(
    { user_id: user.id, topics, known_dedupe_keys: knownKeys },
    requestId,
  );

  const toStore: ObservationToStore[] = response.observations.map((observation) => ({
    userId: user.id,
    runId,
    kind: observation.kind,
    severity: observation.severity,
    subjectKind: 'topic',
    subjectRef: observation.subject_ref,
    headline: observation.headline,
    explanation: observation.explanation,
    evidence: observation.evidence ?? {},
    conceptRefs: observation.concept_refs ?? [],
    dedupeKey: observation.dedupe_key,
    narrationSource: observation.narration_source ?? null,
    fallbackReason: observation.fallback_reason ?? null,
    localized: observation.localized ?? {},
  }));
  const { created, suppressed, inserted } = await insertObservations(toStore);

  // Only what this scan created is announced, for the reason portfolioScan.ts
  // gives: a repeat has already been said, and saying it again is how a
  // channel gets muted.
  const settings = await getOrCreateUserSettings(user.id);
  const notifiable: NotifiableFinding[] = inserted.map((observation) => ({
    refKind: 'observation' as const,
    refId: observation.id,
    severity: observation.severity,
    headline: observation.headline,
    explanation: observation.explanation,
    localized: observation.localized,
  }));
  const notified = await fanOut(
    user.id,
    notifiable,
    settingsForNotification(settings, user.timezone),
    notifier,
  );

  // Only a scan that stored a newly narrated observation has anything to say
  // about narration. Most scans store nothing new and skip this entirely.
  const narration: NarrationWatchOutcome =
    created > 0 && toStore.some((observation) => observation.narrationSource !== null)
      ? await watchNarration(
          user.id,
          ai,
          notifier,
          settingsForNotification(settings, user.timezone),
          runId,
          requestId,
        )
      : 'not_measured';

  const skipped = response.stats.skipped ?? {};
  const result: TopicScanResult = {
    topics: response.stats.topics,
    measured: response.stats.topics_measured,
    instruments: response.stats.instruments,
    findings: response.stats.findings,
    created,
    alreadyKnown: response.stats.already_known,
    suppressed,
    narratedByLlm: response.stats.narrated_by_llm,
    narrationFallbacks: response.stats.narration_fallbacks ?? {},
    skipped,
    // A topic that could not be measured is a topic the user was told nothing
    // about, and "nothing moved" must not be how that reads in GET /runs.
    degraded: Object.keys(skipped).length > 0,
    notified: {
      pushed: notified.pushed,
      deferred: notified.deferred,
      duplicate: notified.duplicate,
      failed: notified.failed,
    },
    narration,
  };

  logger().info({ userId: user.id, ...result }, 'topic scan complete');
  return result;
}

/**
 * Fetch history for a just-confirmed topic's instruments, without waiting.
 *
 * The daily backfill run would reach them, but only in tomorrow's bucket - so a
 * topic confirmed at ten in the morning would be skipped by every scan until the
 * next day, for no reason the user could see. Backfill is idempotent, so doing
 * it now costs nothing when tomorrow's run repeats it. A failure is logged and
 * left to that run: the confirm has already succeeded and must not be undone by
 * a price provider.
 */
export function backfillConfirmedInstruments(
  ai: AiClient,
  instruments: BackfillRequest['instruments'],
  requestId?: string,
): void {
  if (instruments.length === 0) return;
  // Started inside a promise so that even a synchronous throw lands in the
  // catch, rather than failing a confirm that has already been written.
  Promise.resolve()
    .then(() => ai.backfillHistory({ instruments, days: HISTORY_BACKFILL_DAYS }, requestId))
    .catch((error) =>
      logger().warn({ err: error, count: instruments.length }, 'topic history backfill failed'),
    );
}
