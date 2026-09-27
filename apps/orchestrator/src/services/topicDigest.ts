/**
 * The daily digest's topic section (PRD FR-13: "topic movements").
 *
 * One entry per active topic: what moved in the last day, whether the topic was
 * measured at all, and a line of news with its tone. Gathering (`gatherTopicDigest`,
 * which reads) is kept apart from rendering (`renderTopicSection`, which is pure),
 * so the wording is testable without a database.
 *
 * **Figures come from where they were already checked.** A topic move is quoted
 * by its stored headline, which the evidence validator (or the template) wrote
 * from the finding's evidence; this module never re-renders a percentage, for
 * the reason `sendDigest` gives. The only figures it formats itself are an
 * article count and the tone, both computed deterministically by
 * `summariseTopicSentiment` - arithmetic, not narration.
 *
 * **Three states that must not look alike**, as everywhere else in this project:
 * a topic that was measured and did nothing unusual, a topic the scan could not
 * measure (its reason, from the last topic scan's `stats.skipped`), and a topic
 * confirmed after the last scan ran. "No unusual move" is only ever said of the
 * first.
 *
 * **When the section is worth sending.** Only when some topic moved or had news
 * in the last day. A daily message saying every topic was quiet is how a channel
 * gets muted, and the digest's existing rule - no message on a quiet day - is
 * kept rather than broken for the sake of a section.
 */

import type { TopicSentimentResponse } from '@traders/shared';

import {
  getLatestFinishedRun,
  listRecentTopicObservations,
  listTopicSentimentRows,
  listTopics,
  type UserRow,
} from '../db/queries.js';
import { localDate } from './snapshot.js';
import { summariseTopicSentiment } from './topicSentiment.js';

/** How far back "moved" reaches: one digest's worth. */
export const TOPIC_DIGEST_HOURS = 24;

/** The window the news line summarises. Same default as GET /topics/:id/sentiment. */
export const TOPIC_DIGEST_NEWS_DAYS = 7;

export type TopicMeasurement =
  | { state: 'measured' }
  | { state: 'skipped'; reason: string }
  | { state: 'not_scanned' };

export interface TopicDigestEntry {
  label: string;
  /** Stored headlines of this topic's observations from the last day, most severe first. */
  moves: string[];
  measurement: TopicMeasurement;
  sentiment: TopicSentimentResponse;
  /** Articles dated today in the user's timezone. */
  articlesToday: number;
}

export async function gatherTopicDigest(user: UserRow, now = new Date()): Promise<TopicDigestEntry[]> {
  const topics = (await listTopics(user.id)).filter((topic) => topic.status === 'active');
  if (topics.length === 0) return [];

  const [observations, lastScan] = await Promise.all([
    listRecentTopicObservations(user.id, TOPIC_DIGEST_HOURS),
    getLatestFinishedRun(user.id, 'topic_scan'),
  ]);
  const skipped = skippedByLabel(lastScan?.stats);
  const today = localDate(user.timezone, now);

  const entries: TopicDigestEntry[] = [];
  for (const topic of topics) {
    const rows = await listTopicSentimentRows(
      user.id,
      topic.id,
      TOPIC_DIGEST_NEWS_DAYS,
      user.timezone,
    );
    const confirmedAt = topic.confirmed_at ?? topic.updated_at;
    const measurement: TopicMeasurement =
      lastScan === null || new Date(confirmedAt) > new Date(lastScan.started_at)
        ? { state: 'not_scanned' }
        : skipped[topic.label] !== undefined
          ? { state: 'skipped', reason: skipped[topic.label]! }
          : { state: 'measured' };
    entries.push({
      label: topic.label,
      moves: observations
        .filter((row) => row.subject_ref === `topic:${topic.id}`)
        .map((row) => row.headline),
      measurement,
      sentiment: summariseTopicSentiment(topic.id, TOPIC_DIGEST_NEWS_DAYS, rows),
      articlesToday: new Set(rows.filter((row) => row.local_day === today).map((row) => row.id))
        .size,
    });
  }
  return entries;
}

function skippedByLabel(stats: unknown): Record<string, string> {
  if (stats === null || typeof stats !== 'object') return {};
  const skipped = (stats as { skipped?: unknown }).skipped;
  if (skipped === null || typeof skipped !== 'object') return {};
  return Object.fromEntries(
    Object.entries(skipped).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

/** Whether today gave the topics anything to report. */
export function topicsHaveNews(entries: TopicDigestEntry[]): boolean {
  return entries.some((entry) => entry.moves.length > 0 || entry.articlesToday > 0);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** "+0.14" from "0.1351": the tone, rounded once, for a sentence. */
function tone(score: string): string {
  const value = Number(score);
  const rounded = (Math.round(value * 100) / 100 + 0).toFixed(2);
  return value > 0 && rounded !== '0.00' ? `+${rounded}` : rounded;
}

function newsLine(sentiment: TopicSentimentResponse, days: number): string {
  const prefix = `News, last ${days} days:`;
  const articles = sentiment.counts.articles;
  switch (sentiment.gap) {
    case 'no_articles':
      return `${prefix} none collected`;
    case 'not_scored':
      return `${prefix} ${plural(articles, 'article')}, none scored for tone`;
    case 'too_few_polarised':
      return `${prefix} ${plural(articles, 'article')}, too few with a clear tone to score`;
    default:
      return `${prefix} ${plural(articles, 'article')}, tone ${tone(sentiment.score!)} (${sentiment.model})`;
  }
}

/**
 * The section as plain text, or null when no topic has anything to report today.
 * Every active topic gets a line once the section exists, so a topic that could
 * not be measured is said to be unmeasured rather than left out.
 */
export function renderTopicSection(entries: TopicDigestEntry[]): string | null {
  if (!topicsHaveNews(entries)) return null;
  const lines = ['Topics'];
  for (const entry of entries) {
    if (entry.moves.length > 0) {
      for (const move of entry.moves) lines.push(`• ${move}`);
    } else if (entry.measurement.state === 'measured') {
      lines.push(`• ${entry.label}: no unusual move in the last day`);
    } else if (entry.measurement.state === 'skipped') {
      lines.push(`• ${entry.label}: not measured (${entry.measurement.reason})`);
    } else {
      lines.push(`• ${entry.label}: not scanned yet`);
    }
    lines.push(`  ${newsLine(entry.sentiment, entry.sentiment.days)}`);
  }
  return lines.join('\n');
}
