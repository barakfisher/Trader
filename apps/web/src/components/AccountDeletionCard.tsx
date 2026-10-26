import { useState } from 'react';
import { observer } from 'mobx-react-lite';

import { ACCOUNT_DELETION_CONFIRMATION } from '@traders/shared';

import { ApiRequestError, errorMessage } from '../api/client.ts';
import { useTranslation } from '../i18n/index.ts';
import { useAccountDeletionCheck } from '../queries/accountDeletion.ts';
import { useStore } from '../stores/context.tsx';
import { Button, Card, ErrorNote, Spinner } from './ui.tsx';

/**
 * Settings: delete the account (D264). What closes now and what is deleted
 * later are written above the button; the typed word is the same in every
 * language, as the reset's is, and the password - or, for an account that
 * only signs in through Google or GitHub, a sign-in moments ago - confirms it
 * is the owner. The server checks all of it again.
 */
export const AccountDeletionCard = observer(function AccountDeletionCard() {
  const { auth } = useStore();
  const { t } = useTranslation();
  const check = useAccountDeletionCheck();
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (check.isPending) return null;
  if (check.isError) {
    return (
      <Card title={t('accountDeletion.title')} className="border-loss/40">
        <ErrorNote message={errorMessage(check.error, t('accountDeletion.loadFailed'))} onRetry={() => void check.refetch()} />
      </Card>
    );
  }
  const rules = check.data;
  const withPassword = rules.confirmWith === 'password';
  const confirmed = withPassword ? password.length > 0 : rules.recentSignIn;
  const ready = rules.allowed && typed === ACCOUNT_DELETION_CONFIRMATION && confirmed && !submitting;

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await auth.deleteAccount({ confirm: typed, ...(withPassword ? { password } : {}) });
    } catch (failure) {
      setError(
        failure instanceof ApiRequestError && failure.code === 'incorrect_password'
          ? t('accountDeletion.incorrectPassword')
          : errorMessage(failure, t('accountDeletion.failed')),
      );
      setPassword('');
      // A sign-in that stopped counting as recent while the form was open.
      void check.refetch();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card title={t('accountDeletion.title')} className="border-loss/40">
      <div className="space-y-3 text-sm">
        <p className="max-w-2xl">{t('accountDeletion.intro', { count: rules.graceDays })}</p>
        <p className="max-w-2xl text-text-muted">{t('accountDeletion.erases')}</p>
        <p className="max-w-2xl text-text-muted">{t('accountDeletion.exportFirst')}</p>
        {!rules.allowed ? (
          <p className="text-text-muted">{t('accountDeletion.adminNotAllowed')}</p>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (ready) void submit();
            }}
          >
            <label className="block space-y-1">
              <span>{t('accountDeletion.confirmLabel', { word: ACCOUNT_DELETION_CONFIRMATION })}</span>
              <input
                className="input max-w-48"
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
              />
            </label>
            {withPassword ? (
              <label className="block space-y-1">
                <span>{t('accountDeletion.passwordLabel')}</span>
                <input
                  className="input max-w-72"
                  type="password"
                  dir="ltr"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
            ) : (
              <p className={rules.recentSignIn ? 'text-text-muted' : 'text-warn'}>
                {rules.recentSignIn
                  ? t('accountDeletion.signedInRecently')
                  : t('accountDeletion.signInAgain', { count: rules.recentSignInMinutes })}
              </p>
            )}
            <Button type="submit" variant="danger" disabled={!ready}>
              {t('accountDeletion.submit')}
            </Button>
            {submitting && <Spinner label={t('accountDeletion.deleting')} />}
            {error && <ErrorNote message={error} />}
          </form>
        )}
      </div>
    </Card>
  );
});
