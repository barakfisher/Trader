/**
 * What one scan of an agent is expected to cost (D46), shown before it is run:
 * on the agent page and in Telegram's Run confirm (M11 A2).
 */

import type { ScanCostEstimate } from '@traders/shared';

import type { AgentRow } from '../db/queries.js';

/** One scan's cost as measured on 2026-10-07 (§14.3): the estimate before any scan exists (D46). */
export const MEASURED_SCAN_COST_MICRO_USD = 36_000;

/** D46: this agent's recent average, else the installation's, else what was measured. */
export function scanCostOf(row: AgentRow): ScanCostEstimate {
  if (row.agent_scan_cost_micro_usd !== null) {
    return { microUsd: Number(row.agent_scan_cost_micro_usd), basis: 'agent' };
  }
  if (row.installation_scan_cost_micro_usd !== null) {
    return { microUsd: Number(row.installation_scan_cost_micro_usd), basis: 'installation' };
  }
  return { microUsd: MEASURED_SCAN_COST_MICRO_USD, basis: 'measured' };
}
