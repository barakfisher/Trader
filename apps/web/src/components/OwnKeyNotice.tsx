import { Link } from '@tanstack/react-router';
import { KeyRound } from 'lucide-react';

import { useTranslation } from '../i18n/index.ts';
import { formatResetDate } from '../lib/monthlyCap.ts';
import type { ModelAccess } from '../queries/modelAccess.ts';

/**
 * What stops the user's model calls, said where they would be made (D245, D275):
 * no key of their own, one OpenRouter refused, an installation that cannot use
 * keys, or their safety limit spent - each with the way out, in Settings.
 * Nothing when nothing stops them; the admin never sees it.
 */
export function OwnKeyNotice({ access }: { access: ModelAccess }) {
  const { t } = useTranslation();
  if (access.block === null) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-start gap-x-3 gap-y-1 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn"
    >
      <KeyRound className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">
        {t(`ownKeyNotice.${access.block}`, { date: access.resetsOn ? formatResetDate(access.resetsOn) : '' })}
      </p>
      {access.block !== 'unavailable' && (
        <Link to="/settings" className="font-medium text-accent hover:underline">
          {t('ownKeyNotice.openSettings')}
        </Link>
      )}
    </div>
  );
}
