/**
 * The password rule (D181), shared so the server's refusal and the web form's
 * hint can never disagree: 12 to 128 characters, no composition rules. Length
 * is what resists guessing; rules about digits and symbols push people to
 * `Password1!`. The ceiling bounds argon2's input, not security.
 */

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export type PasswordProblem = 'too_short' | 'too_long';

/** Why a password is refused, or null. Counts characters, not UTF-16 code units. */
export function passwordProblem(password: string): PasswordProblem | null {
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) return 'too_short';
  if (length > PASSWORD_MAX_LENGTH) return 'too_long';
  return null;
}
