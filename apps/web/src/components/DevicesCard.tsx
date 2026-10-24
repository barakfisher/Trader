import { useState } from 'react';
import { HelpCircle, Laptop, Smartphone, Tablet, type LucideIcon } from 'lucide-react';

import type { SessionDevice } from '@traders/shared';

import { errorMessage } from '../api/client.ts';
import { formatDate } from '../i18n/format.ts';
import { useTranslation } from '../i18n/index.ts';
import { formatAge, formatExactTime, getDisplayTimeZone } from '../lib/relativeTime.ts';
import { useSessionsQuery, useSignOutOtherSessions, useSignOutSession } from '../queries/sessions.ts';
import { Button, Card, ErrorNote, Spinner } from './ui.tsx';

const DEVICE_ICONS: Record<NonNullable<SessionDevice['deviceType']>, LucideIcon> = {
  desktop: Laptop,
  mobile: Smartphone,
  tablet: Tablet,
};

/** A product name or an address inside a sentence, isolated so a Hebrew line keeps its order. */
const isolate = (text: string) => `⁨${text}⁩`;

/**
 * Where this account is signed in (D261): each device's browser and OS, when it
 * signed in and was last seen, and its address. Any other device can be signed
 * out from here, or all of them at once; this one is signed out from the menu
 * (D296), so its row has no button.
 */
export function DevicesCard() {
  const { t } = useTranslation();
  const sessions = useSessionsQuery();
  const signOut = useSignOutSession();
  const signOutOthers = useSignOutOtherSessions();
  const [ended, setEnded] = useState<number | null>(null);

  const others = (sessions.data ?? []).filter((session) => !session.current);
  const failure = signOut.error ?? signOutOthers.error;

  return (
    <Card title={t('devices.title')}>
      <p className="mb-3 max-w-2xl text-xs text-text-muted">{t('devices.intro')}</p>
      {sessions.isPending ? (
        <Spinner label={t('devices.loading')} />
      ) : sessions.isError ? (
        <ErrorNote message={errorMessage(sessions.error, t('devices.loadFailed'))} onRetry={() => void sessions.refetch()} />
      ) : (
        <div className="space-y-3">
          <ul className="divide-y divide-border-subtle rounded-lg border border-border-subtle">
            {sessions.data.map((session) => (
              <DeviceRow
                key={session.id}
                session={session}
                signingOut={signOut.isPending && signOut.variables === session.id}
                onSignOut={() => {
                  setEnded(null);
                  signOut.mutate(session.id);
                }}
              />
            ))}
          </ul>
          {others.length === 0 && <p className="text-sm text-text-muted">{t('devices.noOthers')}</p>}
          {failure && <ErrorNote message={errorMessage(failure, t('devices.signOutFailed'))} />}
          {ended !== null && (
            <p role="status" className="text-sm text-text-muted">
              {t('devices.othersEnded', { count: ended })}
            </p>
          )}
          {others.length > 0 && (
            <div className="flex justify-end">
              <Button
                variant="danger"
                disabled={signOutOthers.isPending}
                onClick={() =>
                  signOutOthers.mutate(undefined, { onSuccess: (body) => setEnded(body.ended) })
                }
              >
                {signOutOthers.isPending ? t('devices.signingOut') : t('devices.signOutOthers')}
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function DeviceRow({
  session,
  signingOut,
  onSignOut,
}: {
  session: SessionDevice;
  signingOut: boolean;
  onSignOut: () => void;
}) {
  const { t } = useTranslation();
  const Icon = session.deviceType ? DEVICE_ICONS[session.deviceType] : HelpCircle;
  const name = t('devices.browserOnOs', {
    browser: isolate(session.browser ?? t('devices.unknownBrowser')),
    os: isolate(session.os ?? t('devices.unknownOs')),
  });
  const signedIn = formatDate(new Date(session.signedInAt), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: getDisplayTimeZone(),
  });
  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2.5">
      <Icon className="size-5 shrink-0 text-text-muted" aria-hidden />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <span>{name}</span>
          {session.current && (
            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
              {t('devices.thisDevice')}
            </span>
          )}
        </p>
        <p className="text-xs text-text-muted">
          <span title={formatExactTime(session.signedInAt)}>{t('devices.signedIn', { date: isolate(signedIn) })}</span>
          {' · '}
          <span title={formatExactTime(session.lastSeenAt)}>
            {t('devices.lastSeen', { age: isolate(formatAge(session.lastSeenAt)) })}
          </span>
          {session.ipAddress && (
            <>
              {' · '}
              <bdi dir="ltr">{session.ipAddress}</bdi>
            </>
          )}
        </p>
      </div>
      {!session.current && (
        <Button variant="secondary" disabled={signingOut} onClick={onSignOut}>
          {signingOut ? t('devices.signingOut') : t('devices.signOut')}
        </Button>
      )}
    </li>
  );
}
