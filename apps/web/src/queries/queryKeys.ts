/**
 * Every query key in the app, in one place.
 *
 * A key is the address of a cached response, and invalidation matches on it.
 * A write that invalidates `['portfolio']` while the read was cached under
 * `['portfolios']` refreshes nothing and reports nothing, so keys are named
 * once here and imported everywhere else.
 */

export const queryKeys = {
  portfolio: ['portfolio'] as const,
  snapshots: ['portfolio', 'snapshots'] as const,
  observations: ['observations'] as const,
  proposals: ['proposals'] as const,
  narration: ['narration'] as const,
  telegramBinding: ['telegram', 'binding'] as const,
  settings: ['settings'] as const,
  targets: ['targets'] as const,
  /** The list, and - under it, so invalidating the list prefix reaches them - each topic. */
  topics: ['topics'] as const,
  topic: (topicId: string) => ['topics', topicId] as const,
  topicNews: (topicId: string) => ['topics', topicId, 'news'] as const,
  topicSentiment: (topicId: string) => ['topics', topicId, 'sentiment'] as const,
  concept: (slug: string) => ['concepts', slug] as const,
};
