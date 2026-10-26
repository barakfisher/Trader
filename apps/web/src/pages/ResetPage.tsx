import { useEffect, useState } from 'react';
import { LineChart, LockKeyhole } from 'lucide-react';

import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordProblem,
  type ResetPasswordResponse,
} from '@traders/shared';

import { ApiRequestError, api } from '../api/client.ts';
import { Disclaimer } from '../components/Disclaimer.tsx';
import { PasswordInput } from '../components/PasswordInput.tsx';
import { Button, ErrorNote } from '../components/ui.tsx';
import { useTranslation } from '../i18n/index.ts';

/** The page a reset link opens (D260); outside the router, so it works signed out. */
export const RESET_PATH = '/reset';

type Outcome = ResetPasswordResponse['outcome'];

function tokenFromAddress(): string | null {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  return token && token.length > 0 ? token : null;
}

/**
 * Choose a new password from a mailed link (D260, D312). The token leaves the
 * address bar at once and is sent only with the new password, so a mail
 * scanner opening the link changes nothing. Success signs nobody in: every
 * session has ended, and the person signs in with the new password.
 */
export function ResetPage() {
  const { t } = useTranslation();
  const [token] = useState(tokenFromAddress);
  const [outcome, setOutcome] = useState<Outcome | null>(token === null ? 'invalid' : null);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const limits = { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH };

  useEffect(() => {
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  async function submit(): Promise<void> {
    if (token === null || sending) return;
    const problem = passwordProblem(password);
    if (problem === 'too_short') return setError(t('password.errors.tooShort', limits));
    if (problem === 'too_long') return setError(t('password.errors.tooLong', limits));
    if (password !== repeat) return setError(t('password.errors.mismatch'));
    setError(null);
    setSending(true);
    try {
      setOutcome((await api.post<ResetPasswordResponse>('/auth/reset', { token, newPassword: password })).outcome);
    } catch (caught) {
      setError(caught instanceof ApiRequestError && caught.code === 'password_too_short' ? t('password.errors.tooShort', limits) : t('reset.failed'));
    } finally {
      setSending(false);
    }
  }

  const passwordField = (label: string, value: string, set: (value: string) => void) => (
    <label className="block space-y-1">
      <span className="text-xs uppercase tracking-wide text-text-muted">{label}</span>
      <div className="flex items-center gap-2">
        <LockKeyhole className="size-4 text-text-muted" aria-hidden />
        <PasswordInput value={value} onChange={set} autoComplete="new-password" />
      </div>
    </label>
  );

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
              void submit();
            }}
            className="space-y-3 rounded-xl border border-border-subtle bg-surface-raised p-4"
          >
            <h2 className="font-semibold">{t('reset.chooseTitle')}</h2>
            <p className="text-sm text-text-muted">{t('reset.chooseIntro')}</p>
            {passwordField(t('password.new'), password, setPassword)}
            {passwordField(t('password.repeat'), repeat, setRepeat)}
            <p className="text-xs text-text-muted">{t('password.rule', limits)}</p>
            {error && <ErrorNote message={error} />}
            <Button type="submit" className="w-full" disabled={sending || password.length === 0}>
              {sending ? t('reset.saving') : t('reset.save')}
            </Button>
          </form>
        ) : (
          <section role="status" className="space-y-3 rounded-xl border border-border-subtle bg-surface-raised p-4">
            <h2 className="font-semibold">{t(`reset.outcomes.${outcome}.title`)}</h2>
            <p className="text-sm text-text-muted">{t(`reset.outcomes.${outcome}.body`)}</p>
            <Button className="w-full" onClick={() => window.location.assign('/')}>
              {t('verify.toSignIn')}
            </Button>
          </section>
        )}
        <Disclaimer />
      </div>
    </main>
  );
}
