/**
 * Who is on the other end of a request, as far as the proxies in front of this
 * process can be trusted to say (D256).
 *
 * Every proxy *appends* the address it saw to `X-Forwarded-For`, after whatever
 * arrived with the request. With N proxies, the outermost appends the client,
 * each next one the proxy before it, and the nearest is the socket's peer, so
 * the header reads `<claims anyone can forge>, <client>, <proxy 1>, ...,
 * <proxy N-1>` and the client is its N-th entry from the end. Only entries our
 * own proxies wrote are facts.
 *
 * N is the deployment's to state (`TRUSTED_PROXY_HOPS`): one for nginx alone,
 * which is what kind puts in front of the orchestrator; more behind a host's
 * load balancer. Too low and every request looks like it comes from a proxy -
 * one rate-limit bucket for everyone; too high and the client chooses its own
 * address by sending a header.
 */

import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { isIP } from 'node:net';

export function clientAddress(
  forwardedFor: string | undefined,
  socketAddress: string | null,
  trustedProxyHops: number,
): string | null {
  const forwarded = (forwardedFor ?? '')
    .split(',')
    .map((hop) => hop.trim())
    .filter(Boolean);
  // Proxy k of N appends what it saw, so the outermost one wrote the N-th entry
  // from the end; the nearest proxy is the socket and wrote nothing about
  // itself. Counted in the header alone, so a missing socket cannot shift it.
  // Fewer entries than proxies means the request skipped the outer ones (a call
  // from inside the network): the oldest entry, or the socket, is all there is.
  const index = forwarded.length - trustedProxyHops;
  const client =
    trustedProxyHops === 0 ? socketAddress : index >= 0 ? forwarded[index] : (forwarded[0] ?? socketAddress);
  // Anything that is not an address is dropped rather than returned: callers
  // store it in `inet` columns and key limits on it.
  return client && isIP(client) !== 0 ? client : null;
}

export function socketAddress(context: Context): string | null {
  try {
    return getConnInfo(context).remote.address ?? null;
  } catch {
    // No socket behind the request - a test calling `app.request` directly.
    return null;
  }
}

/** The client address of a request handled by the app, with the configured count. */
export function requestClientAddress(context: Context, trustedProxyHops: number): string | null {
  return clientAddress(context.req.header('x-forwarded-for'), socketAddress(context), trustedProxyHops);
}
