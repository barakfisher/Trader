import { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { LineChart } from 'lucide-react';

import type { VerifyEmailResponse } from '@traders/shared';

import { api } from '../api/client.ts';
import { Disclaimer } from '../components/Disclaimer.tsx';
import { Button, ErrorNote, Spinner } from '../components/ui.tsx';
import { useTranslation } from '../i18n/index.ts';
import { useStore } from '../stores/context.tsx';

/** The page a mailed link opens (D259); outside the router, so it works signed out as well as in. */
export const VERIFY_PATH = '/verify';

type Outcome = VerifyEmailResponse['outcome'];

/** The token from `#token=...`: the fragment never reaches a server, so the link stays out of logs. */
function tokenFromAddress(): string | null {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  return token && token.length > 0 ? token : null;
}

/**
 * Opens a link from an email: posts its token once and says what it did. It
 * signs nobody in (D259) - the link proves the mailbox, not the password - so
 * every outcome ends on the sign-in page, or the app for a new address
 * confirmed on the device already signed in. The token is cleared from the
 * address bar at once, so a shared screenshot or history entry does not hold
 * a link that might still work.
 */
export const VerifyPage = observer(function VerifyPage() {
  const { auth } = useStore();
  const { t } = useTranslation();
  const [token] = useState(tokenFromAddress);
  const [outcome, setOutcome] = useState<Outcome | null>(token === null ? 'invalid' : null);
  const [failed, setFailed] = useState(false);
  // Posted once: a second post would find the link used. A ref, so React's
  // development double-run of effects does not send it twice.
  const sent = useRef(false);

  async function open(): Promise<void> {
    if (token === null) return;
    setFailed(false);
    try {
      const body = await api.post<VerifyEmailResponse>('/auth/verify', { token });
      setOutcome(body.outcome);
    } catch {
      setFailed(true);
    }
  }

  useEffect(() => {
    window.history.replaceState(null, '', window.location.pathname);
    if (sent.current) return;
    sent.current = true;
    void open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A second link pasted into this tab changes only the fragment, which loads
  // nothing: start over so it is the new link that is opened, not the last
  // one's answer that stays on screen. (Clearing the token above uses
  // `replaceState`, which fires no `hashchange`.)
  useEffect(() => {
    const reopen = () => window.location.reload();
    window.addEventListener('hashchange', reopen);
    return () => window.removeEventListener('hashchange', reopen);
  }, []);

  /** Leave for the app at its root: the sign-in page, or the app for a device still signed in. */
  async function proceed(): Promise<void> {
    await auth.loadSession();
    window.location.assign('/');
  }

  return (
    <main className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4">
        <div className="flex items-center gap-2">
          <LineChart className="size-6 text-accent" aria-hidden />
          <h1 className="text-lg font-semibold">{t('login.title')}</h1>
        </div>
        <section className="space-y-3 rounded-xl border border-border-subtle bg-surface-raised p-4">
          {failed ? (
            <ErrorNote message={t('verify.failed')} onRetry={() => void open()} />
          ) : outcome === null ? (
            <Spinner label={t('verify.checking')} />
          ) : (
            <>
              <h2 className="font-semibold">{t(`verify.${outcome}.title`)}</h2>
              <p className="text-sm text-text-muted">{t(`verify.${outcome}.body`)}</p>
              <Button className="w-full" onClick={() => void proceed()}>
                {t(outcome === 'email_changed' ? 'verify.continue' : 'verify.toSignIn')}
              </Button>
            </>
          )}
        </section>
        <Disclaimer />
      </div>
    </main>
  );
});
