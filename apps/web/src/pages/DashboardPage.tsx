import { observer } from 'mobx-react-lite';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';

import { AddHoldingForm } from '../components/AddHoldingForm.tsx';
import { AllocationChart } from '../components/AllocationChart.tsx';
import { CombinedHoldingsTable } from '../components/CombinedHoldingsTable.tsx';
import { EquityCurve } from '../components/EquityCurve.tsx';
import { DigestBanner } from '../components/DigestBanner.tsx';
import { Disclaimer } from '../components/Disclaimer.tsx';
import { HoldingsActions } from '../components/HoldingsActions.tsx';
import { HoldingsScopeToggle } from '../components/HoldingsScopeToggle.tsx';
import { HoldingsTable } from '../components/HoldingsTable.tsx';
import { ImportWizard } from '../components/ImportWizard.tsx';
import { NarrationBadge } from '../components/NarrationBadge.tsx';
import { SummaryCards } from '../components/SummaryCards.tsx';
import { Button, EmptyState, ErrorNote, Spinner } from '../components/ui.tsx';
import { errorMessage } from '../api/client.ts';
import { useTranslation } from '../i18n/index.ts';
import { hasStaleQuotes, pricesAsOf } from '../lib/portfolioView.ts';
import { formatAge, formatClockTime, formatExactTime } from '../lib/relativeTime.ts';
import { scopeSummary, summarySources } from '../lib/combinedHoldings.ts';
import { holdingsSortFrom, holdingsSortSearch, type HoldingsSort } from '../lib/holdingsSort.ts';
import { ALL_SCOPE, holdingsScopeFrom, holdingsSearchValue, inScope, type HoldingsScope } from '../lib/holdingsScope.ts';
import { useAgentsQuery } from '../queries/agents.ts';
import { useConsolidatedQuery, usePortfolioQuery } from '../queries/portfolio.ts';
import { queryKeys } from '../queries/queryKeys.ts';
import { ModelFallbackBanner } from '../components/ModelFallbackBanner.tsx';
import { useStore } from '../stores/context.tsx';

export const DashboardPage = observer(function DashboardPage() {
  const { import: importStore, queryClient } = useStore();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const portfolio = usePortfolioQuery();
  // Read loosely: this page also renders for unknown addresses, where the '/'
  // route is not matched.
  const search = useSearch({ strict: false });
  // Which holdings the cards and the table show (D32, D229): everything, real
  // and simulated, unless the address asks for less. An agent the user does
  // not have - or has archived - is the default view, once the list is known.
  const agents = useAgentsQuery();
  const simulatedAgents = (agents.data ?? []).filter((agent) => !agent.isPrimary && agent.state !== 'archived');
  // Until the agents are known, it is not known whether there is anything but
  // the real portfolio to show; a failed list leaves the real view.
  const agentsKnown = agents.data !== undefined || agents.isError;
  const hasSimulated = simulatedAgents.length > 0;
  const requestedScope = holdingsScopeFrom(search);
  const scope: HoldingsScope =
    requestedScope.kind === 'agent' &&
    agents.data !== undefined &&
    !simulatedAgents.some((agent) => agent.id === requestedScope.agentId)
      ? ALL_SCOPE
      : requestedScope;
  // With no simulated agent, every view is the real portfolio's.
  const combinedView = hasSimulated && scope.kind !== 'real';
  const consolidated = useConsolidatedQuery(combinedView);
  const sources = consolidated.data ? summarySources(consolidated.data, scope) : [];
  // The holdings' order (M10 decision 21), kept in the address beside the scope.
  const sort = holdingsSortFrom(search);
  const setView = (next: HoldingsScope, nextSort: HoldingsSort | null) =>
    void navigate({
      to: '/',
      search: { holdings: holdingsSearchValue(next), ...holdingsSortSearch(nextSort) },
      // A view of this page, not a place: Back leaves the page.
      replace: true,
    });
  const setScope = (next: HoldingsScope) => setView(next, sort);
  const setSort = (next: HoldingsSort | null) => setView(scope, next);
  const pricesFrom = pricesAsOf(portfolio.data);
  // A refresh keeps the current numbers on screen; only the first load spins.
  const refreshing = portfolio.isFetching && !portfolio.isPending;

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4 sm:p-6">
      {/* The portfolio's own row: its price age and Refresh belong to this
          page, not to the bar every page shares (UX2). */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
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
        <Button
          variant="secondary"
          onClick={() => {
            void portfolio.refetch();
            // The consolidated view and the equity curve live under the portfolio's key.
            void queryClient.invalidateQueries({ queryKey: queryKeys.consolidated });
            // The bar's inbox count and the narration badge are on this screen too.
            void queryClient.invalidateQueries({ queryKey: queryKeys.proposals });
            void queryClient.invalidateQueries({ queryKey: queryKeys.narration });
          }}
        >
          <span className="flex items-center gap-1">
            <RefreshCw className={`size-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden />
            {t('nav.refresh')}
          </span>
        </Button>
      </header>

      <DigestBanner />
      <ModelFallbackBanner />

      {portfolio.isPending && <Spinner label={t('dashboard.loading')} />}
      {portfolio.error && (
        <ErrorNote
          message={errorMessage(portfolio.error, t('common.loadPortfolioFailed'))}
          onRetry={() => void portfolio.refetch()}
        />
      )}

      {!agentsKnown && portfolio.data && <Spinner label={t('consolidated.loading')} />}
      {combinedView && consolidated.isPending && <Spinner label={t('consolidated.loading')} />}
      {combinedView && consolidated.error && (
        <ErrorNote
          message={errorMessage(consolidated.error, t('consolidated.loadFailed'))}
          onRetry={() => void consolidated.refetch()}
        />
      )}

      {agentsKnown && !combinedView && portfolio.data?.holdings.length === 0 ? (
        <>
          {hasSimulated && <HoldingsScopeToggle scope={scope} agents={simulatedAgents} onChange={setScope} />}
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
        </>
      ) : (
        agentsKnown && (
          <>
            {/* The four cards, then the holdings - the page's main content -
                with the scope toggle directly above them, then the two charts
                (D233). On a phone everything stacks. Findings and the digest
                are on Insights. */}
            {combinedView ? (
              consolidated.data && (
                <SummaryCards
                  summary={scopeSummary(consolidated.data, sources)}
                  sources={sources}
                  pendingTrades={consolidated.data.pendingTrades.filter((trade) =>
                    inScope(scope, { agentId: trade.agentId, isPrimary: false }),
                  )}
                />
              )
            ) : (
              <SummaryCards summary={portfolio.data?.summary} />
            )}
            {hasSimulated && <HoldingsScopeToggle scope={scope} agents={simulatedAgents} onChange={setScope} />}
            {combinedView ? (
              consolidated.data && (
                <CombinedHoldingsTable
                  data={consolidated.data}
                  scope={scope}
                  actions={scope.kind === 'all' ? <HoldingsActions /> : undefined}
                  sort={sort}
                  onSort={setSort}
                />
              )
            ) : (
              <HoldingsTable actions={<HoldingsActions />} sort={sort} onSort={setSort} />
            )}
            {/* The charts stay the real portfolio's (D32): an allocation over
                real and paper shares together is a figure nobody holds. */}
            {combinedView && <p className="text-xs text-text-muted">{t('combined.chartsAreReal')}</p>}
            <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
              <EquityCurve />
              <AllocationChart />
            </div>
          </>
        )
      )}

      <Disclaimer />
      <ImportWizard />
    </div>
  );
});
