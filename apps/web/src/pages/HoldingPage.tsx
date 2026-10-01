import { observer } from 'mobx-react-lite';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, Clock } from 'lucide-react';
import type { ReactNode } from 'react';

import { formatMoney, formatPercent, type HoldingView } from '@traders/shared';

import { errorMessage } from '../api/client.ts';
import { Disclaimer } from '../components/Disclaimer.tsx';
import { NewsList } from '../components/NewsList.tsx';
import { ObservationRow } from '../components/ObservationsFeed.tsx';
import { PriceChart } from '../components/PriceChart.tsx';
import { Card, Delta, EmptyState, ErrorNote, Spinner, buttonClass } from '../components/ui.tsx';
import { baseCurrencyOf, shortRate } from '../lib/portfolioView.ts';
import { formatAge, formatExactTime } from '../lib/relativeTime.ts';
import { unitsToPercent, weightToUnits } from '../lib/targetWeights.ts';
import { MIRROR_IN_RTL } from '../lib/textDirection.ts';
import { newsEmptyMessage } from '../lib/topicPresentation.ts';
import { useHoldingNewsQuery, useSymbolObservationsQuery } from '../queries/holding.ts';
import { usePortfolioQuery } from '../queries/portfolio.ts';
import { useTargetsQuery } from '../queries/targets.ts';

/**
 * One holding: its position, its stored closes, what the analysis found about
 * it, and its week of news.
 *
 * The position is the cached portfolio's own row, not a second request, so this
 * page and the dashboard cannot show two values for one holding. The chart,
 * findings and news are asked for only once the holding is known to be the
 * user's - a stale link shows "no such holding", never three failed panels.
 */
export const HoldingPage = observer(function HoldingPage() {
  const { holdingId } = useParams({ from: '/holdings/$holdingId' });
  const portfolio = usePortfolioQuery();
  const holding = portfolio.data?.holdings.find((row) => row.id === holdingId) ?? null;

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          {holding ? (
            <>
              <h1 className="flex flex-wrap items-center gap-2 text-base font-semibold">
                {holding.instrument.symbol}
                {holding.quote?.stale && (
                  <span
                    title={`Last known price, observed ${formatExactTime(holding.quote.asOf)}. No provider could refresh it.`}
                    className="flex items-center gap-1 rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-normal text-warn"
                  >
                    <Clock className="size-3" aria-hidden /> stale
                  </span>
                )}
                {holding.valueMinor === null && (
                  <span className="rounded bg-loss/15 px-1.5 py-0.5 text-[10px] font-normal text-loss">
                    unpriced
                  </span>
                )}
              </h1>
              <p className="text-xs text-text-muted">
                {[holding.instrument.name, holding.instrument.exchange, holding.instrument.assetClass]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </>
          ) : (
            <h1 className="text-base font-semibold">Holding</h1>
          )}
        </div>
        <Link to="/" className={buttonClass('secondary')}>
          <span className="flex items-center gap-1">
            <ArrowLeft className={`size-4 ${MIRROR_IN_RTL}`} aria-hidden />
            Back to portfolio
          </span>
        </Link>
      </header>

      {portfolio.isPending && <Spinner label="Loading the portfolio…" />}
      {portfolio.error && !portfolio.data && (
        <ErrorNote
          message={errorMessage(portfolio.error, 'Could not load the portfolio.')}
          onRetry={() => void portfolio.refetch()}
        />
      )}

      {portfolio.data && !holding && (
        <EmptyState
          title="No such holding"
          body="This address does not match a holding in your portfolio. It may have been removed, or the link may be from another account."
          action={
            <Link to="/" className={buttonClass('primary')}>
              Back to portfolio
            </Link>
          }
        />
      )}

      {holding && (
        <>
          <PositionCard holding={holding} baseCurrency={baseCurrencyOf(portfolio.data)} />
          <PriceChart
            holdingId={holding.id}
            costPerUnitMinor={holding.costBasisMinor}
            costCurrency={holding.costCurrency}
          />
          <FindingsCard symbol={holding.instrument.symbol} baseCurrency={baseCurrencyOf(portfolio.data)} />
          <NewsCard holdingId={holding.id} symbol={holding.instrument.symbol} />
        </>
      )}

      <Disclaimer />
    </div>
  );
});

