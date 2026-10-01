import { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Link } from '@tanstack/react-router';
import { Undo2 } from 'lucide-react';

import type { Proposal, ProposalAction } from '@traders/shared';

import { isUrgent, snoozeDescription, timeLeft } from '../lib/proposalCountdown.ts';
import { formatExactTime } from '../lib/relativeTime.ts';
import { SERVER_ENGLISH } from '../lib/textDirection.ts';
import { undoSecondsLeft } from '../lib/undoWindow.ts';
import { SNOOZE_HOURS } from '../stores/ProposalsStore.ts';
import { useStore } from '../stores/context.tsx';
import { EvidenceDrawer } from './EvidenceDrawer.tsx';
import { Button, Card } from './ui.tsx';

/**
 * A proposal as a card: the open question with its evidence and buttons, or an
 * approval still inside its Undo window. Shared by the inbox and a proposal's
 * own page, so a decision looks and behaves the same from either.
 */

/** The headline, as a link to the proposal's own page unless it is that page. */
function ProposalHeadline({ proposal, link }: { proposal: Proposal; link: boolean }) {
  if (!link) return <>{proposal.headline}</>;
  return (
    <Link
      to="/proposals/$proposalId"
      params={{ proposalId: proposal.id }}
      className="hover:text-accent hover:underline"
    >
      {proposal.headline}
    </Link>
  );
}

/** What the clicked button says while its action is in flight. */
const IN_FLIGHT_LABELS: Record<ProposalAction, string> = {
  approve: 'Approving…',
  reject: 'Rejecting…',
  snooze: 'Snoozing…',
  undo: 'Undoing…',
};

/**
 * The current time, re-read every second while `active` - enough to count an
 * undo window down without re-rendering a page that has nothing ticking.
 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * An approval, and - for its first 30 seconds - the one thing still possible
 * on it.
 *
 * Undo withdraws the approval from the ledger - the row is marked revoked, not
 * erased - and puts the question back in the inbox above, unless its deadline
 * has passed, in which case it simply expires. The button counts down and then
 * goes, because an Undo that is shown after the server stopped accepting it is
 * a button that can only be refused.
 */
export const ApprovedCard = observer(function ApprovedCard({
  proposal,
  linkToPage = true,
}: {
  proposal: Proposal;
  linkToPage?: boolean;
}) {
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          <p className="text-sm text-text-primary">
            <ProposalHeadline proposal={proposal} link={linkToPage} />
          </p>
          <p className="text-xs text-text-muted">
            Approved
            {proposal.decidedVia === 'telegram' ? ' from Telegram' : ''}
            {proposal.decidedAt !== null && ` at ${formatExactTime(proposal.decidedAt)}`}
          </p>
        </div>
        <UndoButton proposal={proposal} />
      </div>
    </Card>
  );
});

/**
 * Undo, counting down, for an approval inside its window - and nothing once the
 * window closes, because an Undo shown after the server stopped accepting it is
 * a button that can only be refused. A refusal is said beside it.
 */
export const UndoButton = observer(function UndoButton({ proposal }: { proposal: Proposal }) {
  const { proposals } = useStore();
  const inFlight = proposals.decidingAction(proposal.id);
  const now = useNow(proposal.undoableUntil !== null);
  const secondsLeft = undoSecondsLeft(proposal.undoableUntil, now);
  const refusal =
    proposals.refusal?.proposalId === proposal.id ? proposals.refusal.message : null;
  if (secondsLeft === null && inFlight !== 'undo' && refusal === null) return null;

  return (
    <div className="space-y-1">
      {(secondsLeft !== null || inFlight === 'undo') && (
        <Button
          variant="secondary"
          disabled={inFlight !== null}
          onClick={() => void proposals.decide(proposal.id, 'undo')}
        >
          <span className="flex items-center gap-1.5">
            <Undo2 className="size-4" aria-hidden />
            {inFlight === 'undo' ? IN_FLIGHT_LABELS.undo : `Undo approval (${secondsLeft}s)`}
          </span>
        </Button>
      )}
      {refusal !== null && <p className="text-xs text-loss">{refusal}</p>}
    </div>
  );
});

export const ProposalCard = observer(function ProposalCard({
  proposal,
  baseCurrency,
  linkToPage = true,
}: {
  proposal: Proposal;
  baseCurrency: string;
  /** False on the proposal's own page, where the headline would link to itself. */
  linkToPage?: boolean;
}) {
  const { proposals } = useStore();
  const inFlight = proposals.decidingAction(proposal.id);
  // Every button is disabled while any one is in flight; only the clicked one
  // changes its label, so the user can see which choice registered.
  const deciding = inFlight !== null;
  const label = (action: ProposalAction, idle: string) =>
    inFlight === action ? IN_FLIGHT_LABELS[action] : idle;
  const remaining = timeLeft(proposal.expiresAt);
  const urgent = isUrgent(proposal.expiresAt);
  const snoozed = proposal.state === 'snoozed' ? snoozeDescription(proposal.snoozedUntil) : null;
  const refusal =
    proposals.refusal?.proposalId === proposal.id ? proposals.refusal.message : null;

  return (
    <Card>
      <div className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-1">
            <h2 {...SERVER_ENGLISH} className="text-sm font-semibold text-text-primary">
              <ProposalHeadline proposal={proposal} link={linkToPage} />
            </h2>
            {proposal.explanation !== null && (
              <p {...SERVER_ENGLISH} className="text-sm text-text-muted">{proposal.explanation}</p>
            )}
          </div>
          <span
            // Urgency is a threshold, not a gradient: the only decision it
            // drives is whether to draw the eye, and a continuously changing
            // colour would claim a precision the deadline does not have.
            className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
              urgent ? 'bg-loss/15 text-loss' : 'bg-surface-hover text-text-muted'
            }`}
            title={formatExactTime(proposal.expiresAt)}
          >
            {remaining ?? 'expired'}
          </span>
        </div>

        {snoozed !== null && <p className="text-xs text-text-muted">{snoozed}</p>}

        {/* Before the buttons, always open: an approval is the one place the
            user acts on a claim, so its figures are not one click away. Read
            through `readEvidence` - money in its currency, fractions as
            percentages - not printed as raw keys ("value minor 3502842"). */}
        <EvidenceDrawer
          evidence={proposal.evidence}
          baseCurrency={baseCurrency}
          id={`proposal-evidence-${proposal.id}`}
        />

        {refusal !== null && (
          // Rendered against the proposal it concerned rather than as a page
          // banner: "this one expired while you were reading" is about a
          // specific card, and a global message would leave the user hunting.
          <p className="rounded-lg border border-loss/40 bg-loss/10 px-3 py-2 text-xs text-loss">
            {refusal}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button disabled={deciding} onClick={() => void proposals.decide(proposal.id, 'approve')}>
            {label('approve', 'Approve')}
          </Button>
          <Button
            variant="secondary"
            disabled={deciding}
            onClick={() => void proposals.decide(proposal.id, 'snooze')}
          >
            {label('snooze', `Snooze ${SNOOZE_HOURS}h`)}
          </Button>
          <Button
            variant="danger"
            disabled={deciding}
            onClick={() => void proposals.decide(proposal.id, 'reject')}
          >
            {label('reject', 'Reject')}
          </Button>
        </div>
      </div>
    </Card>
  );
});

