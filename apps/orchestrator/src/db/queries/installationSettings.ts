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
  updated_at: Date;
}

export async function getInstallationSettings(): Promise<InstallationSettingsRow> {
  const row = await queryOne<InstallationSettingsRow>(
    `SELECT max_agents_per_user, assistant_daily_budget_micro_usd::int AS assistant_daily_budget_micro_usd,
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
