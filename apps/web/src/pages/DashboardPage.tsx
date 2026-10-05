import { observer } from 'mobx-react-lite';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  Bot,
  FileUp,
  Inbox,
  LineChart,
  LogOut,
  MessageCircleQuestion,
  RefreshCw,
  Settings,
  ShieldCheck,
  Tags,
  Target,
} from 'lucide-react';

import { AddHoldingForm } from '../components/AddHoldingForm.tsx';
import { AllocationChart } from '../components/AllocationChart.tsx';
import { EquityCurve } from '../components/EquityCurve.tsx';
import { Disclaimer } from '../components/Disclaimer.tsx';
import { HoldingsTable } from '../components/HoldingsTable.tsx';
import { ImportWizard } from '../components/ImportWizard.tsx';
import { NarrationBadge } from '../components/NarrationBadge.tsx';
import { DigestCard } from '../components/DigestCard.tsx';
import { ObservationsFeed } from '../components/ObservationsFeed.tsx';
import { SummaryCards } from '../components/SummaryCards.tsx';
import { Button, EmptyState, ErrorNote, Spinner, buttonClass } from '../components/ui.tsx';
import { errorMessage } from '../api/client.ts';
import { useTranslation } from '../i18n/index.ts';
import { hasStaleQuotes, pricesAsOf } from '../lib/portfolioView.ts';
import { formatAge, formatClockTime, formatExactTime } from '../lib/relativeTime.ts';
import { feedFiltersFrom } from '../lib/feedFilters.ts';
import { usePortfolioQuery } from '../queries/portfolio.ts';
import { openProposals, useProposalsQuery } from '../queries/proposals.ts';
import { queryKeys } from '../queries/queryKeys.ts';
import { useStore } from '../stores/context.tsx';

