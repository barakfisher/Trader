/**
 * What the Google provider accepts from an ID token (D262, D315): Google's
 * issuer, our client as the audience, and whether Google is the authority for
 * the address. arctic's network calls are replaced; its decoding is real.
 */

import { describe, expect, it, vi } from 'vitest';

let idToken = '';
vi.mock('arctic', async () => {
  const actual = await vi.importActual<typeof import('arctic')>('arctic');
  class Google {
    validateAuthorizationCode = async () => ({ idToken: () => idToken });
    createAuthorizationURL = () => new URL('https://accounts.google.com/o/oauth2/v2/auth');
  }
  return { ...actual, Google };
});

const { buildOAuthProviders } = await import('../src/oauth/providers.js');

const CLIENT_ID = 'the-client-id';
const google = buildOAuthProviders({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: 'secret' } as never).get('google')!;

/** An unsigned JWT: the provider decodes it without a signature, as OIDC allows from the token endpoint. */
function token(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part(claims)}.signature`;
}

const BASE = { iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'sub-1', email_verified: true };
const identify = () => google.identify({ code: 'c', codeVerifier: 'v', redirectUri: 'http://localhost/cb' });

describe('the Google provider', () => {
  it('is the authority for a gmail.com address and for a Workspace domain, not for any other', async () => {
    idToken = token({ ...BASE, email: 'noa@gmail.com' });
    expect(await identify()).toEqual({ subject: 'sub-1', email: 'noa@gmail.com', emailVerified: true, authoritative: true });
    idToken = token({ ...BASE, email: 'noa@company.example', hd: 'company.example' });
    expect((await identify()).authoritative).toBe(true);
    idToken = token({ ...BASE, email: 'noa@company.example' });
    expect(await identify()).toMatchObject({ emailVerified: true, authoritative: false });
  });

  it('refuses a token from another issuer or for another client', async () => {
    idToken = token({ ...BASE, email: 'noa@gmail.com', iss: 'https://evil.example' });
    await expect(identify()).rejects.toThrow('not from Google');
    idToken = token({ ...BASE, email: 'noa@gmail.com', aud: 'someone-else' });
    await expect(identify()).rejects.toThrow('another client');
  });
});
