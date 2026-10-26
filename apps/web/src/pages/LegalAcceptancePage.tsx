import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { FileText } from 'lucide-react';

import { LEGAL_DOCUMENTS } from '@traders/shared';

import { ApiRequestError } from '../api/client.ts';
import { AccountDeletionCard } from '../components/AccountDeletionCard.tsx';
import { AccountExportCard } from '../components/AccountExportCard.tsx';
import { Button, ErrorNote } from '../components/ui.tsx';
import { useTranslation } from '../i18n/index.ts';
import { legalPath } from '../legal/legalText.ts';
import { useStore } from '../stores/context.tsx';

/**
 * A version of the privacy policy and terms this account has not accepted
 * (D265) - a new one, or the first, for an account made through Google or
 * GitHub. The server refuses everything else until it is accepted, so the
 * app shows nothing else; but whoever declines can still take their data and
 * delete the account, or sign out.
 */
export const LegalAcceptancePage = observer(function LegalAcceptancePage({ version }: { version: string }) {
  const { auth } = useStore();
  const { t } = useTranslation();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept(): Promise<void> {
    setSending(true);
    setError(null);
    try {
      await auth.acceptLegal(version);
    } catch (caught) {
      setError(caught instanceof ApiRequestError && caught.code === 'legal_version_stale' ? t('legal.stale') : t('legal.acceptFailed'));
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="flex min-h-full items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-md space-y-4">
        <div className="flex items-center gap-2">
          <FileText className="size-6 text-accent" aria-hidden />
          <h1 className="text-lg font-semibold">{t('legal.acceptTitle')}</h1>
        </div>
        <section className="space-y-3 rounded-xl border border-border-subtle bg-surface-raised p-4">
          <p className="text-sm text-text-muted">{t('legal.acceptIntro', { version })}</p>
          <ul className="space-y-1 text-sm">
            {LEGAL_DOCUMENTS.map((document) => (
              <li key={document}>
                <a href={legalPath(document)} target="_blank" rel="noopener" className="text-accent hover:underline">
                  {t(`legal.${document}`)}
                </a>{' '}
                <span className="text-xs text-text-muted">({t('legal.opensInNewTab')})</span>
              </li>
            ))}
          </ul>
          {error && <ErrorNote message={error} />}
          <Button className="w-full" disabled={sending} onClick={() => void accept()}>
            {sending ? t('legal.accepting') : t('legal.accept')}
          </Button>
        </section>
        <details className="space-y-3">
          <summary className="cursor-pointer text-sm text-accent">{t('legal.declineTitle')}</summary>
          <div className="mt-3 space-y-3">
            <p className="text-sm text-text-muted">{t('legal.declineIntro')}</p>
            <AccountExportCard />
            <AccountDeletionCard />
          </div>
        </details>
        <Button variant="ghost" onClick={() => void auth.logout()}>
          {t('legal.signOut')}
        </Button>
      </div>
    </main>
  );
});
