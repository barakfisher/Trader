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
  observations: ['observations'] as const,
};
