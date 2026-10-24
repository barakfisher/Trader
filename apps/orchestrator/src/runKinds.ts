/**
 * Whose work each scheduled run kind is (D161, D238) - read by the route that
 * runs it, the local timer and the CronJob contract, so the three cannot
 * disagree about which kinds fan out to users.
 */

import { RESCREEN_KIND } from './services/universeRescreen.js';

/**
 * The fan-out a trigger asks for (D161): every per-user kind is run once for
 * each active user. A trigger names no user any more - the installation has
 * none to fall back to.
 */
export const EVERY_ACTIVE_USER = 'every_active_user';

/**
 * The installation's own work (D161, D238): done once a bucket for everybody,
 * under no user, and never through a user's model key - none of them calls a
 * model. Backfill and news read the union of the active users' instruments;
 * the agent-scan plan takes every active user's due slots in turn.
 */
export const INSTALLATION_KINDS: ReadonlySet<string> = new Set([
  'backfill',
  'news_collect',
  'instrument_metadata',
  'proposal_sweep',
  // Deletes expired sessions, whoever's (D261).
  'session_sweep',
  'agent_scans',
  RESCREEN_KIND,
]);

/** A user's work: one run per active user, each under its own run key. */
export const USER_KINDS: ReadonlySet<string> = new Set([
  'snapshot',
  'portfolio_scan',
  'topic_scan',
  'topic_discovery',
  'daily_digest',
]);

