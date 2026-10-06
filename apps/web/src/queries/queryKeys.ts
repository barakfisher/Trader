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
  /** Under the portfolio, so a holding's edit refreshes it; agent writes invalidate it too. */
  consolidated: ['portfolio', 'consolidated'] as const,
  observations: ['observations'] as const,
  /** The dashboard's feed, per filter. Under `observations`, so a refresh of the feed reaches it. */
  feed: (severity: string | null, symbol: string | null) =>
    ['observations', 'feed', { severity, symbol }] as const,
  /** Under the feed, so anything that invalidates the feed refreshes a holding's findings too. */
  symbolObservations: (symbol: string) => ['observations', 'symbol', symbol] as const,
  proposals: ['proposals'] as const,
  /** Under the inbox's key, so a decision's invalidation of `['proposals']` refreshes both. */
  proposalHistory: ['proposals', 'history'] as const,
  proposal: (proposalId: string) => ['proposals', 'detail', proposalId] as const,
  narration: ['narration'] as const,
  digest: ['notifications', 'digest'] as const,
  telegramBinding: ['telegram', 'binding'] as const,
  settings: ['settings'] as const,
  targets: ['targets'] as const,
  /** The list, and - under it, so a write that invalidates the list reaches them - each agent. */
  agents: ['agents'] as const,
  agent: (agentId: string) => ['agents', agentId] as const,
  /** Under the agent, so a trade's or a top-up's invalidation of `['agents']` refreshes them. */
  agentAccount: (agentId: string) => ['agents', agentId, 'account'] as const,
  agentActivity: (agentId: string) => ['agents', agentId, 'activity'] as const,
  agentPerformance: (agentId: string) => ['agents', agentId, 'performance'] as const,
  /** The list, and - under it, so invalidating the list prefix reaches them - each topic. */
  topics: ['topics'] as const,
  topic: (topicId: string) => ['topics', topicId] as const,
  topicNews: (topicId: string) => ['topics', topicId, 'news'] as const,
  topicSentiment: (topicId: string) => ['topics', topicId, 'sentiment'] as const,
  concept: (slug: string) => ['concepts', slug] as const,
  holdingHistory: (holdingId: string) => ['holdings', holdingId, 'history'] as const,
  holdingNews: (holdingId: string) => ['holdings', holdingId, 'news'] as const,
  adminRuns: ['admin', 'runs'] as const,
  adminAudit: ['admin', 'audit'] as const,
  adminGaps: ['admin', 'gaps'] as const,
  adminUniverse: ['admin', 'universe'] as const,
  adminLlm: (days: number) => ['admin', 'llm', days] as const,
  adminLlmModels: ['admin', 'llm-models'] as const,
};
