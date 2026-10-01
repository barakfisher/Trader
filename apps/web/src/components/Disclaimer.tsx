import { Info } from 'lucide-react';

import { useTranslation } from '../i18n/index.ts';

/**
 * Product stance P2 (PRD section 3): this system explains, it does not advise.
 * The disclaimer is part of the product, not boilerplate, so it is a component
 * rather than a string buried in a footer.
 */
export function Disclaimer() {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border-subtle bg-surface-raised/60 px-3 py-2 text-xs text-text-muted">
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p>{t('disclaimer')}</p>
    </div>
  );
}
