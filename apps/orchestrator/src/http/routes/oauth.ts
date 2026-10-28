/**
 * Sign-in through Google and GitHub, and linking them in Settings (D262,
 * D263, D314). The browser leaves for the provider from `/start` and comes
 * back to `/callback`; both are top-level navigations, so they answer with
 * redirects, and the page the browser lands on reads `?oauth=<outcome>`.
 *
 * Who a provider identity is, in order:
 * 1. linked already - it signs in to its account, if that account is active;
 * 2. asked from Settings - it is linked to the signed-in account;
 * 3. an account at the address the provider vouches for - it is linked
 *    automatically and announced by mail (D263), except to the admin, who
 *    links from Settings (D314); an unverified request at that address is
 *    claimed, its password dropped (D314);
 * 4. no account - a new one, by the installation's sign-up rules (D243).
 * An address the provider does not vouch for links nothing and opens nothing.
 */

import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';

import {
  OAUTH_PROVIDERS,
  UI_LANGUAGES,
  emailProblem,
  normaliseEmail,
  timeZoneProblem,
  type LinkedIdentity,
  type OAuthOutcome,
  type OAuthProviderName,
} from '@traders/shared';

import {
  claimUnverifiedRequest,
  createOAuthAccount,
  getAccountByEmail,
  getIdentityUser,
  getInstallationSettings,
  getOrCreateUserSettings,
  getUser,
  linkIdentity,
  listIdentities,
  recordSignIn,
  reopenClosedAccount,
  unlinkIdentity,
} from '../../db/queries.js';
import { emailMessages } from '../../email/messages.js';
import { logger } from '../../logger.js';
import type { OAuthIdentity, OAuthProvider } from '../../oauth/providers.js';
import {
  OAUTH_STATE_TTL_SECONDS,
  oauthStateCookieName,
  decodeOAuthState,
  encodeOAuthState,
  oauthSecret,
  type OAuthState,
} from '../../oauth/stateCookie.js';
import { announceSignupRequest } from '../../telegram/signupApproval.js';
import { announceAccountRestored, mailLanguage, sendInBackground } from '../accountMail.js';
import type { AppEnv } from '../app.js';
import { ApiProblem, notFound, unauthorized } from '../errors.js';
import { pageLink } from '../linkTokens.js';
import { requestAddressKey } from '../rateLimits.js';
import { issueSession } from '../sessions.js';
import { automaticSignupHeld } from '../legal.js';

/** The callback's path under the web origin; nginx strips `/api` before the orchestrator. */
export function oauthRedirectUri(origin: string, provider: OAuthProviderName): string {
  return new URL(`/api/auth/oauth/${provider}/callback`, origin).toString();
}

const PROVIDER_LABEL: Record<OAuthProviderName, string> = { google: 'Google', github: 'GitHub' };

const startQuery = z.object({
  origin: z.string().max(500),
  intent: z.enum(['signin', 'link']).default('signin'),
  timezone: z.string().max(100).optional(),
  language: z.string().max(10).optional(),
});

function providerOf(context: Context<AppEnv>, providers: Map<OAuthProviderName, OAuthProvider>): OAuthProvider {
  const name = context.req.param('provider');
  const provider = (OAUTH_PROVIDERS as readonly string[]).includes(name ?? '') ? providers.get(name as OAuthProviderName) : undefined;
  if (!provider) throw notFound('this sign-in provider is not offered here');
  return provider;
}

