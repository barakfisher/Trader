import { observer } from 'mobx-react-lite';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';

import { AddHoldingForm } from '../components/AddHoldingForm.tsx';
import { AllocationChart } from '../components/AllocationChart.tsx';
import {
  AgentHeadline,
  AgentScopeHoldings,
  ConsolidatedHeadline,
  ConsolidatedHoldings,
  HoldingsScopePicker,
} from '../components/ConsolidatedHoldings.tsx';
import { EquityCurve } from '../components/EquityCurve.tsx';
import { DigestBanner } from '../components/DigestBanner.tsx';
import { Disclaimer } from '../components/Disclaimer.tsx';
import { HoldingsTable } from '../components/HoldingsTable.tsx';
import { ImportWizard } from '../components/ImportWizard.tsx';
import { NarrationBadge } from '../components/NarrationBadge.tsx';
import { SummaryCards } from '../components/SummaryCards.tsx';
import { Button, EmptyState, ErrorNote, Spinner } from '../components/ui.tsx';
import { errorMessage } from '../api/client.ts';
import { useTranslation } from '../i18n/index.ts';
import { hasStaleQuotes, pricesAsOf } from '../lib/portfolioView.ts';
import { formatAge, formatClockTime, formatExactTime } from '../lib/relativeTime.ts';
import { REAL_SCOPE, holdingsScopeFrom, holdingsSearchValue, type HoldingsScope } from '../lib/holdingsScope.ts';
import { useAgentsQuery } from '../queries/agents.ts';
import { useConsolidatedQuery, usePortfolioQuery } from '../queries/portfolio.ts';
import { queryKeys } from '../queries/queryKeys.ts';
import { useStore } from '../stores/context.tsx';

export const DashboardPage = observer(function DashboardPage() {
  const { import: importStore, queryClient } = useStore();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const portfolio = usePortfolioQuery();
  // Read loosely: this page also renders for unknown addresses, where the '/'
  // route is not matched.
  const search = useSearch({ strict: false });
  // Which holdings the holdings card and the headline show (D32, D33): the
  // real portfolio unless the address asks for more. An agent the user does
  // not have - or has archived - is the default view, once the list is known.
  const agents = useAgentsQuery();
  const simulatedAgents = (agents.data ?? []).filter((agent) => !agent.isPrimary && agent.state !== 'archived');
  const requestedScope = holdingsScopeFrom(search);
  const scope: HoldingsScope =
    requestedScope.kind === 'agent' &&
    agents.data !== undefined &&
    !simulatedAgents.some((agent) => agent.id === requestedScope.agentId)
      ? REAL_SCOPE
      : requestedScope;
  const consolidated = useConsolidatedQuery(scope.kind !== 'real');
  const standing =
    scope.kind === 'agent'
      ? (consolidated.data?.agents.find((agent) => agent.agentId === scope.agentId) ?? null)
      : null;
  const setScope = (next: HoldingsScope) =>
    void navigate({
      to: '/',
      search: { holdings: holdingsSearchValue(next) },
      // A view of this page, not a place: Back leaves the page.
      replace: true,
    });
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

      {portfolio.isPending && <Spinner label={t('dashboard.loading')} />}
      {portfolio.error && (
        <ErrorNote
          message={errorMessage(portfolio.error, t('common.loadPortfolioFailed'))}
          onRetry={() => void portfolio.refetch()}
        />
      )}

      {simulatedAgents.length > 0 && (
        <HoldingsScopePicker scope={scope} agents={simulatedAgents} onChange={setScope} />
      )}
      {scope.kind !== 'real' && consolidated.isPending && <Spinner label={t('consolidated.loading')} />}
      {scope.kind !== 'real' && consolidated.error && (
        <ErrorNote
          message={errorMessage(consolidated.error, t('consolidated.loadFailed'))}
          onRetry={() => void consolidated.refetch()}
        />
      )}

      {scope.kind === 'real' && portfolio.data?.holdings.length === 0 ? (
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
          {scope.kind === 'real' && <SummaryCards />}
          {scope.kind === 'all' && consolidated.data && <ConsolidatedHeadline data={consolidated.data} />}
          {standing && <AgentHeadline standing={standing} />}
          <EquityCurve />
          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            {scope.kind === 'real' && <HoldingsTable />}
            {scope.kind === 'all' && consolidated.data && <ConsolidatedHoldings data={consolidated.data} />}
            {standing && consolidated.data && <AgentScopeHoldings data={consolidated.data} standing={standing} />}
            <div className="space-y-4">
              <AllocationChart />
              <AddHoldingForm />
            </div>
          </div>
        </>
      )}

      <Disclaimer />
      <ImportWizard />
    </div>
  );
});
