import { useNavigate, useSearch } from '@tanstack/react-router';
import { Lightbulb } from 'lucide-react';

import { DigestCard } from '../components/DigestCard.tsx';
import { Disclaimer } from '../components/Disclaimer.tsx';
import { ObservationsFeed } from '../components/ObservationsFeed.tsx';
import { useTranslation } from '../i18n/index.ts';
import { feedFiltersFrom } from '../lib/feedFilters.ts';
import { insightsTabFrom, type InsightsTab } from '../lib/insightsTab.ts';

/**
 * What the system noticed, in one place (UX3): the observations feed and the
 * daily digest, each a tab. Both used to sit under the portfolio, where a quiet
 * day's empty feed took a screen to say so and the dashboard grew a card per
 * feature; the dashboard is the portfolio now, and this page is one slot in the
 * bar instead of two.
 *
 * The tab and the feed's filters live in the address
 * (`/insights?tab=observations&severity=high&symbol=NVDA`), so a view can be
 * reloaded and sent. Choosing one replaces the entry: it is a view of this
 * page, not a place, and Back leaves the page.
 */
export function InsightsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ from: '/insights' });
  const tab = insightsTabFrom(search);
  const filters = feedFiltersFrom(search);

  const show = (next: InsightsTab) =>
    void navigate({
      to: '/insights',
      // Filters belong to the feed: the digest's address does not carry them.
      search: next === 'observations' ? { tab: next, ...filters } : { tab: next },
      replace: true,
    });

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <header className="flex items-center gap-2">
        <Lightbulb className="size-5 text-accent" aria-hidden />
        <h1 className="text-base font-semibold">{t('insights.title')}</h1>
      </header>

      <div role="tablist" className="flex gap-2 border-b border-border-subtle">
        {(['observations', 'digest'] as const).map((name) => (
          <button
            key={name}
            role="tab"
            type="button"
            aria-selected={tab === name}
            onClick={() => show(name)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              tab === name ? 'border-accent text-text-primary' : 'border-transparent text-text-muted'
            }`}
          >
            {t(`insights.tabs.${name}`)}
          </button>
        ))}
      </div>

      {tab === 'observations' && (
        <ObservationsFeed
          filters={filters}
          onFiltersChange={(next) =>
            void navigate({
              to: '/insights',
              search: { tab: 'observations', severity: next.severity, symbol: next.symbol },
              replace: true,
            })
          }
        />
      )}
      {tab === 'digest' && <DigestCard />}

      <Disclaimer />
    </div>
  );
}
