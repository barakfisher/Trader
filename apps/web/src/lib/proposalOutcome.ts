/**
 * What happened to a proposal, in words: the history rows and the audit trail.
 *
 * An expiry is said as what it is - nobody answered before the deadline - and
 * never as a decision, because "Expired" beside "Approved" and "Rejected" reads
 * as a third choice the user made.
 */

import type { DecisionSurface, Proposal, ProposalState, ProposalTransition } from '@traders/shared';

const STATE_WORDS: Record<ProposalState, string> = {
  pending: 'Open',
  snoozed: 'Snoozed',
  approved: 'Approved',
  rejected: 'Rejected',
  expired: 'Expired',
};

export function stateWord(state: ProposalState): string {
  return STATE_WORDS[state];
}

function surfaceWords(surface: DecisionSurface | null): string {
  switch (surface) {
    case 'telegram':
      return 'from Telegram';
    case 'web':
      return 'in the app';
    default:
      return '';
  }
}

/** One history row's outcome: "Approved from Telegram", "Expired unanswered". */
export function outcomeText(proposal: Pick<Proposal, 'state' | 'decidedVia'>): string {
  if (proposal.state === 'expired') return 'Expired unanswered';
  const where = surfaceWords(proposal.decidedVia);
  return where ? `${stateWord(proposal.state)} ${where}` : stateWord(proposal.state);
}

/** One audit-trail entry: "Open → Approved, from Telegram", "Open → Expired, at its deadline". */
export function transitionText(transition: ProposalTransition): string {
  const move = `${stateWord(transition.from)} → ${stateWord(transition.to)}`;
  if (!transition.byUser) {
    // Recorded when the sweep noticed, which can be hours after the deadline
    // itself - so the time beside this entry is not called the deadline.
    return transition.to === 'expired'
      ? `${move}, recorded after its deadline passed`
      : `${move}, by the system`;
  }
  // An approval moved back to Open is an undo; saying so beats an arrow backwards.
  if (transition.from === 'approved' && transition.to === 'pending') {
    return `Approval undone ${surfaceWords(transition.surface)}`.trim();
  }
  return `${move}, ${surfaceWords(transition.surface)}`.replace(/, $/, '');
}

/**
 * The tone of a state's badge. Not green and red: those mean gain and loss in
 * this app (decision 66), and an approval is neither. An expiry is the one to
 * notice - a question that went unanswered - so it takes the warning tone.
 */
export function outcomeTone(state: ProposalState): 'accent' | 'warn' | 'muted' {
  if (state === 'approved') return 'accent';
  if (state === 'expired') return 'warn';
  return 'muted';
}

/**
 * When a proposal's outcome happened. An expiry happened at its deadline, not
 * when the sweep got round to recording it (`decidedAt`), which on this machine
 * has been four hours later.
 */
export function outcomeAt(proposal: Pick<Proposal, 'state' | 'decidedAt' | 'expiresAt'>): string | null {
  return proposal.state === 'expired' ? proposal.expiresAt : proposal.decidedAt;
}
