import { observer } from 'mobx-react-lite';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, ShieldCheck } from 'lucide-react';

import type { Proposal, ProposalTransition } from '@traders/shared';

import { errorMessage } from '../api/client.ts';
import { Disclaimer } from '../components/Disclaimer.tsx';
import { EvidenceDrawer } from '../components/EvidenceDrawer.tsx';
import { ProposalCard, UndoButton } from '../components/ProposalCards.tsx';
import { Card, EmptyState, ErrorNote, Spinner, buttonClass } from '../components/ui.tsx';
import { subjectLabel } from '../lib/observationPresentation.ts';
import { baseCurrencyOf } from '../lib/portfolioView.ts';
import { outcomeAt, outcomeText, transitionText } from '../lib/proposalOutcome.ts';
import { formatExactTime } from '../lib/relativeTime.ts';
import { MIRROR_IN_RTL, SERVER_ENGLISH } from '../lib/textDirection.ts';
import { usePortfolioQuery } from '../queries/portfolio.ts';
import { useProposalQuery } from '../queries/proposals.ts';
import { useStore } from '../stores/context.tsx';
import { OutcomeBadge } from './ProposalsPage.tsx';

/**
 * One proposal at its own address: what a Telegram message links to (FR-21),
 * and where "what happened to this?" is answered by the audit trail.
 *
 * An open proposal is decided here exactly as in the inbox - the same card,
 * the same store, the same refusal handling. A decided one shows its outcome
 * and evidence, and no button: nothing can be done to it any more, except an
 * Undo inside its window.
 */
export const ProposalPage = observer(function ProposalPage() {
  const { proposalId } = useParams({ from: '/proposals/$proposalId' });
  const detail = useProposalQuery(proposalId);
  const portfolio = usePortfolioQuery();
  const { proposals } = useStore();
  const baseCurrency = baseCurrencyOf(portfolio.data);
  const proposal = detail.data?.proposal ?? null;

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-base font-semibold">Proposal</h1>
        <Link to="/proposals" className={buttonClass('secondary')}>
          <span className="flex items-center gap-1">
            <ArrowLeft className={`size-4 ${MIRROR_IN_RTL}`} aria-hidden />
            All proposals
          </span>
        </Link>
      </header>

      {detail.isPending && <Spinner label="Loading the proposal…" />}
      {detail.error && detail.data === undefined && (
        <ErrorNote
          message={errorMessage(detail.error, 'Could not load this proposal.')}
          onRetry={() => void detail.refetch()}
        />
      )}
      {detail.data === null && (
        <EmptyState
          title="No such proposal"
          body="This address does not match a proposal in your account. The link may be from another account, or mistyped."
          action={
            <Link to="/proposals" className={buttonClass('primary')}>
              All proposals
            </Link>
          }
        />
      )}

      {proposal && (
        <>
          {(proposal.state === 'pending' || proposal.state === 'snoozed') && (
            <>
              <Card>
                <p className="flex items-start gap-2 text-sm text-text-muted">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
                  <span>
                    Approving records your intention in this app&rsquo;s own ledger. No order is
                    ever placed and no broker is contacted.
                  </span>
                </p>
              </Card>
              {proposals.decisionError !== null && <ErrorNote message={proposals.decisionError} />}
              <ProposalCard proposal={proposal} baseCurrency={baseCurrency} linkToPage={false} />
            </>
          )}
          {(proposal.state !== 'pending' && proposal.state !== 'snoozed') && (
            <DecidedCard proposal={proposal} baseCurrency={baseCurrency} />
          )}
          <SubjectLink proposal={proposal} />
          <TrailCard transitions={detail.data?.transitions ?? []} createdAt={proposal.createdAt} />
        </>
      )}

      <Disclaimer />
    </div>
  );
});

/** A decided proposal: its outcome, what it asked, and the figures - no buttons. */
function DecidedCard({ proposal, baseCurrency }: { proposal: Proposal; baseCurrency: string }) {
  return (
    <Card>
      <div className="space-y-2">
        <p className="text-xs text-text-muted">
          <OutcomeBadge proposal={proposal} />{' '}
          {outcomeAt(proposal) !== null && formatExactTime(outcomeAt(proposal))}
        </p>
        <h2 {...SERVER_ENGLISH} className="text-sm font-semibold text-text-primary">{proposal.headline}</h2>
        {proposal.explanation !== null && (
          <p {...SERVER_ENGLISH} className="text-sm text-text-muted">{proposal.explanation}</p>
        )}
        <p className="text-xs text-text-muted">
          {proposal.state === 'expired'
            ? `Nobody answered it before its deadline, ${formatExactTime(proposal.expiresAt)}.`
            : proposal.undoableUntil !== null
              ? `${outcomeText(proposal)}. It can be undone for a few seconds more.`
              : `${outcomeText(proposal)}. It can no longer be changed.`}
        </p>
        {proposal.state === 'approved' && <UndoButton proposal={proposal} />}
        <EvidenceDrawer
          evidence={proposal.evidence}
          baseCurrency={baseCurrency}
          id={`proposal-evidence-${proposal.id}`}
        />
      </div>
    </Card>
  );
}

/** A link to the holding the proposal is about, when it is one the user still holds. */
function SubjectLink({ proposal }: { proposal: Proposal }) {
  const portfolio = usePortfolioQuery();
  if (proposal.subjectRef === null) return null;
  const symbol = subjectLabel(proposal.subjectRef, proposal.evidence);
  const holding = portfolio.data?.holdings.find((row) => row.instrument.symbol === symbol);
  if (!holding) return null;
  return (
    <p className="text-sm">
      <Link
        to="/holdings/$holdingId"
        params={{ holdingId: holding.id }}
        className="text-accent hover:underline"
      >
        {symbol}&rsquo;s page
      </Link>
      <span className="text-text-muted"> - its price, its other findings and its news.</span>
    </p>
  );
}

/** The audit trail: every state change, who or what made it, and when. Oldest first. */
function TrailCard({ transitions, createdAt }: { transitions: ProposalTransition[]; createdAt: string }) {
  const ordered = [...transitions].sort((a, b) => a.at.localeCompare(b.at));
  return (
    <Card title="What happened">
      <ol className="space-y-1.5 text-sm">
        <li className="flex flex-wrap justify-between gap-x-3">
          <span>Proposed</span>
          <span className="text-xs text-text-muted">{formatExactTime(createdAt)}</span>
        </li>
        {ordered.map((transition) => (
          <li key={`${transition.at}-${transition.to}`} className="flex flex-wrap justify-between gap-x-3">
            <span>{transitionText(transition)}</span>
            <span className="text-xs text-text-muted">{formatExactTime(transition.at)}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}