/** The dashboard row's figures, laid out to be read rather than scanned. */
function PositionCard({ holding, baseCurrency }: { holding: HoldingView; baseCurrency: string }) {
  const targets = useTargetsQuery();
  const target = targets.data?.find((row) => row.symbol === holding.instrument.symbol) ?? null;

  return (
    <Card title="Position">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Figure label="Quantity">{trimQuantity(holding.quantity)}</Figure>
        <Figure
          label="Price"
          note={
            holding.quote
              ? `${formatAge(holding.quote.asOf)} via ${holding.quote.source}${
                  holding.quote.delaySeconds > 0
                    ? `, ${Math.round(holding.quote.delaySeconds / 60)}m delay`
                    : ''
                }`
              : 'no provider could price it'
          }
        >
          {holding.quote ? formatMoney(holding.quote.priceMinor, holding.quote.currency) : '—'}
        </Figure>
        <Figure label="Day">
          <Delta value={holding.quote?.dayChangePct ?? null}>
            {formatPercent(holding.quote?.dayChangePct ?? null)}
          </Delta>
        </Figure>
        <Figure label="Value">{formatMoney(holding.valueMinor, baseCurrency)}</Figure>
        <Figure
          label="Cost"
          note={
            holding.costBasisMinor === null
              ? 'no cost recorded'
              : `${formatMoney(holding.costBasisMinor, holding.costCurrency)} per unit`
          }
        >
          {formatMoney(holding.costMinor, baseCurrency)}
        </Figure>
        <Figure label="P&L">
          <Delta value={holding.pnlMinor}>
            {holding.pnlMinor === null
              ? '—'
              : `${formatMoney(holding.pnlMinor, baseCurrency)} (${formatPercent(holding.pnlPct)})`}
          </Delta>
        </Figure>
        <Figure label="Weight">
          {holding.weightPct === null ? '—' : `${holding.weightPct.toFixed(1)}%`}
        </Figure>
        <Figure label="Target">
          {target ? (
            `${unitsToPercent(weightToUnits(target.weight))}%`
          ) : (
            <Link to="/targets" className="text-sm text-text-muted underline hover:text-text-primary">
              none set
            </Link>
          )}
        </Figure>
      </dl>
      {holding.fxRate && holding.instrument.currency !== baseCurrency && (
        <p className="mt-3 text-xs text-text-muted" title={`Exact rate: ${holding.fxRate}`}>
          Value, cost and P&amp;L in {baseCurrency} at {shortRate(holding.fxRate)} {baseCurrency} per{' '}
          {holding.instrument.currency}.
        </p>
      )}
    </Card>
  );
}

function Figure({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="text-sm font-medium tabular-nums">{children}</dd>
      {note && <dd className="text-[11px] text-text-muted">{note}</dd>}
    </div>
  );
}

/** What the analysis recorded about this instrument: its own rules and allocation drift. */
function FindingsCard({ symbol, baseCurrency }: { symbol: string; baseCurrency: string }) {
  const findings = useSymbolObservationsQuery(symbol);
  const items = findings.data ?? [];
  return (
    <Card title="Findings">
      {findings.isPending && <Spinner label="Loading findings…" />}
      {findings.error && (
        <ErrorNote
          message={errorMessage(findings.error, `Could not load the findings about ${symbol}.`)}
          onRetry={() => void findings.refetch()}
        />
      )}
      {findings.status === 'success' && items.length === 0 && (
        <p className="text-sm text-text-muted">
          The analysis has recorded no price move, unusual move, drawdown or allocation drift about{' '}
          {symbol}. That is the ordinary outcome, not a missing result.
        </p>
      )}
      {items.length > 0 && (
        <ul className="space-y-3">
          {items.map((observation) => (
            <li key={observation.id}>
              <ObservationRow observation={observation} baseCurrency={baseCurrency} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function NewsCard({ holdingId, symbol }: { holdingId: string; symbol: string }) {
  const query = useHoldingNewsQuery(holdingId, true);
  const news = query.data;
  return (
    <Card
      title="News this week"
      action={
        news && news.total > news.articles.length ? (
          <span className="text-xs text-text-muted">
            newest {news.articles.length} of {news.total}
          </span>
        ) : null
      }
    >
      {query.isPending && <Spinner label="Loading news…" />}
      {query.error && (
        <ErrorNote
          message={errorMessage(query.error, `Could not load the news about ${symbol}.`)}
          onRetry={() => void query.refetch()}
        />
      )}
      {news && news.articles.length === 0 && (
        <p className="text-sm text-text-muted">
          {newsEmptyMessage(news.collection, news.days, symbol)}
          {news.collection && ` Last collection ${formatAge(news.collection.lastRunAt)}.`}
        </p>
      )}
      {news && news.articles.length > 0 && <NewsList articles={news.articles} showSymbols={false} />}
    </Card>
  );
}

/** Numeric quantities arrive as exact decimal strings; trim trailing zeros only. */
function trimQuantity(quantity: string): string {
  if (!quantity.includes('.')) return quantity;
  return quantity.replace(/0+$/, '').replace(/\.$/, '');
}
