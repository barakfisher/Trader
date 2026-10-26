import { observer } from 'mobx-react-lite';
import { CalendarX } from 'lucide-react';

import { Button } from '../components/ui.tsx';
import { formatDate } from '../i18n/format.ts';
import { useTranslation } from '../i18n/index.ts';
import { useStore } from '../stores/context.tsx';

/**
 * Shown in place of the sign-in page right after the account was closed (D264):
 * it is disabled now, the day it will be permanently deleted - in the account's
 * own zone, the day the email names too - and that signing in before then
 * restores it.
 */
export const AccountClosedPage = observer(function AccountClosedPage() {
  const { auth } = useStore();
  const { t } = useTranslation();
  const closed = auth.closed;
  if (closed === null) return null;
  const date = formatDate(new Date(closed.deletionDueAt), {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: closed.timeZone,
  });
  return (
    <main className="flex min-h-full items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-md space-y-4" role="status">
        <div className="flex items-center gap-2">
          <CalendarX className="size-6 text-loss" aria-hidden />
          <h1 className="text-lg font-semibold">{t('accountDeletion.closedTitle')}</h1>
        </div>
        <p className="text-sm">{t('accountDeletion.closedBody', { date })}</p>
        <p className="text-sm">{t('accountDeletion.closedRestore')}</p>
        <p className="text-sm text-text-muted">{t('accountDeletion.closedEmail')}</p>
        <Button variant="secondary" onClick={auth.leaveClosedScreen}>
          {t('accountDeletion.closedSignIn')}
        </Button>
      </div>
    </main>
  );
});
