import { Info } from 'lucide-react';

import { LEGAL_DOCUMENTS } from '@traders/shared';

import { useTranslation } from '../i18n/index.ts';
import { legalPath } from '../legal/legalText.ts';

/**
 * Product stance P2 (PRD section 3): this system explains, it does not advise.
 * The disclaimer is part of the product, not boilerplate, so it is a component
 * rather than a string buried in a footer. It carries the links to the
 * privacy policy and terms (D265), so they are a click away on every page,
 * signed in or out.
 */
export function Disclaimer() {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border-subtle bg-surface-raised/60 px-3 py-2 text-xs text-text-muted">
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="space-y-1">
        <p>{t('disclaimer')}</p>
        <p className="flex flex-wrap gap-x-3">
          {LEGAL_DOCUMENTS.map((document) => (
            <a key={document} href={legalPath(document)} className="text-accent hover:underline">
              {t(`legal.${document}`)}
            </a>
          ))}
        </p>
      </div>
    </div>
  );
}
