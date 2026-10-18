/**
 * Whether an agent has anything to decide by (D174): its instructions, its
 * mandate, or both. One with neither never scans and is never billed (D52).
 *
 * Asked by the schedule, by "Run a scan now" and by the agent's view, which
 * must agree; the AI service asks the same of `Mandate.is_set`, and
 * `test_agent_readiness_contract.py` holds the two lists of columns equal.
 */

// The column list is a constant, not SQL: imported from its module so that a test
// mocking `queries.js` still gets the real list.
import { MANDATE_COLUMNS, type MandateColumns } from '../db/queries/agents.js';

/** Any setting other than no-limit. */
export function hasMandate(row: MandateColumns): boolean {
  return MANDATE_COLUMNS.some((column) => {
    const value = row[column];
    if (column === 'allow_etfs') return value === false;
    // `!= null`: a row read before 0057's columns existed has none of them.
    return Array.isArray(value) ? value.length > 0 : value != null;
  });
}

export function readyToScan(row: MandateColumns & { persona: string | null }): boolean {
  return Boolean(row.persona?.trim()) || hasMandate(row);
}
