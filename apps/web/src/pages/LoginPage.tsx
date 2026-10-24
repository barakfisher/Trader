import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { AtSign, LineChart, LockKeyhole } from 'lucide-react';

import { Disclaimer } from '../components/Disclaimer.tsx';
import { PasswordInput } from '../components/PasswordInput.tsx';
import { SignupForm } from '../components/SignupForm.tsx';
import { Button, ErrorNote } from '../components/ui.tsx';
import { useTranslation } from '../i18n/index.ts';
import { useStore } from '../stores/context.tsx';

/** Email and password (D159), and asking to join (D156): the only page that works signed out. */
export const LoginPage = observer(function LoginPage() {
  const { auth } = useStore();
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [joining, setJoining] = useState(false);

  return (
    <main className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4">
        <div className="flex items-center gap-2">
          <LineChart className="size-6 text-accent" aria-hidden />
          <h1 className="text-lg font-semibold">{t('login.title')}</h1>
        </div>
        {joining ? (
          <SignupForm onBack={() => setJoining(false)} />
        ) : (
          <>
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

              <Button
                type="submit"
                disabled={auth.submitting || email.trim().length === 0 || password.length === 0}
                className="w-full"
              >
                {auth.submitting ? t('login.signingIn') : t('login.signIn')}
              </Button>
              <p className="text-xs text-text-muted">{t('login.forgotten')}</p>
            </form>
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
