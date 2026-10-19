import { query, queryOne } from '../pool.js';

/**
 * The installation's own settings (migration 0047): one row, written by the
 * migration, so a read always finds it. Changed only from the Admin page, whose
 * gate has written the `admin_audit` row before this runs (decision 84).
 */
export interface InstallationSettingsRow {
  max_agents_per_user: number;
  /** Migration 0052. A bigint, read as a number: its CHECK keeps it under 1e8. */
  assistant_daily_budget_micro_usd: number;
  /** Migration 0058: the cap an approval offers (D157). Under 1e9 by its CHECK. */
  default_llm_cap_micro_usd: number;
  /** Migration 0058: waiting sign-up requests allowed at once (D156); 0 closes sign-up. */
  max_pending_signups: number;
  updated_at: Date;
}

export async function getInstallationSettings(): Promise<InstallationSettingsRow> {
  const row = await queryOne<InstallationSettingsRow>(
    `SELECT max_agents_per_user, assistant_daily_budget_micro_usd::int AS assistant_daily_budget_micro_usd,
            default_llm_cap_micro_usd::int AS default_llm_cap_micro_usd, max_pending_signups,
            updated_at
       FROM installation_settings`,
  );
  if (row === null) throw new Error('installation_settings has no row: is the schema at 0047?');
  return row;
}

export async function setMaxAgentsPerUser(max: number, adminUserId: string): Promise<void> {
  await query(
    `UPDATE installation_settings SET max_agents_per_user = $1, updated_by = $2, updated_at = now()`,
    [max, adminUserId],
  );
}

/** What one user's questions to the assistant may spend a day (migration 0052). */
export async function setAssistantDailyBudget(microUsd: number, adminUserId: string): Promise<void> {
  await query(
    `UPDATE installation_settings
        SET assistant_daily_budget_micro_usd = $1, updated_by = $2, updated_at = now()`,
    [microUsd, adminUserId],
  );
}

/** The monthly cap an approval offers (D157); approvals already made keep theirs. */
export async function setDefaultLlmCap(microUsd: number, adminUserId: string): Promise<void> {
  await query(
    `UPDATE installation_settings
        SET default_llm_cap_micro_usd = $1, updated_by = $2, updated_at = now()`,
    [microUsd, adminUserId],
  );
}

/** How many sign-up requests may wait at once (D156); a lower limit removes none. */
export async function setMaxPendingSignups(max: number, adminUserId: string): Promise<void> {
  await query(
    `UPDATE installation_settings SET max_pending_signups = $1, updated_by = $2, updated_at = now()`,
    [max, adminUserId],
  );
}
