import { observer } from 'mobx-react-lite';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, Inbox, ShieldCheck } from 'lucide-react';

import type { Proposal } from '@traders/shared';

import { Disclaimer } from '../components/Disclaimer.tsx';
import { ApprovedCard, ProposalCard, useNow } from '../components/ProposalCards.tsx';
import { Card, EmptyState, ErrorNote, Spinner, buttonClass } from '../components/ui.tsx';
import { errorMessage } from '../api/client.ts';
import { useTranslation } from '../i18n/index.ts';
import { baseCurrencyOf } from '../lib/portfolioView.ts';
import { outcomeAt, outcomeText, outcomeTone } from '../lib/proposalOutcome.ts';
import { formatExactTime } from '../lib/relativeTime.ts';
import { observationText } from '../lib/observationText.ts';
import { MIRROR_IN_RTL } from '../lib/textDirection.ts';
import { undoSecondsLeft } from '../lib/undoWindow.ts';
import { usePortfolioQuery } from '../queries/portfolio.ts';
import {
  HISTORY_PAGE,
  decidedHistory,
  openProposals,
  recentlyApproved,
  useProposalHistoryQuery,
  useProposalsQuery,
} from '../queries/proposals.ts';
import { useStore } from '../stores/context.tsx';

/**
 * The approvals inbox.
 *
 * Three things about this page are deliberate and would be wrong if done the
 * obvious way.
 *
 * **Every proposal shows its evidence before its buttons.** The product's
 * central rule is that a claim without its data is not shippable, and an
 * approval is the one place a user acts on a claim rather than merely reading
 * it. Asking someone to approve something whose figures are one click away, in
 * a drawer, would be the moment that rule stopped meaning anything.
 *
 * **The deadline is stated on every card, not just implied by ordering.** A
 * proposal is answerable until a specific moment, and the ordering alone cannot
 * say when; a user who cannot see a deadline cannot tell an urgent question
 * from a patient one.
 *
 * **Nothing is rendered optimistically.** Every button on a card disables while
 * a decision is in flight - the clicked one says "Approving…" - and the card
 * re-renders from the server's answer. An approval
 * writes a ledger row, and a screen that says "Approved" for one the server
 * refused is the most expensive kind of wrong this product can be.
 */
export const ProposalsPage = observer(function ProposalsPage() {
  const { proposals } = useStore();
  const { t } = useTranslation();
  // Live: re-read on an interval and on focus while this page is open, because
  // a decision can arrive from Telegram at any moment (`REFRESH_INTERVAL_MS`).
  const inbox = useProposalsQuery({ live: true });
  const history = useProposalHistoryQuery();
  const baseCurrency = baseCurrencyOf(usePortfolioQuery().data);
  const open = openProposals(inbox.data);
  // Approvals Undo can still reach sit above the history; once their window
  // closes they are history like any other outcome. The clock ticks only while
  // an approval is inside its window.
  const approvals = recentlyApproved(inbox.data);
  const now = useNow(approvals.some((proposal) => proposal.undoableUntil !== null));
  const undoable = approvals.filter(
    (proposal) =>
      undoSecondsLeft(proposal.undoableUntil, now) !== null ||
      proposals.decidingAction(proposal.id) === 'undo',
  );
  const past = decidedHistory(history.data, new Set(undoable.map((proposal) => proposal.id)));
  // Nothing waiting. Recent approvals do not count: they are answers, not
  // questions. And only after a read succeeded: "nothing waiting on you" and
  // "we could not ask" must not look the same, because one of them means a
  // deadline may be passing unseen.
  const isEmpty = inbox.status === 'success' && open.length === 0;

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Inbox className="size-5 text-accent" aria-hidden />
          <h1 className="text-base font-semibold">{t('proposals.title')}</h1>
          {open.length > 0 && (
            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
              {t('proposals.open', { count: open.length })}
            </span>
          )}
        </div>
        <Link to="/" className={buttonClass('ghost')}>
          <span className="flex items-center gap-1.5">
            <ArrowLeft className={`size-4 ${MIRROR_IN_RTL}`} aria-hidden />
            {t('common.backToPortfolio')}
          </span>
        </Link>
      </header>

      {/*
        Said once, at the top, rather than on every card. Approving records an
        intention in a ledger this product owns; nothing is ever sent to a
        broker, and a user about to press a button labelled "Approve" should not
        have to infer that.
      */}
      <Card>
        <p className="flex items-start gap-2 text-sm text-text-muted">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
          <span>{t('proposals.ledgerOnly')}</span>
        </p>
      </Card>

      {inbox.isPending && <Spinner label={t('proposals.loading')} />}

      {/* A failed background read after a good one keeps the cards and says
          nothing: the last good view stays up and the next tick tries again. */}
      {inbox.error && inbox.data === undefined && (
        <ErrorNote
          message={errorMessage(inbox.error, t('proposals.loadFailed'))}
          onRetry={() => void inbox.refetch()}
        />
      )}

      {proposals.decisionError !== null && <ErrorNote message={proposals.decisionError} />}

      {isEmpty && (
        <EmptyState
          title={t('proposals.emptyTitle')}
          body={t('proposals.emptyBody')}
          action={
            <Link to="/settings" className={buttonClass('secondary')}>
              {t('proposals.openSettings')}
            </Link>
          }
        />
      )}

      <div className="space-y-3">
        {open.map((proposal) => (
          <ProposalCard key={proposal.id} proposal={proposal} baseCurrency={baseCurrency} />
        ))}
      </div>

      {undoable.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-text-muted">{t('proposals.justApproved')}</h2>
          {undoable.map((proposal) => (
            <ApprovedCard key={proposal.id} proposal={proposal} />
          ))}
        </section>
      )}

      <HistorySection
        proposals={past}
        isPending={history.isPending}
        error={history.error}
        onRetry={() => void history.refetch()}
        full={(history.data?.length ?? 0) >= HISTORY_PAGE}
      />

      <Disclaimer />
    </div>
  );
});


