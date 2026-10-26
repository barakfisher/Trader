import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { AtSign, LineChart, LockKeyhole } from 'lucide-react';

import { Disclaimer } from '../components/Disclaimer.tsx';
import { PasswordInput } from '../components/PasswordInput.tsx';
import { OAuthButtons, OAuthOutcomeNotice, useOAuthOutcome } from '../components/OAuthSignIn.tsx';
import { ResetRequestForm } from '../components/ResetRequestForm.tsx';
import { SignupForm } from '../components/SignupForm.tsx';
import { Button, ErrorNote } from '../components/ui.tsx';
import { ApiRequestError, RATE_LIMITED } from '../api/client.ts';
import { useTranslation } from '../i18n/index.ts';
import { useStore } from '../stores/context.tsx';

/** Email and password (D159), asking to join (D156), and a forgotten password (D260): the page that works signed out. */
export const LoginPage = observer(function LoginPage() {
  const { auth } = useStore();
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [joining, setJoining] = useState(false);
  const [forgotten, setForgotten] = useState(false);
  const oauthOutcome = useOAuthOutcome();

  return (
    <main className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4">
        <div className="flex items-center gap-2">
          <LineChart className="size-6 text-accent" aria-hidden />
          <h1 className="text-lg font-semibold">{t('login.title')}</h1>
        </div>
        {joining ? (
          <SignupForm onBack={() => setJoining(false)} />
        ) : forgotten ? (
          <ResetRequestForm onBack={() => setForgotten(false)} />
        ) : (
          <>
            <OAuthOutcomeNotice outcome={oauthOutcome} />
            {auth.sessionEndedNotice && (
              <p role="status" className="rounded-lg border border-border-subtle bg-surface-raised p-3 text-sm">
                {t('login.sessionEnded')}
              </p>
            )}
            <p className="text-sm text-text-muted">{t('login.intro')}</p>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                void auth.login(email.trim(), password);
              }}
              className="space-y-3 rounded-xl border border-border-subtle bg-surface-raised p-4"
            >
              <label className="block space-y-1">
                <span className="text-xs uppercase tracking-wide text-text-muted">
                  {t('login.email')}
                </span>
                <div className="flex items-center gap-2">
                  <AtSign className="size-4 text-text-muted" aria-hidden />
                  <input
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoFocus
                    autoComplete="username"
                    dir="ltr"
                    className="input"
                  />
                </div>
              </label>

              <label className="block space-y-1">
                <span className="text-xs uppercase tracking-wide text-text-muted">
                  {t('login.password')}
                </span>
                <div className="flex items-center gap-2">
                  <LockKeyhole className="size-4 text-text-muted" aria-hidden />
                  <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" />
                </div>
              </label>

              {auth.error && <ErrorNote message={auth.error} />}
              {auth.unverified && <UnverifiedNotice email={email.trim()} password={password} />}

              <Button
                type="submit"
                disabled={auth.submitting || email.trim().length === 0 || password.length === 0}
                className="w-full"
              >
                {auth.submitting ? t('login.signingIn') : t('login.signIn')}
              </Button>
              <button
                type="button"
                onClick={() => setForgotten(true)}
                className="w-full text-center text-xs text-accent hover:underline"
              >
                {t('login.forgotten')}
              </button>
            </form>
            <OAuthButtons />
            <button
              type="button"
              onClick={() => setJoining(true)}
              className="w-full text-center text-sm text-accent hover:underline"
            >
              {t('login.askToJoin')}
            </button>
          </>
        )}

        <Disclaimer />
      </div>
    </main>
  );
});

/**
 * A sign-up whose address was never confirmed (D306): only someone who typed
 * the right password sees this, and only they can ask for a new link - with
 * the same email and password, so the form to send mail is never open to an
 * address someone merely types.
 */
function UnverifiedNotice({ email, password }: { email: string; password: string }) {
  const { auth } = useStore();
  const { t } = useTranslation();
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const [failure, setFailure] = useState<string | null>(null);

  async function resend(): Promise<void> {
    setState('sending');
    try {
      await auth.resendVerification(email, password);
      setState('sent');
    } catch (caught) {
      setFailure(caught instanceof ApiRequestError && caught.code === RATE_LIMITED ? caught.message : null);
      setState('failed');
    }
  }

  return (
    <div role="status" className="space-y-2 rounded-lg border border-border-subtle bg-surface p-3 text-sm">
      <p>
        {t('login.unverified')}{' '}
        <bdi dir="ltr" className="font-medium">
          {email}
        </bdi>
      </p>
      {state === 'sent' ? (
        <p className="text-text-muted">{t('login.resent')}</p>
      ) : (
        <Button variant="secondary" disabled={state === 'sending'} onClick={() => void resend()}>
          {state === 'sending' ? t('login.resending') : t('login.resend')}
        </Button>
      )}
      {state === 'failed' && <ErrorNote message={failure ?? t('login.resendFailed')} />}
    </div>
  );
}
