import { observer } from 'mobx-react-lite';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, Target } from 'lucide-react';

import { Disclaimer } from '../components/Disclaimer.tsx';
import { Button, Card, EmptyState, ErrorNote, Spinner, buttonClass } from '../components/ui.tsx';
import {
  DRIFT_BANDS,
  formatDriftPoints,
  unitsToPercent,
} from '../lib/targetWeights.ts';
import { MIRROR_IN_RTL } from '../lib/textDirection.ts';
import type { TargetRow } from '../stores/TargetsStore.ts';
import { usePortfolioQuery } from '../queries/portfolio.ts';
import { errorMessage } from '../api/client.ts';
import { Trans, useTranslation } from '../i18n/index.ts';
import { formatClockTime } from '../lib/relativeTime.ts';
import { useTargetsQuery } from '../queries/targets.ts';
import { useStore } from '../stores/context.tsx';

/**
 * Target weights: the page where the user states what they meant their
 * allocation to be.
 *
 * This is an input, not advice. Nothing here proposes a portfolio; it records
 * one the user already has in mind, and the only number the page produces by
 * itself is an equal split of the holdings they already chose (guideline 2).
 *
 * The drift column is a *preview*. The figure that reaches the feed is computed
 * by the analysis engine from exact minor units on its own schedule, and this
 * one is the same subtraction done against the weights currently on screen —
 * which is why the page says when drift cannot be computed at all rather than
 * showing a number the engine would refuse to produce.
 */
