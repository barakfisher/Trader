import { useState } from 'react';
import { observer } from 'mobx-react-lite';

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordProblem } from '@traders/shared';

import { ApiRequestError } from '../api/client.ts';
import { useTranslation } from '../i18n/index.ts';
import { useStore } from '../stores/context.tsx';
import { PasswordInput } from './PasswordInput.tsx';
import { Button, ErrorNote } from './ui.tsx';

/**
 * Change this account's password: the current one, the new one twice. Used by
 * Settings and by the one-time password screen (D162). The length rule is the
 * server's own (`@traders/shared`, D181), checked here first only so the
 * sentence arrives before a round trip.
 */
export const PasswordChange = observer(function PasswordChange({
  onChanged,
}: {
  onChanged?: () => void;
}) {
  const { auth } = useStore();
  const { t } = useTranslation();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const limits = { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH };

  /** The server's refusal as a sentence, by its code. */
  function refusal(caught: unknown): string {
    if (!(caught instanceof ApiRequestError)) return t('password.errors.failed');
    switch (caught.code) {
      case 'incorrect_password':
        return t('password.errors.incorrect');
      case 'password_too_short':
        return t('password.errors.tooShort', limits);
      case 'password_too_long':
        return t('password.errors.tooLong', limits);
      case 'password_unchanged':
        return t('password.errors.unchanged');
      default:
        return t('password.errors.failed');
    }
  }

  async function submit(): Promise<void> {
    setDone(false);
    const problem = passwordProblem(next);
    if (problem === 'too_short') return setError(t('password.errors.tooShort', limits));
    if (problem === 'too_long') return setError(t('password.errors.tooLong', limits));
    if (next !== repeat) return setError(t('password.errors.mismatch'));
    setError(null);
    setSubmitting(true);
    try {
      await auth.changePassword(current, next);
      setCurrent('');
      setNext('');
      setRepeat('');
      setDone(true);
      onChanged?.();
    } catch (caught) {
      setError(refusal(caught));
    } finally {
      setSubmitting(false);
    }
  }

  const field = (label: string, value: string, set: (value: string) => void, autoComplete: 'current-password' | 'new-password') => (
    <label className="block space-y-1">
      <span className="text-xs uppercase tracking-wide text-text-muted">{label}</span>
      <PasswordInput value={value} onChange={set} autoComplete={autoComplete} />
    </label>
  );

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="max-w-sm space-y-3"
    >
      {field(t('password.current'), current, setCurrent, 'current-password')}
      {field(t('password.new'), next, setNext, 'new-password')}
      {field(t('password.repeat'), repeat, setRepeat, 'new-password')}
      <p className="text-xs text-text-muted">{t('password.rule', limits)}</p>

      {error && <ErrorNote message={error} />}
      {done && <p className="text-sm text-text-muted">{t('password.changed')}</p>}

      <Button
        type="submit"
        disabled={submitting || current.length === 0 || next.length === 0 || repeat.length === 0}
      >
        {submitting ? t('password.saving') : t('password.save')}
      </Button>
    </form>
  );
});
