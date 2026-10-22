import { describe, expect, it } from 'vitest';

import { DEFAULT_TRUSTED_PROXY_HOPS } from '../src/config.js';
import { clientAddress } from '../src/http/clientAddress.js';

describe('the client address behind trusted proxies (D256)', () => {
  it('behind nginx alone is the entry nginx appended, not one the client wrote', () => {
    expect(clientAddress('6.6.6.6, 10.0.0.7', '172.18.0.4', 1)).toBe('10.0.0.7');
    expect(clientAddress('10.0.0.7', '172.18.0.4', 1)).toBe('10.0.0.7');
  });

  it('does not move when the socket is unknown, so a forged entry never takes its place', () => {
    expect(clientAddress('6.6.6.6, 10.0.0.7', null, 1)).toBe('10.0.0.7');
  });

  it('behind a load balancer and nginx is the entry the load balancer appended', () => {
    // client 203.0.113.9 -> load balancer (appends it) -> nginx (appends the balancer, 10.0.0.2)
    expect(clientAddress('6.6.6.6, 203.0.113.9, 10.0.0.2', '172.18.0.4', 2)).toBe('203.0.113.9');
  });

  it('with no proxy trusted is the socket peer, whatever the header claims', () => {
    expect(clientAddress('6.6.6.6', '::1', 0)).toBe('::1');
  });

  it('is the oldest entry, or the socket, for a request that skipped the outer proxies', () => {
    expect(clientAddress('10.0.0.7', '172.18.0.4', 2)).toBe('10.0.0.7');
    expect(clientAddress(undefined, '::1', DEFAULT_TRUSTED_PROXY_HOPS)).toBe('::1');
  });

  it('is null rather than anything that is not an address', () => {
    expect(clientAddress('unknown', null, DEFAULT_TRUSTED_PROXY_HOPS)).toBeNull();
    expect(clientAddress(undefined, null, DEFAULT_TRUSTED_PROXY_HOPS)).toBeNull();
  });
});
