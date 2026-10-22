/**
 * What an admin action's audit row says (decision 84).
 *
 * The row is written by the admin gate in `app.ts` *before* the handler runs,
 * so everything here is what the request asked for, not what came of it: the
 * outcome of an action lives where the action lives (a rescreen's in `runs`).
 * Written first because the alternative - writing after - leaves a window in
 * which an action has happened and its audit write can still fail, and an
 * unaudited admin action is the one thing this table exists to rule out.
 */

import type { Context } from 'hono';

import type { AppEnv } from './app.js';
import { requestClientAddress } from './clientAddress.js';

/** Bodies larger than this are recorded as their size, not their content. */
export const MAX_AUDITED_BODY_BYTES = 4096;

export interface AuditEntry {
  action: string;
  ipAddress: string | null;
  detail: {
    query: Record<string, string>;
    body: unknown;
    /** The whole `X-Forwarded-For` chain, as the client and the proxies claimed it. */
    forwardedFor: string | null;
  };
}

/**
 * The body as JSON when it is small JSON; otherwise a description of it.
 *
 * Read through Hono's request, which keeps the body, so the handler that runs
 * next can still read it.
 */
async function auditedBody(context: Context): Promise<unknown> {
  const raw = await context.req.text();
  if (raw.length === 0) return null;
  if (Buffer.byteLength(raw) > MAX_AUDITED_BODY_BYTES) {
    return { omitted: 'too large', bytes: Buffer.byteLength(raw) };
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { omitted: 'not JSON', bytes: Buffer.byteLength(raw) };
  }
}

export async function auditEntry(context: Context<AppEnv>): Promise<AuditEntry> {
  const forwardedFor = context.req.header('x-forwarded-for');
  return {
    action: `${context.req.method} ${context.req.path}`,
    ipAddress: requestClientAddress(context, context.get('config').TRUSTED_PROXY_HOPS),
    detail: {
      query: context.req.query(),
      body: await auditedBody(context),
      forwardedFor: forwardedFor ?? null,
    },
  };
}
