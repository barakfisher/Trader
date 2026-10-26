/**
 * Google and GitHub as sign-in providers (D262), behind one interface
 * (guideline 6): the routes never name `arctic`, and tests use a fake that
 * makes no network call.
 *
 * A provider says three things about a person: a stable subject id, the email
 * it has for them, and whether it vouches for that email (D263): Google's
 * `email_verified`, or GitHub's verified primary address. Only a vouched-for
 * address links to an existing account or opens a new one.
 */

import { GitHub, Google, decodeIdToken } from 'arctic';

import type { OAuthProviderName } from '@traders/shared';

import type { Config } from '../config.js';

export interface OAuthIdentity {
  subject: string;
  email: string | null;
  emailVerified: boolean;
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
    const claims = decodeIdToken(tokens.idToken()) as { sub?: unknown; email?: unknown; email_verified?: unknown };
    if (typeof claims.sub !== 'string' || claims.sub.length === 0) throw new Error('Google returned no subject');
    return {
      subject: claims.sub,
      email: typeof claims.email === 'string' ? claims.email : null,
      emailVerified: claims.email_verified === true,
    };
  }
}

class GitHubProvider implements OAuthProvider {
  readonly name = 'github' as const;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  authorizationUrl({ state, redirectUri }: { state: string; redirectUri: string }): URL {
    // GitHub's OAuth apps do not take PKCE; `state` alone binds the callback.
    return new GitHub(this.clientId, this.clientSecret, redirectUri).createAuthorizationURL(state, ['read:user', 'user:email']);
  }

  async identify({ code, redirectUri }: { code: string; redirectUri: string }): Promise<OAuthIdentity> {
    const tokens = await new GitHub(this.clientId, this.clientSecret, redirectUri).validateAuthorizationCode(code);
    const headers = {
      authorization: `Bearer ${tokens.accessToken()}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'traders',
    };
    const get = async <T>(path: string): Promise<T> => {
      const response = await fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`GitHub ${path} answered ${response.status}`);
      return (await response.json()) as T;
    };
    const user = await get<{ id?: unknown }>('/user');
    if (typeof user.id !== 'number') throw new Error('GitHub returned no user id');
    const emails = await get<Array<{ email: string; primary: boolean; verified: boolean }>>('/user/emails');
    const primary = emails.find((entry) => entry.primary);
    return { subject: String(user.id), email: primary?.email ?? null, emailVerified: primary?.verified === true };
  }
}

/** The providers this installation has an app for: both settings set, or the provider is not offered. */
export function buildOAuthProviders(config: Config): Map<OAuthProviderName, OAuthProvider> {
  const providers = new Map<OAuthProviderName, OAuthProvider>();
  if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) {
    providers.set('google', new GoogleProvider(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET));
  }
  if (config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET) {
    providers.set('github', new GitHubProvider(config.GITHUB_CLIENT_ID, config.GITHUB_CLIENT_SECRET));
  }
  return providers;
}
