/**
 * The email rule, shared by the admin's bootstrap script, the change-email
 * route and the Settings form, so all three refuse the same addresses. Enough
 * to catch a pasted name or a missing `@`: nothing is ever sent to the address
 * (no outbound email before M10), so nothing stronger can be checked.
 */

export const EMAIL_MAX_LENGTH = 320;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;

export type EmailProblem = 'invalid' | 'too_long';

/** An address as stored: trimmed and lower-cased. Sign-in compares case-insensitively anyway. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Why a (normalised) address is refused, or null. */
export function emailProblem(email: string): EmailProblem | null {
  if (email.length > EMAIL_MAX_LENGTH) return 'too_long';
  if (!EMAIL_SHAPE.test(email)) return 'invalid';
  return null;
}
