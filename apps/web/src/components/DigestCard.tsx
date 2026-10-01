import { observer } from 'mobx-react-lite';

import type { DigestEntry } from '@traders/shared';

import { errorMessage } from '../api/client.ts';
import { useTranslation } from '../i18n/index.ts';
import { countText, findingsIn, reasonSummary, reasonText } from '../lib/digestPresentation.ts';
import { severityStyle, subjectLabel } from '../lib/observationPresentation.ts';
import { formatExactTime } from '../lib/relativeTime.ts';
import { SERVER_ENGLISH } from '../lib/textDirection.ts';
import { useDigestQuery } from '../queries/digest.ts';
import { Card, ErrorNote, Spinner } from './ui.tsx';

/** How many held-back headlines the card lists before "and N more". */
const SHOWN = 5;

/**
 * The daily digest on the dashboard (FR-13 - "to UI and Telegram").
 *
 * Every finding in a digest is already in the feed. What only the digest says
 * is which of them were *held back* from an interruption, and why - below your
 * alert threshold, during quiet hours, while muted - and that is what this card
 * shows: what the next digest will carry, and what the last one delivered.
 */
export const DigestCard = observer(function DigestCard() {
  const digest = useDigestQuery();
  const { t } = useTranslation();
  const data = digest.data;
  const next = findingsIn(data?.next.entries ?? []);
  const last = data?.last ?? null;
  const lastFindings = findingsIn(last?.entries ?? []);

  return (
    <Card title={t('digest.title')}>
      {digest.isPending && <Spinner label={t('digest.loading')} />}
      {digest.error && (
        <ErrorNote
          message={errorMessage(digest.error, t('digest.loadFailed'))}
          onRetry={() => void digest.refetch()}
        />
      )}
      {data && (
        <div className="space-y-3 text-sm">
          <p className="text-xs text-text-muted">
            {t('digest.intro')}
          </p>
          <div>
            <p className="font-medium">
              {next.length === 0
                ? t('digest.nothingWaiting')
                : t('digest.next', { findings: countText(next.length), reasons: reasonSummary(next) })}
            </p>
            {next.length > 0 && <EntryList entries={next} />}
          </div>
          <div className="border-t border-border-subtle pt-3">
            {last === null ? (
              <p className="text-text-muted">{t('digest.noneDelivered')}</p>
            ) : (
              <details>
                <summary className="cursor-pointer text-text-muted">
                  {t('digest.lastDelivered', {
                    when: formatExactTime(last.sentAt),
                    findings: countText(lastFindings.length),
                  })}
                  {lastFindings.length > 0 &&
                    t('digest.lastDeliveredReasons', { reasons: reasonSummary(lastFindings) })}
                </summary>
                <EntryList entries={lastFindings} />
              </details>
            )}
          </div>
        </div>
      )}
    </Card>
  );
});

function EntryList({ entries }: { entries: DigestEntry[] }) {
  const { t } = useTranslation();
  const shown = entries.slice(0, SHOWN);
  return (
    <ul className="mt-2 space-y-1.5">
      {shown.map((entry, index) => {
        const severity = entry.severity ? severityStyle(entry.severity) : null;
        return (
          <li key={`${entry.observationId}-${index}`} className="flex flex-wrap items-baseline gap-x-2 text-xs">
            {severity && (
              <span className={`rounded px-1.5 py-0.5 text-[10px] ${severity.chipClassName}`}>
                {severity.label}
              </span>
            )}
            {entry.subjectRef && (
              <span className="font-medium text-text-primary">{subjectLabel(entry.subjectRef)}</span>
            )}
            <span {...SERVER_ENGLISH} className="text-text-primary">{entry.headline}</span>
            <span className="text-text-muted">· {reasonText(entry.reason)}</span>
          </li>
        );
      })}
      {entries.length > SHOWN && (
        <li className="text-xs text-text-muted">{t('digest.more', { count: entries.length - SHOWN })}</li>
      )}
    </ul>
  );
}
