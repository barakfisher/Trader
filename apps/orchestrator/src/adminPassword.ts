/**
 * Gives the installation's admin an email and a password (D179).
 *
 *   pnpm --silent admin:password --status
 *   printf '%s' "$password" | pnpm --silent admin:password --email you@example.com
 *
 * The password is read from stdin, never from an argument, which would land in
 * shell history and `ps`. Re-running sets the email and a fresh hash and ends
 * every session the admin holds, so it is also the "I lost my password" path.
 * `scripts/admin-password.sh` runs it where the database is - the compose
 * container, the cluster's pod or this machine - and generates a password
 * when none is piped in.
 *
 * Reads `DATABASE_URL` alone rather than the service's whole configuration, so
 * it runs anywhere the database can be reached.
 */

import { parseArgs } from 'node:util';

import { closePool, initPool } from './db/pool.js';
import { adminPasswordState, setAdminCredentials } from './db/queries.js';
import { emailProblem, normaliseEmail } from '@traders/shared';

import { hashPassword, passwordProblem } from './http/password.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  // One trailing newline is the shell's, not the password's.
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

function fail(message: string): never {
  process.stderr.write(`admin:password: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { email: { type: 'string' }, status: { type: 'boolean', default: false } },
  });
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) fail('DATABASE_URL is not set');

  initPool(databaseUrl);
  try {
    const state = await adminPasswordState();
    if (state.admins !== 1) fail(`expected one admin, found ${state.admins} (D155)`);

    if (values.status) {
      process.stdout.write(state.withPassword === 1 ? 'set\n' : 'unset\n');
      return;
    }

    const email = normaliseEmail(values.email ?? '');
    if (emailProblem(email) !== null) {
      fail('pass the admin\'s address as --email you@example.com');
    }
    if (process.stdin.isTTY) fail('pipe the password on stdin; scripts/admin-password.sh can generate one');
    const password = await readStdin();
    const problem = passwordProblem(password);
    if (problem !== null) fail(`the password is ${problem.replace('_', ' ')}`);

    const admin = await setAdminCredentials(email, await hashPassword(password));
    if (!admin) fail('no admin to update');
    process.stdout.write(`admin ${admin.id} signs in as ${email}\n`);
  } finally {
    await closePool();
  }
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
