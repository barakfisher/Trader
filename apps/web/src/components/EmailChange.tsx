import { useState } from 'react';
import { observer } from 'mobx-react-lite';

import { EMAIL_MAX_LENGTH, emailProblem, normaliseEmail } from '@traders/shared';

import { ApiRequestError } from '../api/client.ts';
import { useTranslation } from '../i18n/index.ts';
import { useStore } from '../stores/context.tsx';
import { PasswordInput } from './PasswordInput.tsx';
import { Button, ErrorNote } from './ui.tsx';

/**
 * Change the address this account signs in with: the new one and the current
 * password. Nothing is sent to it - there is no outbound email before M10 - so
 * the form says what it is now, and a typo is fixed here the same way. The
 * address rule is the server's own (`@traders/shared`), checked here first only
 * so the sentence arrives before a round trip.
 */
export const EmailChange = observer(function EmailChange() {
  const { auth } = useStore();
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  /** The server's refusal as a sentence, by its code. */
  function refusal(caught: unknown): string {
    if (!(caught instanceof ApiRequestError)) return t('email.errors.failed');
    switch (caught.code) {
      case 'incorrect_password':
        return t('email.errors.incorrect');
      case 'email_invalid':
        return t('email.errors.invalid');
      case 'email_too_long':
        return t('email.errors.tooLong', { max: EMAIL_MAX_LENGTH });
      case 'email_unchanged':
        return t('email.errors.unchanged');
      case 'email_taken':
        return t('email.errors.taken');
      default:
        return t('email.errors.failed');
    }
  }

  async function submit(): Promise<void> {
    setDone(false);
    const normalised = normaliseEmail(email);
    const problem = emailProblem(normalised);
    if (problem === 'invalid') return setError(t('email.errors.invalid'));
    if (problem === 'too_long') return setError(t('email.errors.tooLong', { max: EMAIL_MAX_LENGTH }));
    if (normalised === auth.user?.email?.toLowerCase()) return setError(t('email.errors.unchanged'));
    setError(null);
    setSubmitting(true);
    try {
      await auth.changeEmail(normalised, password);
      setEmail('');
      setPassword('');
      setDone(true);
    } catch (caught) {
      setError(refusal(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      // Our sentences, in the reader's language, rather than the browser's own for type="email".
      noValidate
      className="max-w-sm space-y-3"
    >
      <p className="text-sm">
        <span className="text-text-muted">{t('email.current')} </span>
        {auth.user?.email ? (
          <bdi dir="ltr" className="font-medium">
            {auth.user.email}
          </bdi>
        ) : (
          <span className="text-text-muted">{t('email.none')}</span>
        )}
      </p>
      <label className="block space-y-1">
        <span className="text-xs uppercase tracking-wide text-text-muted">{t('email.new')}</span>
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          dir="ltr"
          className="input text-start"
        />
      </label>
      <label className="block space-y-1">
        <span className="text-xs uppercase tracking-wide text-text-muted">{t('email.password')}</span>
        <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" />
      </label>
      <p className="text-xs text-text-muted">{t('email.note')}</p>

      {error && <ErrorNote message={error} />}
      {done && <p className="text-sm text-text-muted">{t('email.changed')}</p>}

      <Button type="submit" disabled={submitting || email.trim().length === 0 || password.length === 0}>
        {submitting ? t('email.saving') : t('email.save')}
      </Button>
    </form>
  );
});
