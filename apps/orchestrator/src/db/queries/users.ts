import { queryOne } from '../pool.js';

export type UserRole = 'user' | 'admin';

export interface UserRow {
  id: string;
  email: string | null;
  base_currency: string;
  timezone: string;
  role: UserRole;
}

export function getUser(userId: string): Promise<UserRow | null> {
  return queryOne<UserRow>(
    'SELECT id, email, base_currency, timezone, role FROM users WHERE id = $1',
    [userId],
  );
}
