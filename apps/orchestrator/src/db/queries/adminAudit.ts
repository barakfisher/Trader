import { query } from '../pool.js';

export interface AdminAuditInput {
  adminUserId: string;
  action: string;
  detail: unknown;
  ipAddress: string | null;
  requestId: string;
}

/**
 * Append one admin action to `admin_audit`. There is no update or delete to go
 * with it: Postgres refuses both, for this role too (migration 0026).
 */
export async function insertAdminAudit(input: AdminAuditInput): Promise<void> {
  await query(
    `INSERT INTO admin_audit (admin_user_id, action, detail, ip_address, request_id)
     VALUES ($1, $2, $3::jsonb, $4::inet, $5)`,
    [input.adminUserId, input.action, JSON.stringify(input.detail), input.ipAddress, input.requestId],
  );
}

export interface AdminAuditRow {
  id: string;
  admin_user_id: string;
  action: string;
  detail: unknown;
  ip_address: string | null;
  request_id: string | null;
  occurred_at: Date;
}

export function listAdminAudit(limit = 100): Promise<AdminAuditRow[]> {
  return query<AdminAuditRow>(
    `SELECT id::text, admin_user_id, action, detail, host(ip_address) AS ip_address,
            request_id, occurred_at
       FROM admin_audit
      ORDER BY occurred_at DESC, id DESC
      LIMIT $1`,
    [limit],
  );
}
