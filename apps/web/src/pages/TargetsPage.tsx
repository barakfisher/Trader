import { observer } from 'mobx-react-lite';
import { ArrowLeft, Target } from 'lucide-react';

import { Disclaimer } from '../components/Disclaimer.tsx';
import { Button, Card, EmptyState, ErrorNote, Spinner } from '../components/ui.tsx';
import {
  DRIFT_BANDS,
  formatDriftPoints,
  unitsToPercent,
} from '../lib/targetWeights.ts';
import type { TargetRow } from '../stores/TargetsStore.ts';
import { usePortfolioQuery } from '../queries/portfolio.ts';
import { errorMessage } from '../api/client.ts';
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
  const { targets, navigation } = useStore();
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
          <h1 className="text-base font-semibold">Target weights</h1>
          {targets.savedAt && !targets.isDirty && (
            <span className="text-xs text-text-muted">
              saved {targets.savedAt.toLocaleTimeString()}
            </span>
          )}
        </div>
        <Button variant="secondary" onClick={() => navigation.show('portfolio')}>
          <span className="flex items-center gap-1">
            <ArrowLeft className="size-4" aria-hidden />
            Back to portfolio
          </span>
        </Button>
      </header>

      <p className="max-w-3xl text-sm text-text-muted">
        A target is your own statement of the share of the portfolio you meant to hold in
        something. It is the only thing the drift rule compares against: with no targets set,
        nothing here can drift, and the portfolio is only ever described rather than measured
        against an intention. Targets need not add up to 100% — covering three of your holdings
        is a normal thing to do, and the rest is simply not spoken for.
      </p>

      {stored.isPending && <Spinner label="Loading your targets…" />}

      {stored.error && targets.saved === null && (
        <ErrorNote
          message={errorMessage(stored.error, 'Could not load your targets.')}
          onRetry={() => void stored.refetch()}
        />
      )}

      {/* A failed save leaves the boxes as typed; Save is the retry. */}
      {targets.error && <ErrorNote message={targets.error} />}

      {targets.saved !== null && rows.length === 0 && (
        <div className="rounded-xl border border-border-subtle bg-surface-raised">
          <EmptyState
            title="Nothing to set a target on"
            body="A target names an instrument this portfolio already knows. Add a holding or import a file first, and every symbol in it becomes a row here."
            action={<Button onClick={() => navigation.show('portfolio')}>Back to portfolio</Button>}
          />
        </div>
      )}

      {rows.length > 0 && (
        <>
          {unpriced.length > 0 && (
            <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
              No drift will be reported while {unpriced.join(', ')}{' '}
              {unpriced.length === 1 ? 'is' : 'are'} unpriced. Every weight is a share of the
              whole portfolio, so leaving a holding out of the total would overstate all the
              others and invent a drift that is not there. The engine skips the rule entirely
              rather than report weights it knows are wrong.
            </div>
          )}

          <Card
            title="Your targets"
            action={
              <Button variant="ghost" onClick={targets.spreadEvenly}>
                Spread evenly
              </Button>
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-text-muted">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Holding</th>
                    <th className="py-2 pr-3 text-right font-medium">Now</th>
                    <th className="py-2 pr-3 text-right font-medium">Target</th>
                    <th className="py-2 text-right font-medium">Drift</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <Row key={row.symbol} row={row} />
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border-subtle text-text-muted">
                    <td className="py-2 pr-3">Targeted</td>
                    <td className="py-2 pr-3 text-right" />
                    <td className="py-2 pr-3 text-right tabular-nums text-text-primary">
                      {unitsToPercent(targets.totalUnits)}%
                    </td>
                    <td className="py-2 text-right text-xs">
                      {targets.unallocatedUnits >= 0
                        ? `${unitsToPercent(targets.unallocatedUnits)}% not spoken for`
                        : `${unitsToPercent(-targets.unallocatedUnits)}% too much`}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <p className="mt-3 max-w-3xl text-xs text-text-muted">
              Leave a box empty for no target at all — that instrument is then never compared
              against anything. A target of <span className="tabular-nums">0</span> is a
              different statement: it means you meant to hold none of it, and everything you
              still hold counts as drift. Drift is reported once it reaches{' '}
              {unitsToPercent(DRIFT_BANDS.info)} percentage points, and is called high at{' '}
              {unitsToPercent(DRIFT_BANDS.high)}.
            </p>
          </Card>

          <div className="flex flex-wrap items-center justify-end gap-3">
            {targets.blockingIssue && (
              <span className="mr-auto text-sm text-loss">{targets.blockingIssue}</span>
            )}
            {targets.isDirty && !targets.blockingIssue && (
              <span className="mr-auto text-sm text-text-muted">
                Unsaved changes. Nothing is compared against these until you save.
              </span>
            )}
            {!targets.isDirty && targets.savedAt && (
              <span className="mr-auto text-sm text-text-muted">
                Saved. Drift is measured on the next scan, not immediately.
              </span>
            )}
            <Button variant="ghost" onClick={targets.discard} disabled={!targets.isDirty}>
              Discard
            </Button>
            <Button onClick={() => void targets.save()} disabled={!targets.canSave}>
              {targets.saving ? 'Saving…' : 'Save targets'}
            </Button>
          </div>
        </>
      )}

      {portfolio.isError && !portfolio.data && (
        <p className="text-xs text-text-muted">
          The portfolio has not loaded, so the current weights are unknown and no drift is
          shown. The targets themselves are unaffected.
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
  const tone = row.driftSeverity === null ? 'text-text-muted' : DRIFT_TONE[row.driftSeverity];

  return (
    <tr className="border-t border-border-subtle">
      <td className="py-2 pr-3">
        <span className="font-medium text-text-primary">{row.symbol}</span>
        {row.name && <span className="block text-xs text-text-muted">{row.name}</span>}
        {!row.held && (
          <span className="block text-xs text-text-muted">
            not held — the intention is kept, and holding none of it is itself the drift
          </span>
        )}
      </td>
      <td className="py-2 pr-3 text-right tabular-nums text-text-muted">
        {/* Unpriced is a known unknown and says so; it is never rendered as 0%. */}
        {row.actualUnits === null ? 'unpriced' : `${unitsToPercent(row.actualUnits)}%`}
      </td>
      <td className="py-2 pr-3 text-right">
        <div className="flex items-center justify-end gap-1">
          <input
            className={`input max-w-24 text-right tabular-nums ${row.invalid ? 'border-loss' : ''}`}
            type="text"
            inputMode="decimal"
            aria-label={`Target weight for ${row.symbol}, in percent`}
            aria-invalid={row.invalid}
            placeholder="—"
            value={row.targetText}
            onChange={(event) => targets.setTarget(row.symbol, event.target.value)}
          />
          <span className="text-text-muted">%</span>
        </div>
      </td>
      <td className={`py-2 text-right tabular-nums ${tone}`}>
        {row.driftUnits === null ? '—' : formatDriftPoints(row.driftUnits)}
      </td>
    </tr>
  );
});
