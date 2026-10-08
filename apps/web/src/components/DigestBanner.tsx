import { Link } from '@tanstack/react-router';
import { Newspaper, X } from 'lucide-react';

import { useTranslation } from '../i18n/index.ts';
import { countText, findingsIn } from '../lib/digestPresentation.ts';
import { formatAge, formatExactTime } from '../lib/relativeTime.ts';
import { useDigestQuery, useMarkDigestSeen } from '../queries/digest.ts';

/**
 * "Your daily digest is ready" at the top of the dashboard, until the user has
 * seen that digest - opened it on the Insights page, or dismissed this (UX4).
 *
 * A banner rather than a dialog on entry: a dialog every morning gets closed
 * unread. And "seen" is the server's (`digest_seen_at`), not this browser's,
 * so a digest read on the phone is not announced again on the laptop.
 *
 * Opening it needs no call of its own: the Digest tab marks what it shows as
 * seen, so a digest reached any other way ends its banner too.
 */
export function DigestBanner() {
  const { t } = useTranslation();
  const last = useDigestQuery().data?.last ?? null;
  const markSeen = useMarkDigestSeen();
  if (last === null || last.seen) return null;

  const findings = findingsIn(last.entries).length;
  const age = formatAge(last.sentAt);
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-accent/40 bg-accent/10 px-4 py-3 text-sm"
    >
      <p className="flex items-center gap-2">
        <Newspaper className="size-4 shrink-0 text-accent" aria-hidden />
        <span title={formatExactTime(last.sentAt)}>
          {findings > 0
            ? t('digest.banner.ready', { findings: countText(findings), age })
            : t('digest.banner.readyNoFindings', { age })}
        </span>
      </p>
      <div className="flex items-center gap-1">
        <Link
          to="/insights"
          search={{ tab: 'digest' }}
          className="rounded-lg px-3 py-1 font-medium text-accent hover:bg-accent/10"
        >
          {t('digest.banner.open')}
        </Link>
        <button
          type="button"
          onClick={() => markSeen.mutate(last.sentAt)}
          aria-label={t('digest.banner.dismiss')}
          title={t('digest.banner.dismiss')}
          className="rounded-lg p-1 text-text-muted hover:bg-surface-hover hover:text-text-primary"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
