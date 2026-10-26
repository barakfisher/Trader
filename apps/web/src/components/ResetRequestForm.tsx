import { useState } from 'react';
import { AtSign } from 'lucide-react';

import { emailProblem, normaliseEmail } from '@traders/shared';

import { ApiRequestError, RATE_LIMITED, api } from '../api/client.ts';
import { useTranslation } from '../i18n/index.ts';
import { Button, ErrorNote } from './ui.tsx';

/**
 * Ask for a reset link (D260, D312). The answer is the same whatever the
 * address (D185), so the page says "if an account uses it" rather than
 * "sent": it cannot know, and must not say.
 */
export function ResetRequestForm({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(): Promise<void> {
    if (emailProblem(normaliseEmail(email)) !== null) return setError(t('email.errors.invalid'));
    setError(null);
    setSubmitting(true);
    try {
      await api.post('/auth/reset/request', { email: email.trim() });
      setSent(true);
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.code === RATE_LIMITED) setError(caught.message);
      else if (caught instanceof ApiRequestError && caught.code === 'email_unavailable') setError(t('reset.noEmail'));
      else setError(t('reset.requestFailed'));
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <div role="status" className="space-y-3 rounded-xl border border-border-subtle bg-surface-raised p-4">
        <h2 className="font-semibold">{t('reset.sentTitle')}</h2>
        <p className="text-sm text-text-muted">{t('reset.sent')}</p>
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
      noValidate
      className="space-y-3 rounded-xl border border-border-subtle bg-surface-raised p-4"
    >
      <h2 className="font-semibold">{t('reset.requestTitle')}</h2>
      <p className="text-sm text-text-muted">{t('reset.requestIntro')}</p>
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
      {error && <ErrorNote message={error} />}
      <Button type="submit" disabled={submitting || email.trim().length === 0} className="w-full">
        {submitting ? t('reset.requesting') : t('reset.request')}
      </Button>
      <button type="button" onClick={onBack} className="w-full text-center text-sm text-accent hover:underline">
        {t('signup.backToSignIn')}
      </button>
    </form>
  );
}