export function registerOAuthRoutes(app: Hono<AppEnv>, providers: Map<OAuthProviderName, OAuthProvider>): void {
  /** Which providers the sign-in page and Settings offer: those with an app configured. */
  app.get('/auth/oauth/providers', (context) => context.json({ providers: [...providers.keys()] }));

  /**
   * Leave for the provider. The origin is the page's own, and must be one of
   * `ALLOWED_ORIGINS`: the redirect URI is built from it and the browser is
   * sent back to it, so nothing else may choose where either goes.
   */
  app.get('/auth/oauth/:provider/start', async (context) => {
    const config = context.get('config');
    const provider = providerOf(context, providers);
    const parsed = startQuery.safeParse(context.req.query());
    if (!parsed.success || !config.allowedOrigins.includes(parsed.data.origin)) {
      throw new ApiProblem(400, 'bad_origin', 'the page this sign-in starts from is not one this installation serves');
    }
    await context.get('rateLimits').consume('oauthStartPerAddress', requestAddressKey(context, config.TRUSTED_PROXY_HOPS));
    const { origin, intent } = parsed.data;
    const userId = context.get('userId') ?? null;
    if (intent === 'link' && userId === null) throw unauthorized();
    // A one-time password's session can change the password and nothing else
    // (D162), here as on the other `/auth/*` writes: a link it planted would
    // outlast the new password (D315).
    if (intent === 'link' && context.get('user')?.password_must_change) {
      throw new ApiProblem(403, 'password_change_required', 'set a new password first');
    }

    const timezone = parsed.data.timezone && timeZoneProblem(parsed.data.timezone) === null ? parsed.data.timezone : 'UTC';
    const language = (UI_LANGUAGES as readonly string[]).includes(parsed.data.language ?? '') ? parsed.data.language! : 'en';
    const state: OAuthState = {
      provider: provider.name,
      state: oauthSecret(),
      codeVerifier: oauthSecret(),
      origin,
      intent,
      userId: intent === 'link' ? userId : null,
      timezone,
      language,
      expiresAt: Date.now() + OAUTH_STATE_TTL_SECONDS * 1000,
    };
    setCookie(context, oauthStateCookieName(config.isProduction), encodeOAuthState(state, config.SESSION_SECRET), {
      httpOnly: true,
      // Lax: the provider sends the browser back with a top-level GET, which carries it.
      sameSite: 'Lax',
      secure: config.isProduction,
      path: '/',
      maxAge: OAUTH_STATE_TTL_SECONDS,
    });
    const url = provider.authorizationUrl({
      state: state.state,
      codeVerifier: state.codeVerifier,
      redirectUri: oauthRedirectUri(origin, provider.name),
    });
    return context.redirect(url.toString(), 302);
  });

  /**
   * Back from the provider. The cookie must be this browser's, for this
   * provider, unexpired, and its `state` the one the provider returned;
   * anything else is a callback this browser did not start, and signs nobody
   * in. The cookie is spent either way.
   */
  app.get('/auth/oauth/:provider/callback', async (context) => {
    const config = context.get('config');
    const provider = providerOf(context, providers);
    const cookieName = oauthStateCookieName(config.isProduction);
    const saved = decodeOAuthState(getCookie(context, cookieName), config.SESSION_SECRET);
    deleteCookie(context, cookieName, { path: '/', secure: config.isProduction });
    const returnedState = context.req.query('state') ?? '';
    const code = context.req.query('code');
    // Without a cookie there is no trusted origin to send the browser to: its own root.
    if (!saved || saved.provider !== provider.name || saved.state !== returnedState || !code) {
      return context.redirect(saved ? landing(saved, 'failed') : '/?oauth=failed', 302);
    }

    let outcome: OAuthOutcome;
    try {
      const identity = await provider.identify({
        code,
        codeVerifier: saved.codeVerifier,
        redirectUri: oauthRedirectUri(saved.origin, provider.name),
      });
      outcome = await settle(context, provider.name, identity, saved);
    } catch (error) {
      logger().warn({ provider: provider.name, err: (error as Error).message }, 'oauth sign-in failed');
      outcome = 'failed';
    }
    return context.redirect(landing(saved, outcome), 302);
  });

  /** The providers linked to this account, for Settings (D263). */
  app.get('/auth/identities', async (context) => {
    const userId = context.get('userId');
    if (!userId) throw unauthorized();
    const rows = await listIdentities(userId);
    const body: LinkedIdentity[] = rows.map((row) => ({
      provider: row.provider,
      email: row.email,
      linkedAt: row.created_at.toISOString(),
    }));
    return context.json({ identities: body, available: [...providers.keys()] });
  });

  /** Unlink a provider - refused when it is the account's only way to sign in (D263). */
  app.delete('/auth/identities/:provider', async (context) => {
    const userId = context.get('userId');
    if (!userId) throw unauthorized();
    if (context.get('user')?.password_must_change) {
      throw new ApiProblem(403, 'password_change_required', 'set a new password first');
    }
    const name = context.req.param('provider');
    if (!(OAUTH_PROVIDERS as readonly string[]).includes(name)) throw notFound('no such provider');
    const result = await unlinkIdentity(userId, name as OAuthProviderName);
    if (result === 'not_linked') throw notFound('this provider is not linked');
    if (result === 'last_method') {
      throw new ApiProblem(409, 'last_sign_in_method', 'set a password or link another provider before unlinking this one');
    }
    return context.json({ unlinked: true });
  });
}

/** Where the browser lands: Settings for a link, the app's root for a sign-in. */
function landing(saved: OAuthState, outcome: OAuthOutcome): string {
  return pageLink(saved.origin, saved.intent === 'link' ? `/settings?oauth=${outcome}` : `/?oauth=${outcome}`);
}

