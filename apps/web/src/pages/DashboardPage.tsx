import { observer } from 'mobx-react-lite';
import { Link, useNavigate } from '@tanstack/react-router';
import { FileUp, Inbox, LineChart, LogOut, RefreshCw, Settings, Tags, Target } from 'lucide-react';

import { AddHoldingForm } from '../components/AddHoldingForm.tsx';
import { AllocationChart } from '../components/AllocationChart.tsx';
import { Disclaimer } from '../components/Disclaimer.tsx';
import { HoldingsTable } from '../components/HoldingsTable.tsx';
import { ImportWizard } from '../components/ImportWizard.tsx';
import { NarrationBadge } from '../components/NarrationBadge.tsx';
import { ObservationsFeed } from '../components/ObservationsFeed.tsx';
import { SummaryCards } from '../components/SummaryCards.tsx';
import { Button, EmptyState, ErrorNote, Spinner, buttonClass } from '../components/ui.tsx';
import { errorMessage } from '../api/client.ts';
import { hasStaleQuotes, pricesAsOf } from '../lib/portfolioView.ts';
import { formatAge, formatExactTime } from '../lib/relativeTime.ts';
import { useObservationsQuery } from '../queries/observations.ts';
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
  const portfolio = usePortfolioQuery();
  const feed = useObservationsQuery();
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
          <h1 className="text-base font-semibold">Portfolio</h1>
          <NarrationBadge />
          {pricesFrom && (
            <span
              className="text-xs text-text-muted"
              title={`Prices observed ${formatExactTime(pricesFrom)}. Fetched ${new Date(
                portfolio.dataUpdatedAt,
              ).toLocaleTimeString()}.`}
            >
              prices from {formatAge(pricesFrom)}
              {hasStaleQuotes(portfolio.data) && ' · some cached'}
              {refreshing && ' · refreshing…'}
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
              void feed.refetch();
              void queryClient.invalidateQueries({ queryKey: queryKeys.proposals });
              void queryClient.invalidateQueries({ queryKey: queryKeys.narration });
            }}
          >
            <span className="flex items-center gap-1">
              <RefreshCw className={`size-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden />
              Refresh
            </span>
          </Button>
          <Button variant="secondary" onClick={importStore.openDialog}>
            <span className="flex items-center gap-1">
              <FileUp className="size-4" aria-hidden />
              Import
            </span>
          </Button>
          {/* Links, not buttons: each view has an address. Targets, topics and
              settings are read by their own pages on arrival - a dashboard
              that fetched them on every login would spend requests nobody
              asked for. */}
          <Link to="/targets" className={buttonClass('secondary')}>
            <span className="flex items-center gap-1">
              <Target className="size-4" aria-hidden />
              Targets
            </span>
          </Link>
          <Link to="/topics" className={buttonClass('secondary')}>
            <span className="flex items-center gap-1">
              <Tags className="size-4" aria-hidden />
              Topics
            </span>
          </Link>
          <Link to="/proposals" className={buttonClass('secondary')}>
            <span className="flex items-center gap-1">
              <Inbox className="size-4" aria-hidden />
              Proposals
              {/*
                The count is the point of the button. A question that expires
                unanswered because nobody knew it was there is the failure this
                whole milestone exists to prevent, and a nav item with no badge
                is indistinguishable from one with nothing behind it.
              */}
              {openCount > 0 && (
                <span className="ml-1 rounded-full bg-accent px-1.5 text-xs font-semibold text-surface">
                  {openCount}
                </span>
              )}
            </span>
          </Link>
          <Link to="/settings" className={buttonClass('secondary')}>
            <span className="flex items-center gap-1">
              <Settings className="size-4" aria-hidden />
              Settings
            </span>
          </Link>
          <Button
            variant="ghost"
            // Back to the top, so the next sign-in starts at the portfolio
            // rather than wherever this session last was.
            onClick={() => void auth.logout().then(() => navigate({ to: '/' }))}
          >
            <span className="flex items-center gap-1">
              <LogOut className="size-4" aria-hidden />
              Sign out
            </span>
          </Button>
        </div>
      </header>

      {portfolio.isPending && <Spinner label="Loading your portfolio…" />}
      {portfolio.error && (
        <ErrorNote
          message={errorMessage(portfolio.error, 'Could not load your portfolio.')}
          onRetry={() => void portfolio.refetch()}
        />
      )}

      {portfolio.data?.holdings.length === 0 ? (
        <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <div className="rounded-xl border border-border-subtle bg-surface-raised">
            <EmptyState
              title="No holdings yet"
              body="Import a CSV or JSON file from your broker, or add a position by hand. The demo portfolio in data/fixtures/demo-portfolio.csv works with no API keys."
              action={<Button onClick={importStore.openDialog}>Import a file</Button>}
            />
          </div>
          <AddHoldingForm />
        </div>
      ) : (
        <>
          <SummaryCards />
          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            <HoldingsTable />
            <div className="space-y-4">
              <AllocationChart />
              <AddHoldingForm />
            </div>
          </div>
          {/* The feed sits below the portfolio rather than above it: an empty
              feed is the normal result of a quiet day, and it should not take
              the top of the page to say so. */}
          <ObservationsFeed />
        </>
      )}

      <Disclaimer />
      <ImportWizard />
    </div>
  );
});
