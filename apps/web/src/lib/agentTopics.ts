/**
 * An agent's topics as the forms hold them (D412-D414): one per line, as typed.
 * The server trims, drops a repeat in another case and refuses more than
 * `MAX_TOPICS`; the form says so before it sends.
 */

import { MAX_TOPIC_LENGTH, MAX_TOPICS } from '@traders/shared';

/** The topics in typed text: trimmed, blank lines and repeats (in any case) dropped. */
export function parseTopics(text: string): string[] {
  const seen = new Set<string>();
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((topic) => {
      const key = topic.toLowerCase();
      if (topic === '' || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function topicsValid(text: string): boolean {
  const topics = parseTopics(text);
  return topics.length <= MAX_TOPICS && topics.every((topic) => topic.length <= MAX_TOPIC_LENGTH);
}

/** Stored topics as the form shows them; the primary's null is none. */
export function topicsText(topics: string[] | null): string {
  return (topics ?? []).join('\n');
}