export const TargetsPage = observer(function TargetsPage() {
  const { targets } = useStore();
  const { t } = useTranslation();
  // Read here, not only on the dashboard: `targets.rows` computes from the
  // cached portfolio, and this page can be the first to need it.
  const portfolio = usePortfolioQuery();
  // Read on arrival, not at sign-in: targets are read when someone goes looking.
  const stored = useTargetsQuery();
  const rows = targets.rows;
  const unpriced = targets.driftBlockedBySymbols;

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Target className="size-5 text-accent" aria-hidden />
          <h1 className="text-base font-semibold">{t('targets.title')}</h1>
          {targets.savedAt && !targets.isDirty && (
            <span className="text-xs text-text-muted">
              {t('targets.saved', { time: formatClockTime(targets.savedAt) })}
            </span>
          )}
        </div>
        <Link to="/" className={buttonClass('secondary')}>
          <span className="flex items-center gap-1">
            <ArrowLeft className={`size-4 ${MIRROR_IN_RTL}`} aria-hidden />
            {t('common.backToPortfolio')}
          </span>
        </Link>
      </header>

      <p className="max-w-3xl text-sm text-text-muted">
        {t('targets.intro')}
      </p>

      {stored.isPending && <Spinner label={t('targets.loading')} />}

      {stored.error && targets.saved === null && (
        <ErrorNote
          message={errorMessage(stored.error, t('targets.loadFailed'))}
          onRetry={() => void stored.refetch()}
        />
      )}

      {/* A failed save leaves the boxes as typed; Save is the retry. */}
      {targets.error && <ErrorNote message={targets.error} />}

      {targets.saved !== null && rows.length === 0 && (
        <div className="rounded-xl border border-border-subtle bg-surface-raised">
          <EmptyState
            title={t('targets.emptyTitle')}
            body={t('targets.emptyBody')}
            action={
              <Link to="/" className={buttonClass()}>
                {t('common.backToPortfolio')}
              </Link>
            }
          />
        </div>
      )}

      {rows.length > 0 && (
        <>
          {unpriced.length > 0 && (
            <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
              {t('targets.unpriced', {
                count: unpriced.length,
                symbols: unpriced.join(t('common.listSeparator')),
              })}
            </div>
          )}

          <Card
            title={t('targets.yours')}
            action={
              <Button variant="ghost" onClick={targets.spreadEvenly}>
                {t('targets.spreadEvenly')}
              </Button>
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-start text-xs uppercase tracking-wide text-text-muted">
                  <tr>
                    <th className="py-2 pe-3 font-medium">{t('targets.columns.holding')}</th>
                    <th className="py-2 pe-3 text-end font-medium">{t('targets.columns.now')}</th>
                    <th className="py-2 pe-3 text-end font-medium">{t('targets.columns.target')}</th>
                    <th className="py-2 text-end font-medium">{t('targets.columns.drift')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <Row key={row.symbol} row={row} />
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border-subtle text-text-muted">
                    <td className="py-2 pe-3">{t('targets.targeted')}</td>
                    <td className="py-2 pe-3 text-end" />
                    <td className="py-2 pe-3 text-end tabular-nums text-text-primary">
                      {t('targets.percent', { value: unitsToPercent(targets.totalUnits) })}
                    </td>
                    <td className="py-2 text-end text-xs">
                      {targets.unallocatedUnits >= 0
                        ? t('targets.notSpokenFor', { value: unitsToPercent(targets.unallocatedUnits) })
                        : t('targets.tooMuch', { value: unitsToPercent(-targets.unallocatedUnits) })}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <p className="mt-3 max-w-3xl text-xs text-text-muted">
              <Trans
                i18nKey="targets.explainer"
                values={{ info: unitsToPercent(DRIFT_BANDS.info), high: unitsToPercent(DRIFT_BANDS.high) }}
                components={{ num: <span className="tabular-nums" /> }}
              />
            </p>
          </Card>

          <div className="flex flex-wrap items-center justify-end gap-3">
            {targets.blockingIssue && (
              <span className="me-auto text-sm text-loss">{targets.blockingIssue}</span>
            )}
            {targets.isDirty && !targets.blockingIssue && (
              <span className="me-auto text-sm text-text-muted">
                {t('targets.unsaved')}
              </span>
            )}
            {!targets.isDirty && targets.savedAt && (
              <span className="me-auto text-sm text-text-muted">
                {t('targets.savedNextScan')}
              </span>
            )}
            <Button variant="ghost" onClick={targets.discard} disabled={!targets.isDirty}>
              {t('settings.discard')}
            </Button>
            <Button onClick={() => void targets.save()} disabled={!targets.canSave}>
              {targets.saving ? t('settings.saving') : t('targets.save')}
            </Button>
          </div>
        </>
      )}

      {portfolio.isError && !portfolio.data && (
        <p className="text-xs text-text-muted">
          {t('targets.portfolioMissing')}
        </p>
      )}

      <Disclaimer />
    </div>
  );
});

const DRIFT_TONE = {
  info: 'text-text-primary',
  notable: 'text-warn',
  high: 'text-loss',
} as const;

const Row = observer(function Row({ row }: { row: TargetRow }) {
  const { targets } = useStore();
  const { t } = useTranslation();
  const tone = row.driftSeverity === null ? 'text-text-muted' : DRIFT_TONE[row.driftSeverity];

  return (
    <tr className="border-t border-border-subtle">
      <td className="py-2 pe-3">
        <span className="font-medium text-text-primary">{row.symbol}</span>
        {row.name && <bdi className="block text-xs text-text-muted">{row.name}</bdi>}
        {!row.held && (
          <span className="block text-xs text-text-muted">
            {t('targets.notHeld')}
          </span>
        )}
      </td>
      <td className="py-2 pe-3 text-end tabular-nums text-text-muted">
        {/* Unpriced is a known unknown and says so; it is never rendered as 0%. */}
        {row.actualUnits === null
          ? t('targets.unpricedCell')
          : t('targets.percent', { value: unitsToPercent(row.actualUnits) })}
      </td>
      <td className="py-2 pe-3 text-end">
        <div className="flex items-center justify-end gap-1">
          <input
            className={`input max-w-24 text-end tabular-nums ${row.invalid ? 'border-loss' : ''}`}
            type="text"
            inputMode="decimal"
            aria-label={t('targets.weightFor', { symbol: row.symbol })}
            aria-invalid={row.invalid}
            placeholder="—"
            value={row.targetText}
            onChange={(event) => targets.setTarget(row.symbol, event.target.value)}
          />
          <span className="text-text-muted">%</span>
        </div>
      </td>
      <td className={`py-2 text-end tabular-nums ${tone}`}>
        {row.driftUnits === null ? '—' : formatDriftPoints(row.driftUnits)}
      </td>
    </tr>
  );
});
