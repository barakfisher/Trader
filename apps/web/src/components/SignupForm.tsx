import { useState } from 'react';
import { AtSign, LockKeyhole } from 'lucide-react';

import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  emailProblem,
  normaliseEmail,
  passwordProblem,
  type SignupInput,
  type SignupResponse,
} from '@traders/shared';

import { ApiRequestError, api } from '../api/client.ts';
import { currentLanguage, useTranslation } from '../i18n/index.ts';
import { PasswordInput } from './PasswordInput.tsx';
import { Button, ErrorNote } from './ui.tsx';

/** The browser's zone (D163): what "today" and quiet hours will mean for this account. */
function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Ask to join (D156). Every answer but a refused field is one of two
 * (D185): received - whatever the email already was - or closed. Whoever asks
 * learns where they stand by signing in once the admin has decided (D187).
 * The rules are the server's own (`@traders/shared`), checked here first only
 * so the sentence arrives before a round trip.
 */
export function SignupForm({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<SignupResponse['outcome'] | null>(null);
  const timezone = browserTimeZone();
  const limits = { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH };

  function refusal(caught: unknown): string {
    if (!(caught instanceof ApiRequestError)) return t('signup.errors.failed');
    switch (caught.code) {
      case 'email_invalid':
      case 'email_too_long':
        return t('email.errors.invalid');
      case 'password_too_short':
        return t('password.errors.tooShort', limits);
      case 'password_too_long':
        return t('password.errors.tooLong', limits);
      case 'timezone_invalid':
        return t('signup.errors.timezoneInvalid', { zone: timezone });
      default:
        return t('signup.errors.failed');
    }
  }

  async function submit(): Promise<void> {
    if (emailProblem(normaliseEmail(email)) !== null) return setError(t('email.errors.invalid'));
    const problem = passwordProblem(password);
    if (problem === 'too_short') return setError(t('password.errors.tooShort', limits));
    if (problem === 'too_long') return setError(t('password.errors.tooLong', limits));
    if (password !== repeat) return setError(t('signup.errors.mismatch'));
    setError(null);
    setSubmitting(true);
    try {
      const input: SignupInput = { email: email.trim(), password, timezone, language: currentLanguage() };
      setOutcome((await api.post<SignupResponse>('/auth/signup', input)).outcome);
    } catch (caught) {
      setError(refusal(caught));
    } finally {
      setSubmitting(false);
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

  if (outcome !== null) {
    return (
      <div role="status" className="space-y-3 rounded-xl border border-border-subtle bg-surface-raised p-4">
        <h2 className="font-semibold">{t(outcome === 'received' ? 'signup.receivedTitle' : 'signup.closedTitle')}</h2>
        <p className="text-sm text-text-muted">{t(outcome === 'received' ? 'signup.received' : 'signup.closed')}</p>
        <Button onClick={onBack} className="w-full">
          {t('signup.backToSignIn')}
        </Button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      // Our sentences, in the reader's language, rather than the browser's own for type="email".
      noValidate
      className="space-y-3 rounded-xl border border-border-subtle bg-surface-raised p-4"
    >
      <h2 className="font-semibold">{t('signup.title')}</h2>
      <p className="text-sm text-text-muted">{t('signup.intro')}</p>

      <label className="block space-y-1">
        <span className="text-xs uppercase tracking-wide text-text-muted">{t('login.email')}</span>
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

      {passwordField(t('login.password'), password, setPassword)}
      {passwordField(t('signup.repeat'), repeat, setRepeat)}
      <p className="text-xs text-text-muted">{t('password.rule', limits)}</p>
      <p className="text-xs text-text-muted">
        {t('signup.timezone')} <bdi dir="ltr">{timezone}</bdi>
      </p>

      {error && <ErrorNote message={error} />}

      <Button
        type="submit"
        disabled={submitting || email.trim().length === 0 || password.length === 0 || repeat.length === 0}
        className="w-full"
      >
        {submitting ? t('signup.submitting') : t('signup.submit')}
      </Button>
      <button type="button" onClick={onBack} className="w-full text-center text-xs text-accent hover:underline">
        {t('signup.backToSignIn')}
      </button>
    </form>
  );
}
