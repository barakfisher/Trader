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
import { getConnInfo } from '@hono/node-server/conninfo';
import { isIP } from 'node:net';

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
 * The address of whoever connected to the nearest proxy.
 *
 * nginx *appends* the address it saw to `X-Forwarded-For`, after whatever the
 * client sent, so only the last entry is a fact; everything before it is a
 * claim anyone can forge. Behind Traefik (kind) that last entry is Traefik's
 * own pod, which is honest if unhelpful - the chain is kept in `detail` for
 * the reader who trusts the claims. With no proxy in front, the socket's peer.
 */
export function clientAddress(forwardedFor: string | undefined, socketAddress: string | null): string | null {
  const hops = (forwardedFor ?? '')
    .split(',')
    .map((hop) => hop.trim())
    .filter(Boolean);
  const nearest = hops.at(-1) ?? socketAddress;
  // Anything that is not an address is dropped rather than stored: the column
  // is `inet`, and a value it rejects would fail the audit write and with it
  // the action.
  return nearest && isIP(nearest) !== 0 ? nearest : null;
}

function socketAddress(context: Context): string | null {
  try {
    return getConnInfo(context).remote.address ?? null;
  } catch {
    // No socket behind the request - a test calling `app.request` directly.
    return null;
  }
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

export async function auditEntry(context: Context): Promise<AuditEntry> {
  const forwardedFor = context.req.header('x-forwarded-for');
  return {
    action: `${context.req.method} ${context.req.path}`,
    ipAddress: clientAddress(forwardedFor, socketAddress(context)),
    detail: {
      query: context.req.query(),
      body: await auditedBody(context),
      forwardedFor: forwardedFor ?? null,
    },
  };
}
