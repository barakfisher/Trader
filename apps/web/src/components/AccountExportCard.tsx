import { Download } from 'lucide-react';

import { errorMessage } from '../api/client.ts';
import { useTranslation } from '../i18n/index.ts';
import { useExportAccount } from '../queries/accountDeletion.ts';
import { Button, Card, ErrorNote } from './ui.tsx';

/** Settings: the account's own rows as one JSON file (D264), what is in it and what never is. */
export function AccountExportCard() {
  const { t } = useTranslation();
  const exported = useExportAccount();
  return (
    <Card title={t('accountDeletion.dataTitle')}>
      <div className="space-y-3 text-sm">
        <p className="max-w-2xl">{t('accountDeletion.exportIntro')}</p>
        <Button variant="secondary" disabled={exported.isPending} onClick={() => exported.mutate()}>
          <span className="flex items-center gap-1">
            <Download className="size-4" aria-hidden />
            {exported.isPending ? t('accountDeletion.exporting') : t('accountDeletion.exportButton')}
          </span>
        </Button>
        {exported.error && <ErrorNote message={errorMessage(exported.error, t('accountDeletion.exportFailed'))} />}
      </div>
    </Card>
  );
}