/**
 * What happened to past proposals, newest decision first - an expiry included,
 * because a question nobody answered is the one a user most needs to find.
 */
function HistorySection({
  proposals,
  isPending,
  error,
  onRetry,
  full,
}: {
  proposals: Proposal[];
  isPending: boolean;
  error: Error | null;
  onRetry: () => void;
  /** True when the page is full, so older decisions exist beyond it. */
  full: boolean;
}) {
  const { t, i18n } = useTranslation();
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-text-muted">{t('proposals.history')}</h2>
      {isPending && <Spinner label={t('proposals.historyLoading')} />}
      {error && (
        <ErrorNote message={errorMessage(error, t('proposals.historyFailed'))} onRetry={onRetry} />
      )}
      {!isPending && !error && proposals.length === 0 && (
        <p className="text-sm text-text-muted">{t('proposals.historyEmpty')}</p>
      )}
      {proposals.length > 0 && (
        <Card>
          <ul className="divide-y divide-border-subtle/60">
            {proposals.map((proposal) => {
              const text = observationText(proposal, i18n.language);
              return (
                <li key={proposal.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0">
                  <Link
                    to="/proposals/$proposalId"
                    params={{ proposalId: proposal.id }}
                    {...text.attributes}
                    className="min-w-0 text-sm text-text-primary hover:text-accent hover:underline"
                  >
                    {text.headline}
                  </Link>
                  <span className="shrink-0 text-xs text-text-muted">
                    <OutcomeBadge proposal={proposal} />{' '}
                    {outcomeAt(proposal) !== null && formatExactTime(outcomeAt(proposal))}
                  </span>
                </li>
              );
            })}
          </ul>
          {full && (
            <p className="mt-3 text-xs text-text-muted">
              {t('proposals.historyFull', { count: HISTORY_PAGE })}
            </p>
          )}
        </Card>
      )}
    </section>
  );
}

export function OutcomeBadge({ proposal }: { proposal: Pick<Proposal, 'state' | 'decidedVia'> }) {
  const tone = outcomeTone(proposal.state);
  const classes =
    tone === 'accent'
      ? 'bg-accent/15 text-accent'
      : tone === 'warn'
        ? 'bg-warn/15 text-warn'
        : 'bg-surface-hover text-text-muted';
  return <span className={`rounded px-1.5 py-0.5 text-[11px] ${classes}`}>{outcomeText(proposal)}</span>;
}