/** Decide who the identity is (the header's four steps), sign in where that is the answer, and say what happened. */
async function settle(
  context: Context<AppEnv>,
  provider: OAuthProviderName,
  identity: OAuthIdentity,
  saved: OAuthState,
): Promise<OAuthOutcome> {
  const config = context.get('config');
  const linked = await getIdentityUser(provider, identity.subject);

  if (saved.intent === 'link') {
    // The session must still be the one that asked: a link is never made to anyone else.
    const userId = context.get('userId');
    if (!userId || userId !== saved.userId || context.get('user')?.password_must_change) return 'failed';
    if (linked) return linked.user_id === userId ? 'already_linked' : 'taken';
    const result = await linkIdentity({ userId, provider, subject: identity.subject, email: identity.email });
    if (result === 'linked') await announceLink(context, userId, provider, saved.origin);
    return result;
  }

  if (linked) return signIn(context, linked.user_id);

  const email = identity.email === null ? null : normaliseEmail(identity.email);
  if (email === null || !identity.emailVerified || emailProblem(email) !== null) return 'unverified_email';

  const settings = await getInstallationSettings();
  // A held *automatic* admits nobody, inside the same transaction that reads the mode (D265, D344).
  const rules = {
    defaultCapMicroUsd: settings.default_llm_cap_micro_usd,
    timezone: config.APP_TIMEZONE,
    automaticHeld: automaticSignupHeld(context),
  };
  const account = await getAccountByEmail(email);
  if (account) {
    // An existing account is linked automatically only when the provider is
    // the mailbox's authority now (D315), never to the admin (D314), and only
    // where the link can be announced by mail (D263): otherwise the owner signs
    // in with the password and links from Settings.
    if (account.role === 'admin' || !identity.authoritative || context.get('email') === null) return 'link_from_settings';
    if (account.status === 'pending' && !account.email_verified) {
      // Claiming a request is joining: held, like a new account, by `rules` (D265, D344).
      const claimed = await claimUnverifiedRequest({ userId: account.id, provider, subject: identity.subject, email }, rules);
      if (claimed === 'signup_full') return 'closed';
      if (claimed === 'taken') return 'failed';
      await announceLink(context, account.id, provider, saved.origin);
      if (claimed === 'awaiting_approval') {
        announce(context, account.id);
        return 'pending';
      }
      return signIn(context, account.id);
    }
    if (account.status !== 'active' && account.status !== 'pending') return 'not_active';
    const result = await linkIdentity({ userId: account.id, provider, subject: identity.subject, email });
    // `already_linked` here is another account of this provider on it: managed from Settings.
    if (result === 'already_linked') return 'link_from_settings';
    if (result !== 'linked') return result;
    await announceLink(context, account.id, provider, saved.origin);
    return account.status === 'pending' ? 'pending' : signIn(context, account.id);
  }

  // A new account is a sign-up, counted as one per address (D257); a held
  // *automatic* closes it by `rules` (D265, D344). It has accepted no version:
  // the session gate asks at its first request.
  await context.get('rateLimits').consume('signupPerAddress', requestAddressKey(context, config.TRUSTED_PROXY_HOPS));
  const created = await createOAuthAccount(
    { email, provider, subject: identity.subject, timezone: saved.timezone, language: saved.language },
    rules,
  );
  if (!('userId' in created)) return created.outcome === 'signup_full' ? 'closed' : 'failed';
  if (created.outcome === 'awaiting_approval') {
    announce(context, created.userId);
    return 'pending';
  }
  return signIn(context, created.userId);
}

async function signIn(context: Context<AppEnv>, userId: string): Promise<OAuthOutcome> {
  const user = await getUser(userId);
  if (!user) return 'failed';
  if (user.status === 'pending') return 'pending';
  // Signing in during the grace period cancels a deletion (D264), as with a
  // password - a closed account only, never one the admin disabled.
  const reopened = user.status === 'closed' ? await reopenClosedAccount(user.id, user.session_version) : null;
  if (user.status !== 'active' && reopened === null) return 'not_active';
  await issueSession(context, reopened ?? user);
  await recordSignIn(user.id);
  if (reopened !== null) announceAccountRestored(context.get('email'), reopened);
  return reopened ? 'restored' : 'signed_in';
}

/** Every link is mailed to the account (D263), so a link its owner did not make is seen. */
async function announceLink(
  context: Context<AppEnv>,
  userId: string,
  provider: OAuthProviderName,
  origin: string,
): Promise<void> {
  const sender = context.get('email');
  const user = await getUser(userId);
  if (sender === null || !user?.email) return;
  const language = mailLanguage((await getOrCreateUserSettings(userId)).language);
  const to = user.email;
  sendInBackground(userId, 'identity_linked', () =>
    sender.send(emailMessages.identityLinked(to, language, PROVIDER_LABEL[provider], pageLink(origin, '/'))),
  );
}

/** A request waiting for the admin is announced on Telegram, as one verified by a link is. */
function announce(context: Context<AppEnv>, userId: string): void {
  const config = context.get('config');
  void announceSignupRequest({ notifier: context.get('notifier'), signingSecret: config.TELEGRAM_SIGNING_SECRET }, userId);
}
