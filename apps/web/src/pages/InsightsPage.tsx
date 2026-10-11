import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { Lightbulb } from 'lucide-react';

import type { AlertSource } from '@traders/shared';

import { AlertsList } from '../components/AlertsList.tsx';
import { DigestCard } from '../components/DigestCard.tsx';
import { Disclaimer } from '../components/Disclaimer.tsx';
import { ObservationsFeed } from '../components/ObservationsFeed.tsx';
import { ProposalsInbox } from '../components/ProposalsInbox.tsx';
import { useTranslation } from '../i18n/index.ts';
import { feedFiltersFrom } from '../lib/feedFilters.ts';
import { dayInWindow } from '../lib/insightsDays.ts';
import {
  INSIGHTS_TABS,
  alertSourceFrom,
  insightsTabFrom,
  type InsightsTab,
} from '../lib/insightsTab.ts';
import { unreadCount, useInsightsDaysQuery, useMarkInsightsSeen } from '../queries/insightsDays.ts';
import { openProposals, useProposalsQuery } from '../queries/proposals.ts';

/**
 * What the system noticed and what it asks, in one place (UX3, decision 134).
 *
 * Four tabs, each answering one question, so a proposal waiting for an answer
 * is never under a day of drawdowns: **Alerts** - what was I told; **Proposals**
 * - what do I owe an answer to, with a count; **Digest** - what the daily
 * summary carried; **All findings** - everything, filters and all.
 *
 * The tab and its filters live in the address
 * (`/insights?tab=alerts&source=agents`, `?tab=observations&severity=high`), so
 * a view can be reloaded and sent. Choosing one replaces the entry: it is a
 * view of this page, not a place, and Back leaves the page.
 *
 * **Unread** (decision 133): All findings opens on today and steps back through
 * seven days; findings written since the last visit are highlighted. Opening
 * All findings or Alerts marks them seen (the user, 2026-10-11) - but the
 * highlight is judged against `seenAt` as it was when the page opened, so it
 * lasts the visit and is gone on the next one.
 */
export function InsightsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ from: '/insights' });
  const tab = insightsTabFrom(search);
  const filters = feedFiltersFrom(search);
  const source = alertSourceFrom(search);
  // The count is the point of the Proposals tab: a question that expires
  // unanswered because nobody knew it was there is what the inbox exists to prevent.
  const openCount = openProposals(useProposalsQuery().data).length;

  const insightsDays = useInsightsDaysQuery();
  const span = insightsDays.data;
  const unread = unreadCount(span);
  // `seenAt` as the page found it, kept for the visit (see above). Undefined
  // until the first read answers, so nothing is styled on a guess.
  const [visitSeenAt, setVisitSeenAt] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (span !== undefined && visitSeenAt === undefined) setVisitSeenAt(span.seenAt);
  }, [span, visitSeenAt]);
  const markSeen = useMarkInsightsSeen();
  const marked = useRef<string | null>(null);
  const reading = tab === 'observations' || tab === 'alerts';
  useEffect(() => {
    // Once per count read: sends the moment the page counted, so a finding that
    // arrives while it is open stays unread.
    if (reading && span && unread > 0 && marked.current !== span.asOf) {
      marked.current = span.asOf;
      markSeen.mutate(span.asOf);
    }
  }, [reading, span, unread, markSeen]);
  const day = span ? dayInWindow(span.days, filters.day) : undefined;

  const show = (next: InsightsTab) =>
    void navigate({
      to: '/insights',
      // A tab's filters belong to it: another tab's address does not carry them.
      search:
        next === 'observations'
          ? { tab: next, ...filters }
          : next === 'alerts'
            ? { tab: next, source }
            : { tab: next },
      replace: true,
    });

  const showSource = (next: AlertSource | undefined) =>
    void navigate({ to: '/insights', search: { tab: 'alerts', source: next }, replace: true });

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <header className="flex items-center gap-2">
        <Lightbulb className="size-5 text-accent" aria-hidden />
        <h1 className="text-base font-semibold">{t('insights.title')}</h1>
      </header>

      <div role="tablist" className="flex gap-2 overflow-x-auto border-b border-border-subtle">
        {INSIGHTS_TABS.map((name) => (
          <button
            key={name}
            role="tab"
            type="button"
            aria-selected={tab === name}
            onClick={() => show(name)}
            className={`-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${
              tab === name ? 'border-accent text-text-primary' : 'border-transparent text-text-muted'
            }`}
          >
            {t(`insights.tabs.${name}`)}
            {name === 'proposals' && openCount > 0 && (
              <span className="rounded-full bg-accent/15 px-1.5 text-xs font-medium text-accent">
                {openCount}
              </span>
            )}
            {name === 'observations' && unread > 0 && (
              <span
                className="rounded-full bg-surface-hover px-1.5 text-xs font-medium text-text-primary"
                aria-label={t('feed.unreadCount', { count: unread })}
              >
                {unread}
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === 'alerts' && (
        <AlertsList source={source} onSourceChange={showSource} seenAt={visitSeenAt} />
      )}
      {tab === 'proposals' && <ProposalsInbox />}
      {tab === 'digest' && <DigestCard />}
      {tab === 'observations' && (
        <ObservationsFeed
          filters={{ ...filters, day }}
          days={span?.days ?? []}
          seenAt={visitSeenAt}
          onFiltersChange={(next) =>
            void navigate({
              to: '/insights',
              search: {
                tab: 'observations',
                severity: next.severity,
                symbol: next.symbol,
                day: next.day,
              },
              replace: true,
            })
          }
        />
      )}

      <Disclaimer />
    </div>
  );
}
