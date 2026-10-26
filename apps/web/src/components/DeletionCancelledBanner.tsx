import { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';

import { useTranslation } from '../i18n/index.ts';
import { useStore } from '../stores/context.tsx';
import { Button } from './ui.tsx';

/**
 * Once, after a sign-in that cancelled the account's pending deletion (D264):
 * by password (the sign-in's answer says so) or through Google or GitHub (the
 * callback lands on `?oauth=restored`).
 */
export const DeletionCancelledBanner = observer(function DeletionCancelledBanner() {
  const { auth } = useStore();
  const { t } = useTranslation();
  // Only this outcome is taken out of the address: the others are the sign-in
  // and Settings pages' to read (`useOAuthOutcome`), and this banner sits above both.
  const [restored] = useState(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('oauth') !== 'restored') return false;
    url.searchParams.delete('oauth');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    return true;
  });
  useEffect(() => {
    if (restored) auth.noteDeletionCancelled();
  }, [auth, restored]);
  if (!auth.deletionCancelled) return null;
  return (
    <div role="status" className="mx-auto mt-3 flex max-w-4xl flex-wrap items-center justify-between gap-2 rounded-lg border border-gain/40 bg-gain/10 px-4 py-2 text-sm">
      <span>{t('accountDeletion.cancelledBanner')}</span>
      <Button variant="ghost" onClick={auth.dismissDeletionCancelled}>
        {t('common.close')}
      </Button>
    </div>
  );
});
