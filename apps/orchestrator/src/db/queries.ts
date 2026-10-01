/**
 * Every SQL statement in the orchestrator, by concept, under `queries/`.
 *
 * Keeping SQL out of the HTTP layer and in one directory keeps the data
 * access surface auditable (CLAUDE.md). This index re-exports every module,
 * so callers - and the tests that mock this path - import one place.
 * Split from one 2,500-line file (independent task 15): every parallel PR
 * appended to its end and every rebase met there.
 */

export type { TopicEvidence } from '@traders/shared';
export { transaction } from './pool.js';

export * from './queries/users.js';
export * from './queries/instruments.js';
export * from './queries/holdings.js';
export * from './queries/targetWeights.js';
export * from './queries/quotes.js';
export * from './queries/snapshots.js';
export * from './queries/runs.js';
export * from './queries/adminAudit.js';
export * from './queries/opsEvents.js';
export * from './queries/universe.js';
export * from './queries/llmCalls.js';
export * from './queries/observations.js';
export * from './queries/narration.js';
export * from './queries/proposals.js';
export * from './queries/proposalEpisodes.js';
export * from './queries/userSettings.js';
export * from './queries/notifications.js';
export * from './queries/telegram.js';
export * from './queries/topics.js';
export * from './queries/articles.js';
export * from './queries/topicProposals.js';
