/**
 * Passwords: argon2id hashing (D159), and the length rule (D181) re-exported
 * from `@traders/shared`, where the web form reads it too.
 *
 * The hashing is `@node-rs/argon2`'s, at its defaults - argon2id, 19 MiB, two
 * passes, one lane: OWASP's minimum for argon2id. The PHC string it returns
 * carries its own parameters and salt, so raising them later only changes new
 * hashes; old ones still verify.
 */

import { hash, verify } from '@node-rs/argon2';

export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordProblem } from '@traders/shared';

export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

/**
 * Hashed once, lazily, and verified against when the email matches nobody, so
 * an unknown address costs the same argon2 work as a wrong password and the
 * response time does not say which accounts exist.
 */
let decoyHash: Promise<string> | null = null;

/**
 * Whether `password` matches `passwordHash`. A missing hash - a user who has
 * never been given a password - is a mismatch after the same work.
 */
export async function passwordMatches(password: string, passwordHash: string | null): Promise<boolean> {
  if (passwordHash === null) {
    decoyHash ??= hash('decoy password that matches nothing');
    await verify(await decoyHash, password);
    return false;
  }
  try {
    return await verify(passwordHash, password);
  } catch {
    // A malformed stored hash is a mismatch, never a crash on the login route.
    return false;
  }
}
