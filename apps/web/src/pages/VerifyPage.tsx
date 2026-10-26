import { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { LineChart, LockKeyhole } from 'lucide-react';

import type { VerifyEmailResponse } from '@traders/shared';

import { api } from '../api/client.ts';
import { Disclaimer } from '../components/Disclaimer.tsx';
import { PasswordInput } from '../components/PasswordInput.tsx';
import { Button, ErrorNote } from '../components/ui.tsx';
import { useTranslation } from '../i18n/index.ts';
import { useStore } from '../stores/context.tsx';

/** The page a mailed link opens (D259); outside the router, so it works signed out as well as in. */
export const VERIFY_PATH = '/verify';

/** What the page shows once the server answered; a wrong password keeps the form instead. */
type Outcome = Exclude<VerifyEmailResponse['outcome'], 'wrong_password'>;

/** What `#token=...&for=signup` carries: the fragment never reaches a server, so the link stays out of logs. */
function linkFromAddress(): { token: string | null; signup: boolean } {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const token = params.get('token');
  return { token: token && token.length > 0 ? token : null, signup: params.get('for') === 'signup' };
}

/**
 * Opens a link from an email. Nothing is sent until the person presses
 * Confirm: a mail scanner that opens links and runs their scripts must not
 * confirm an address on its own. Every link also asks for the account's
 * password (D309, D310), because the mailbox alone does not prove whose
 * account it is; `for=signup` only picks the sentence above the field.
 *
 * It signs nobody in (D259), so every outcome ends on the sign-in page, or the
 * app for a new address confirmed on the device already signed in. The token
 * is cleared from the address bar at once, so a shared screenshot or history
 * entry does not hold a link that might still work.
 */
export const VerifyPage = observer(function VerifyPage() {
  const { auth } = useStore();
  const { t } = useTranslation();
  const [link] = useState(linkFromAddress);
  const [outcome, setOutcome] = useState<Outcome | null>(link.token === null ? 'invalid' : null);
  const [password, setPassword] = useState('');
  const [wrongPassword, setWrongPassword] = useState(false);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    window.history.replaceState(null, '', window.location.pathname);
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

  async function confirm(): Promise<void> {
    if (link.token === null || sending) return;
    setSending(true);
    setFailed(false);
    setWrongPassword(false);
    try {
      const body = await api.post<VerifyEmailResponse>('/auth/verify', { token: link.token, password });
      if (body.outcome === 'wrong_password') setWrongPassword(true);
      else setOutcome(body.outcome);
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  }

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
        {outcome === null ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void confirm();
            }}
            className="space-y-3 rounded-xl border border-border-subtle bg-surface-raised p-4"
          >
            <h2 className="font-semibold">{t(link.signup ? 'verify.confirmSignup.title' : 'verify.confirmAddress.title')}</h2>
            <p className="text-sm text-text-muted">
              {t(link.signup ? 'verify.confirmSignup.body' : 'verify.confirmAddress.body')}
            </p>
            <label className="block space-y-1">
              <span className="text-xs uppercase tracking-wide text-text-muted">{t('login.password')}</span>
              <div className="flex items-center gap-2">
                <LockKeyhole className="size-4 text-text-muted" aria-hidden />
                <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" />
              </div>
            </label>
            {wrongPassword && <ErrorNote message={t('verify.wrongPassword')} />}
            {failed && <ErrorNote message={t('verify.failed')} />}
            <Button type="submit" className="w-full" disabled={sending || password.length === 0}>
              {sending ? t('verify.checking') : t('verify.confirm')}
            </Button>
          </form>
        ) : (
          <section className="space-y-3 rounded-xl border border-border-subtle bg-surface-raised p-4">
            <h2 className="font-semibold">{t(`verify.${outcome}.title`)}</h2>
            <p className="text-sm text-text-muted">{t(`verify.${outcome}.body`)}</p>
            <Button className="w-full" onClick={() => void proceed()}>
              {t(outcome === 'email_changed' ? 'verify.continue' : 'verify.toSignIn')}
            </Button>
          </section>
        )}
        <Disclaimer />
      </div>
    </main>
  );
});
