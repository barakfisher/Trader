import { observer } from 'mobx-react-lite';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, Clock } from 'lucide-react';
import type { ReactNode } from 'react';

import type { HoldingView } from '@traders/shared';

import { errorMessage } from '../api/client.ts';
import { formatMoney, formatPercent, formatShare } from '../i18n/format.ts';
import { useTranslation } from '../i18n/index.ts';
import { Disclaimer } from '../components/Disclaimer.tsx';
import { NewsList } from '../components/NewsList.tsx';
import { ObservationRow } from '../components/ObservationsFeed.tsx';
import { PriceChart } from '../components/PriceChart.tsx';
import { Card, Delta, EmptyState, ErrorNote, Spinner, buttonClass } from '../components/ui.tsx';
import { assetClassName } from '../lib/assetClass.ts';
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
  const { t } = useTranslation();
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
                    title={t('holdings.staleTitle', { when: formatExactTime(holding.quote.asOf) })}
                    className="flex items-center gap-1 rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-normal text-warn"
                  >
                    <Clock className="size-3" aria-hidden /> {t('holdings.stale')}
                  </span>
                )}
                {holding.valueMinor === null && (
                  <span className="rounded bg-loss/15 px-1.5 py-0.5 text-[10px] font-normal text-loss">
                    {t('holdings.unpriced')}
                  </span>
                )}
              </h1>
              <p className="text-xs text-text-muted">
                {[holding.instrument.name, holding.instrument.exchange, assetClassName(holding.instrument.assetClass)]
                  .filter((part): part is string => Boolean(part))
                  .map((part, index) => (
                    <span key={index}>
                      {index > 0 && ' · '}
                      <bdi>{part}</bdi>
                    </span>
                  ))}
              </p>
            </>
          ) : (
            <h1 className="text-base font-semibold">{t('holding.title')}</h1>
          )}
        </div>
        <Link to="/" className={buttonClass('secondary')}>
          <span className="flex items-center gap-1">
            <ArrowLeft className={`size-4 ${MIRROR_IN_RTL}`} aria-hidden />
            {t('common.backToPortfolio')}
          </span>
        </Link>
      </header>

      {portfolio.isPending && <Spinner label={t('holding.loading')} />}
      {portfolio.error && !portfolio.data && (
        <ErrorNote
          message={errorMessage(portfolio.error, t('holding.loadFailed'))}
          onRetry={() => void portfolio.refetch()}
        />
      )}

      {portfolio.data && !holding && (
        <EmptyState
          title={t('holding.notFoundTitle')}
          body={t('holding.notFoundBody')}
          action={
            <Link to="/" className={buttonClass('primary')}>
              {t('common.backToPortfolio')}
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
  const { t } = useTranslation();
  const target = targets.data?.find((row) => row.symbol === holding.instrument.symbol) ?? null;

  return (
    <Card title={t('holding.position')}>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Figure label={t('holding.quantity')}>{trimQuantity(holding.quantity)}</Figure>
        <Figure
          label={t('holding.price')}
          note={
            holding.quote
              ? holding.quote.delaySeconds > 0
                ? t('holding.priceViaDelayed', {
                    age: formatAge(holding.quote.asOf),
                    source: holding.quote.source,
                    minutes: Math.round(holding.quote.delaySeconds / 60),
                  })
                : t('holding.priceVia', { age: formatAge(holding.quote.asOf), source: holding.quote.source })
              : t('holding.unpricedNote')
          }
        >
          {holding.quote ? formatMoney(holding.quote.priceMinor, holding.quote.currency) : '—'}
        </Figure>
        <Figure label={t('holding.day')}>
          <Delta value={holding.quote?.dayChangePct ?? null}>
            {formatPercent(holding.quote?.dayChangePct ?? null)}
          </Delta>
        </Figure>
        <Figure label={t('holding.value')}>{formatMoney(holding.valueMinor, baseCurrency)}</Figure>
        <Figure
          label={t('holding.cost')}
          note={
            holding.costBasisMinor === null
              ? t('holding.noCost')
              : t('holding.perUnit', { cost: formatMoney(holding.costBasisMinor, holding.costCurrency) })
          }
        >
          {formatMoney(holding.costMinor, baseCurrency)}
        </Figure>
        <Figure label={t('holding.pnl')}>
          <Delta value={holding.pnlMinor}>
            {holding.pnlMinor === null
              ? '—'
              : t('holdings.pnl', {
                  money: formatMoney(holding.pnlMinor, baseCurrency),
                  percent: formatPercent(holding.pnlPct),
                })}
          </Delta>
        </Figure>
        <Figure label={t('holding.weight')}>
          {formatShare(holding.weightPct)}
        </Figure>
        <Figure label={t('holding.target')}>
          {target ? (
            t('holding.targetValue', { value: unitsToPercent(weightToUnits(target.weight)) })
          ) : (
            <Link to="/targets" className="text-sm text-text-muted underline hover:text-text-primary">
              {t('holding.noTarget')}
            </Link>
          )}
        </Figure>
      </dl>
      {holding.fxRate && holding.instrument.currency !== baseCurrency && (
        <p className="mt-3 text-xs text-text-muted" title={t('holding.fxRateTitle', { rate: holding.fxRate })}>
          {t('holding.fx', {
            base: baseCurrency,
            rate: shortRate(holding.fxRate),
            currency: holding.instrument.currency,
          })}
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
  const { t } = useTranslation();
  const items = findings.data ?? [];
  return (
    <Card title={t('holding.findings')}>
      {findings.isPending && <Spinner label={t('holding.findingsLoading')} />}
      {findings.error && (
        <ErrorNote
          message={errorMessage(findings.error, t('holding.findingsFailed', { symbol }))}
          onRetry={() => void findings.refetch()}
        />
      )}
      {findings.status === 'success' && items.length === 0 && (
        <p className="text-sm text-text-muted">
          {t('holding.noFindings', { symbol })}
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
  const { t } = useTranslation();
  const news = query.data;
  return (
    <Card
      title={t('holding.news')}
      action={
        news && news.total > news.articles.length ? (
          <span className="text-xs text-text-muted">
            {t('holding.newest', { shown: news.articles.length, total: news.total })}
          </span>
        ) : null
      }
    >
      {query.isPending && <Spinner label={t('holding.newsLoading')} />}
      {query.error && (
        <ErrorNote
          message={errorMessage(query.error, t('holding.newsFailed', { symbol }))}
          onRetry={() => void query.refetch()}
        />
      )}
      {news && news.articles.length === 0 && (
        <p className="text-sm text-text-muted">
          {newsEmptyMessage(news.collection, news.days, symbol)}
          {news.collection && t('holding.lastCollection', { age: formatAge(news.collection.lastRunAt) })}
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
