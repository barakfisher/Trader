import { observer } from 'mobx-react-lite';

import type { DigestEntry } from '@traders/shared';

import { errorMessage } from '../api/client.ts';
import { countText, findingsIn, reasonSummary, reasonText } from '../lib/digestPresentation.ts';
import { severityStyle, subjectLabel } from '../lib/observationPresentation.ts';
import { formatExactTime } from '../lib/relativeTime.ts';
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
  const data = digest.data;
  const next = findingsIn(data?.next.entries ?? []);
  const last = data?.last ?? null;
  const lastFindings = findingsIn(last?.entries ?? []);

  return (
    <Card title="Daily digest">
      {digest.isPending && <Spinner label="Loading the digest…" />}
      {digest.error && (
        <ErrorNote
          message={errorMessage(digest.error, 'Could not load the digest.')}
          onRetry={() => void digest.refetch()}
        />
      )}
      {data && (
        <div className="space-y-3 text-sm">
          <p className="text-xs text-text-muted">
            Findings above your alert threshold are pushed when found. The rest wait for the daily
            digest - here and in Telegram.
          </p>
          <div>
            <p className="font-medium">
              {next.length === 0
                ? 'Nothing is waiting for the next digest.'
                : `Next digest: ${countText(next.length)} - ${reasonSummary(next)}.`}
            </p>
            {next.length > 0 && <EntryList entries={next} />}
          </div>
          <div className="border-t border-border-subtle pt-3">
            {last === null ? (
              <p className="text-text-muted">No digest has been delivered yet.</p>
            ) : (
              <details>
                <summary className="cursor-pointer text-text-muted">
                  Last delivered {formatExactTime(last.sentAt)}: {countText(lastFindings.length)}
                  {lastFindings.length > 0 && ` - ${reasonSummary(lastFindings)}`}
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
            <span className="text-text-primary">{entry.headline}</span>
            <span className="text-text-muted">· {reasonText(entry.reason)}</span>
          </li>
        );
      })}
      {entries.length > SHOWN && (
        <li className="text-xs text-text-muted">and {entries.length - SHOWN} more, all in the feed below.</li>
      )}
    </ul>
  );
}
