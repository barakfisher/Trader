/**
 * Google as the sign-in provider (D262; GitHub was dropped, D376), behind
 * one interface (guideline 6): the routes never name `arctic`, and tests use a fake that
 * makes no network call.
 *
 * A provider says three things about a person: a stable subject id, the email
 * it has for them, and whether it vouches for that email (D263): Google's
 * `email_verified`. Only a vouched-for address links to an existing account or opens a new one.
 */

import { Google, decodeIdToken } from 'arctic';

import type { OAuthProviderName } from '@traders/shared';

import type { Config } from '../config.js';

export interface OAuthIdentity {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  /**
   * Whether the provider is the authority for that mailbox now, not just a
   * check it once made (D315): only then does it link to an existing account
   * automatically. Google: a `@gmail.com` address, or a Workspace domain
   * (`hd`).
   */
  authoritative: boolean;
}

export interface OAuthProvider {
  readonly name: OAuthProviderName;
  /** Where the browser goes to sign in; `codeVerifier` is PKCE's, kept in our state cookie. */
  authorizationUrl(input: { state: string; codeVerifier: string; redirectUri: string }): URL;
  /** Exchange the callback's code for who signed in. Throws when the provider refuses it. */
  identify(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<OAuthIdentity>;
}

/** How long a call to a provider may take before the sign-in counts as failed. */
export const PROVIDER_TIMEOUT_MS = 10_000;

class GoogleProvider implements OAuthProvider {
  readonly name = 'google' as const;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  authorizationUrl({ state, codeVerifier, redirectUri }: { state: string; codeVerifier: string; redirectUri: string }): URL {
    return new Google(this.clientId, this.clientSecret, redirectUri).createAuthorizationURL(state, codeVerifier, [
      'openid',
      'email',
    ]);
  }

  async identify({ code, codeVerifier, redirectUri }: { code: string; codeVerifier: string; redirectUri: string }): Promise<OAuthIdentity> {
    const tokens = await new Google(this.clientId, this.clientSecret, redirectUri).validateAuthorizationCode(code, codeVerifier);
    // The ID token came straight from Google's token endpoint over TLS, in
    // exchange for our client secret, so OpenID Connect lets its signature go
    // unchecked (Core 3.1.3.7, item 6).
    const claims = decodeIdToken(tokens.idToken()) as {
      iss?: unknown;
      aud?: unknown;
      sub?: unknown;
      email?: unknown;
      email_verified?: unknown;
      hd?: unknown;
    };
    // Still checked without a signature (items 2 and 3): ours, and Google's.
    if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') {
      throw new Error('the ID token is not from Google');
    }
    if (claims.aud !== this.clientId) throw new Error('the ID token is for another client');
    if (typeof claims.sub !== 'string' || claims.sub.length === 0) throw new Error('Google returned no subject');
    const email = typeof claims.email === 'string' ? claims.email : null;
    const emailVerified = claims.email_verified === true;
    return {
      subject: claims.sub,
      email,
      emailVerified,
      authoritative:
        emailVerified && email !== null && (email.toLowerCase().endsWith('@gmail.com') || typeof claims.hd === 'string'),
    };
  }
}

/** The providers this installation has an app for: both settings set, or the provider is not offered. */
export function buildOAuthProviders(config: Config): Map<OAuthProviderName, OAuthProvider> {
  const providers = new Map<OAuthProviderName, OAuthProvider>();
  if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) {
    providers.set('google', new GoogleProvider(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET));
  }
  return providers;
}