export const DashboardPage = observer(function DashboardPage() {
  const {
    auth,
    import: importStore,
    queryClient,
  } = useStore();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const portfolio = usePortfolioQuery();
  // The feed's filters live in the address (`/?severity=high&symbol=NVDA`), so
  // a filtered view survives a reload and can be sent. Read loosely: this page
  // also renders for unknown addresses, where the '/' route is not matched.
  const feedFilters = feedFiltersFrom(useSearch({ strict: false }));
  // Read here, not only in the inbox: the badge in the header is how a user
  // learns a question is waiting, and an inbox nobody knows has items is the
  // PUT /targets mistake again.
  const openCount = openProposals(useProposalsQuery().data).length;
  const pricesFrom = pricesAsOf(portfolio.data);
  // A refresh keeps the current numbers on screen; only the first load spins.
  const refreshing = portfolio.isFetching && !portfolio.isPending;

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4 sm:p-6">
      {/* Sticky, because the feed below makes this a very long page and the
          header is the only way to reach every other view. The negative margin
          lets its background span the page padding, so rows scrolling under it
          do not show through at the edges. */}
      <header className="sticky top-0 z-20 -mx-4 flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle bg-surface/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <LineChart className="size-5 text-accent" aria-hidden />
          <h1 className="text-base font-semibold">{t('dashboard.title')}</h1>
          <NarrationBadge />
          {pricesFrom && (
            <span
              className="text-xs text-text-muted"
              title={t('dashboard.pricesTitle', {
                observed: formatExactTime(pricesFrom),
                fetched: formatClockTime(portfolio.dataUpdatedAt),
              })}
            >
              {t('dashboard.pricesFrom', { age: formatAge(pricesFrom) })}
              {hasStaleQuotes(portfolio.data) && t('dashboard.someCached')}
              {refreshing && t('dashboard.refreshing')}
            </span>
          )}
        </div>

        {/* At phone width seven buttons are wider than the screen. Wrapped, they
            took three rows - a third of the screen once the header is sticky - so
            below `sm` they form one row that scrolls sideways inside its own box.
            The box, not the page, scrolls: an unconstrained row once made the
            whole page 721 px wide and put a tap on "Topics" onto "Settings". */}
        <div className="-mx-4 flex w-[calc(100%+2rem)] items-center gap-2 overflow-x-auto px-4 *:shrink-0 sm:mx-0 sm:w-auto sm:flex-wrap sm:overflow-visible sm:px-0">
          <Button
            variant="secondary"
            onClick={() => {
              void portfolio.refetch();
              // Every filtered view of the feed, not only the one on screen.
              void queryClient.invalidateQueries({ queryKey: queryKeys.observations });
              void queryClient.invalidateQueries({ queryKey: queryKeys.proposals });
              void queryClient.invalidateQueries({ queryKey: queryKeys.narration });
              void queryClient.invalidateQueries({ queryKey: queryKeys.digest });
            }}
          >
            <span className="flex items-center gap-1">
              <RefreshCw className={`size-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden />
              {t('nav.refresh')}
            </span>
          </Button>
          <Button variant="secondary" onClick={importStore.openDialog}>
            <span className="flex items-center gap-1">
              <FileUp className="size-4" aria-hidden />
              {t('nav.import')}
            </span>
          </Button>
          {/* Links, not buttons: each view has an address. Targets, topics and
              settings are read by their own pages on arrival - a dashboard
              that fetched them on every login would spend requests nobody
              asked for. */}
          <Link to="/targets" className={buttonClass('secondary')}>
            <span className="flex items-center gap-1">
              <Target className="size-4" aria-hidden />
              {t('nav.targets')}
            </span>
          </Link>
          <Link to="/agents" className={buttonClass('secondary')}>
            <span className="flex items-center gap-1">
              <Bot className="size-4" aria-hidden />
              {t('nav.agents')}
            </span>
          </Link>
          <Link to="/topics" className={buttonClass('secondary')}>
            <span className="flex items-center gap-1">
              <Tags className="size-4" aria-hidden />
              {t('nav.topics')}
            </span>
          </Link>
          <Link to="/ask" className={buttonClass('secondary')}>
            <span className="flex items-center gap-1">
              <MessageCircleQuestion className="size-4" aria-hidden />
              {t('nav.ask')}
            </span>
          </Link>
          <Link to="/proposals" className={buttonClass('secondary')}>
            <span className="flex items-center gap-1">
              <Inbox className="size-4" aria-hidden />
              {t('nav.proposals')}
              {/*
                The count is the point of the button. A question that expires
                unanswered because nobody knew it was there is the failure this
                whole milestone exists to prevent, and a nav item with no badge
                is indistinguishable from one with nothing behind it.
              */}
              {openCount > 0 && (
                <span className="ms-1 rounded-full bg-accent px-1.5 text-xs font-semibold text-surface">
                  {openCount}
                </span>
              )}
            </span>
          </Link>
          <Link to="/settings" className={buttonClass('secondary')}>
            <span className="flex items-center gap-1">
              <Settings className="size-4" aria-hidden />
              {t('nav.settings')}
            </span>
          </Link>
          {/* Shown to an admin only. Hiding it is courtesy: the server refuses
              every /admin request from anyone else (decision 83). */}
          {auth.user?.role === 'admin' && (
            <Link to="/admin" className={buttonClass('secondary')}>
              <span className="flex items-center gap-1">
                <ShieldCheck className="size-4" aria-hidden />
                {t('nav.admin')}
              </span>
            </Link>
          )}
          <Button
            variant="ghost"
            // Back to the top, so the next sign-in starts at the portfolio
            // rather than wherever this session last was.
            onClick={() => void auth.logout().then(() => navigate({ to: '/' }))}
          >
            <span className="flex items-center gap-1">
              <LogOut className="size-4" aria-hidden />
              {t('nav.signOut')}
            </span>
          </Button>
        </div>
      </header>

      {portfolio.isPending && <Spinner label={t('dashboard.loading')} />}
      {portfolio.error && (
        <ErrorNote
          message={errorMessage(portfolio.error, t('common.loadPortfolioFailed'))}
          onRetry={() => void portfolio.refetch()}
        />
      )}

      {portfolio.data?.holdings.length === 0 ? (
        <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <div className="rounded-xl border border-border-subtle bg-surface-raised">
            <EmptyState
              title={t('dashboard.emptyTitle')}
              body={t('dashboard.emptyBody')}
              action={<Button onClick={importStore.openDialog}>{t('dashboard.importFile')}</Button>}
            />
          </div>
          <AddHoldingForm />
        </div>
      ) : (
        <>
          <SummaryCards />
          <EquityCurve />
          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            <HoldingsTable />
            <div className="space-y-4">
              <AllocationChart />
              <AddHoldingForm />
            </div>
          </div>
          <DigestCard />
          {/* The feed sits below the portfolio rather than above it: an empty
              feed is the normal result of a quiet day, and it should not take
              the top of the page to say so. */}
          <ObservationsFeed
            filters={feedFilters}
            onFiltersChange={(next) =>
              void navigate({
                to: '/',
                search: { severity: next.severity, symbol: next.symbol },
                // A filter is a view of this page, not a place: Back leaves the page.
                replace: true,
              })
            }
          />
        </>
      )}

      <Disclaimer />
      <ImportWizard />
    </div>
  );
});
