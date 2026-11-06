/**
 * What happened to a proposal, in words: the history rows and the audit trail.
 *
 * An expiry is said as what it is - nobody answered before the deadline - and
 * never as a decision, because "Expired" beside "Approved" and "Rejected" reads
 * as a third choice the user made.
 */

import type { DecisionSurface, Proposal, ProposalState, ProposalTransition } from '@traders/shared';

import { t } from '../i18n/index.ts';

export function stateWord(state: ProposalState): string {
  return t(`proposal.states.${state}`);
}

function surfaceWords(surface: DecisionSurface | null): string {
  switch (surface) {
    case 'telegram':
      return t('proposal.fromTelegram');
    case 'web':
      return t('proposal.inTheApp');
    default:
      return '';
  }
}

/**
 * A view a newer one closed before its deadline (D392, D393): the only expiry
 * recorded with its deadline still ahead. Nobody let this one lapse.
 */
export function closedByNewerView(
  proposal: Pick<Proposal, 'state'> & Partial<Pick<Proposal, 'decidedAt' | 'expiresAt'>>,
): boolean {
  return (
    proposal.state === 'expired' &&
    proposal.decidedAt != null &&
    proposal.expiresAt !== undefined &&
    new Date(proposal.decidedAt).getTime() < new Date(proposal.expiresAt).getTime()
  );
}

/** One history row's outcome: "Approved from Telegram", "Expired unanswered". */
export function outcomeText(
  proposal: Pick<Proposal, 'state' | 'decidedVia'> & Partial<Pick<Proposal, 'decidedAt' | 'expiresAt'>>,
): string {
  if (closedByNewerView(proposal)) return t('proposal.closedByNewerView');
  if (proposal.state === 'expired') return t('proposal.expiredUnanswered');
  const where = surfaceWords(proposal.decidedVia);
  return where ? t('proposal.outcome', { state: stateWord(proposal.state), where }) : stateWord(proposal.state);
}

/** One audit-trail entry: "Open → Approved, from Telegram", "Open → Expired, at its deadline". */
export function transitionText(transition: ProposalTransition, expiresAt?: string): string {
  // The arrow is the catalogue's: it points along the reading direction.
  const move = t('proposal.move', { from: stateWord(transition.from), to: stateWord(transition.to) });
  if (!transition.byUser) {
    // Recorded when the sweep noticed, which can be hours after the deadline
    // itself - so the time beside this entry is not called the deadline.
    if (transition.to !== 'expired') return t('proposal.bySystem', { move });
    return expiresAt !== undefined && new Date(transition.at).getTime() < new Date(expiresAt).getTime()
      ? t('proposal.closedByNewerViewMove', { move })
      : t('proposal.recordedAfterDeadline', { move });
  }
  const where = surfaceWords(transition.surface);
  // An approval moved back to Open is an undo; saying so beats an arrow backwards.
  if (transition.from === 'approved' && transition.to === 'pending') {
    return where ? t('proposal.undoneWhere', { where }) : t('proposal.undone');
  }
  return where ? t('proposal.moveWhere', { move, where }) : move;
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
  if (closedByNewerView(proposal)) return proposal.decidedAt;
  return proposal.state === 'expired' ? proposal.expiresAt : proposal.decidedAt;
}
