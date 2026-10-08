import { query, queryOne } from '../pool.js';

/**
 * The installation's own settings (migration 0046): one row, written by the
 * migration, so a read always finds it. Changed only from the Admin page, whose
 * gate has written the `admin_audit` row before this runs (decision 84).
 */
export interface InstallationSettingsRow {
  max_agents_per_user: number;
  updated_at: Date;
}

export async function getInstallationSettings(): Promise<InstallationSettingsRow> {
  const row = await queryOne<InstallationSettingsRow>(
    `SELECT max_agents_per_user, updated_at FROM installation_settings`,
  );
  if (row === null) throw new Error('installation_settings has no row: is the schema at 0046?');
  return row;
}

export async function setMaxAgentsPerUser(max: number, adminUserId: string): Promise<void> {
  await query(
    `UPDATE installation_settings SET max_agents_per_user = $1, updated_by = $2, updated_at = now()`,
    [max, adminUserId],
  );
}
