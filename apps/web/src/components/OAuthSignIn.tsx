import { useState } from 'react';

import { OAUTH_OUTCOMES, type OAuthOutcome, type OAuthProviderName } from '@traders/shared';

import { API_BASE_URL, errorMessage } from '../api/client.ts';
import { currentLanguage, useTranslation } from '../i18n/index.ts';
import { useIdentitiesQuery, useOAuthProvidersQuery, useUnlinkIdentity } from '../queries/identities.ts';
import { Button, ErrorNote, Spinner, buttonClass } from './ui.tsx';

/** Product names, not translated (guideline 1 translates our words, not theirs). */
export const PROVIDER_LABEL: Record<OAuthProviderName, string> = { google: 'Google', github: 'GitHub' };

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Where the browser leaves for a provider (D262): the server checks the origin
 * against its own list, and a new account takes this browser's zone and
 * language, as a sign-up does (D163).
 */
export function oauthStartUrl(provider: OAuthProviderName, intent: 'signin' | 'link'): string {
  const query = new URLSearchParams({
    origin: window.location.origin,
    intent,
    timezone: browserTimeZone(),
    language: currentLanguage(),
  });
  return `${API_BASE_URL}/auth/oauth/${provider}/start?${query.toString()}`;
}

/**
 * The `?oauth=` a provider's callback came back with (D262), read once and
 * taken out of the address bar so a reload does not show it again.
 */
export function useOAuthOutcome(): OAuthOutcome | null {
  const [outcome] = useState<OAuthOutcome | null>(() => {
    const url = new URL(window.location.href);
    const value = url.searchParams.get('oauth');
    if (value === null) return null;
    url.searchParams.delete('oauth');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    return (OAUTH_OUTCOMES as readonly string[]).includes(value) ? (value as OAuthOutcome) : 'failed';
  });
  return outcome;
}

export function OAuthOutcomeNotice({ outcome }: { outcome: OAuthOutcome | null }) {
  const { t } = useTranslation();
  if (outcome === null || outcome === 'signed_in') return null;
  return (
    <p role="status" className="rounded-lg border border-border-subtle bg-surface-raised p-3 text-sm">
      {t(`oauth.outcomes.${outcome}`)}
    </p>
  );
}

/** "Continue with Google / GitHub" on the sign-in page; nothing where no provider is configured. */
export function OAuthButtons() {
  const { t } = useTranslation();
  const providers = useOAuthProvidersQuery();
  if (!providers.data || providers.data.length === 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-center text-xs text-text-muted">{t('oauth.or')}</p>
      {providers.data.map((provider) => (
        <a key={provider} href={oauthStartUrl(provider, 'signin')} className={buttonClass('secondary', 'w-full text-center')}>
          {t('oauth.continueWith', { provider: PROVIDER_LABEL[provider] })}
        </a>
      ))}
    </div>
  );
}

/** Settings: the providers linked to this account, with Link and Unlink (D263). */
export function LinkedProviders() {
  const { t } = useTranslation();
  const identities = useIdentitiesQuery();
  const unlink = useUnlinkIdentity();
  if (identities.isPending) return <Spinner label={t('oauth.loading')} />;
  if (identities.isError) {
    return <ErrorNote message={errorMessage(identities.error, t('oauth.loadFailed'))} onRetry={() => void identities.refetch()} />;
  }
  const { identities: linked, available } = identities.data;
  if (available.length === 0 && linked.length === 0) return null;
  return (
    <div className="mt-4 space-y-2">
      <h3 className="text-xs uppercase tracking-wide text-text-muted">{t('oauth.methods')}</h3>
      <ul className="divide-y divide-border-subtle rounded-lg border border-border-subtle">
        {[...new Set([...available, ...linked.map((row) => row.provider)])].map((provider) => {
          const row = linked.find((identity) => identity.provider === provider);
          return (
            <li key={provider} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
              <span>
                <span className="font-medium">{PROVIDER_LABEL[provider]}</span>
                {row?.email && (
                  <>
                    {' '}
                    <bdi dir="ltr" className="text-text-muted">
                      {row.email}
                    </bdi>
                  </>
                )}
              </span>
              {row ? (
                <Button
                  variant="secondary"
                  disabled={unlink.isPending && unlink.variables === provider}
                  onClick={() => unlink.mutate(provider)}
                >
                  {t('oauth.unlink')}
                </Button>
              ) : (
                <a href={oauthStartUrl(provider, 'link')} className={buttonClass('secondary')}>
                  {t('oauth.link')}
                </a>
              )}
            </li>
          );
        })}
      </ul>
      {/* Our sentence, in the reader's language: the only refusal is "the last way in". */}
      {unlink.isError && <ErrorNote message={t('oauth.unlinkFailed')} />}
    </div>
  );
}
