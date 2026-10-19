import { observer } from 'mobx-react-lite';
import { KeyRound } from 'lucide-react';

import { PasswordChange } from '../components/PasswordChange.tsx';
import { Button } from '../components/ui.tsx';
import { useTranslation } from '../i18n/index.ts';
import { useStore } from '../stores/context.tsx';

/**
 * The admin set a one-time password (D162): until it is changed the server
 * refuses everything else, so the app shows nothing else. Changing it brings
 * the app in its place.
 */
export const PasswordRequiredPage = observer(function PasswordRequiredPage() {
  const { auth } = useStore();
  const { t } = useTranslation();
  return (
    <main className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4">
        <div className="flex items-center gap-2">
          <KeyRound className="size-6 text-accent" aria-hidden />
          <h1 className="text-lg font-semibold">{t('password.requiredTitle')}</h1>
        </div>
        <p className="text-sm text-text-muted">{t('password.requiredIntro')}</p>
        <div className="rounded-xl border border-border-subtle bg-surface-raised p-4">
          <PasswordChange />
        </div>
        <Button variant="ghost" onClick={() => void auth.logout()}>
          {t('password.signOut')}
        </Button>
      </div>
    </main>
  );
});
