/**
 * The email rule, shared by the admin's bootstrap script, sign-up, the
 * change-email route and the Settings form, so all of them refuse the same
 * addresses.
 *
 * Mail is sent to these addresses (D258), and a mail library reads a `to`
 * string as an address *list*: `a@x.com,b@y.com`, `Name <a@x.com>` and quoted
 * forms each name someone other than the address that was checked. So the
 * shape is one plain address only - the RFC 5322 "atext" characters in the
 * local part, without leading, trailing or doubled dots, and a dotted domain
 * of letters, digits and hyphens. Commas, angle brackets, quotes, colons,
 * semicolons and spaces are refused. Whether the mailbox exists is the
 * verification link's job, not this rule's.
 */

export const EMAIL_MAX_LENGTH = 320;

const LOCAL_PART = "[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*";
const DOMAIN_LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const EMAIL_SHAPE = new RegExp(`^${LOCAL_PART}@${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})+$`, 'i');

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
