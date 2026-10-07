import { makeAutoObservable, runInAction } from 'mobx';

import type { DecisionResponse, Proposal, ProposalAction } from '@traders/shared';

import { ApiRequestError, api } from '../api/client.ts';
import { queryKeys } from '../queries/queryKeys.ts';
import { t } from '../i18n/index.ts';
import type { RootStore } from './RootStore.ts';

/**
 * How long the Snooze button postpones a proposal.
 *
 * A fixed step rather than a date picker: the question a snooze answers is "not
 * now", and asking someone to choose a precise minute to be re-interrupted is
 * more decision than the action is worth. The same duration the Telegram button
 * uses, so the two surfaces do not quietly mean different things.
 */
export const SNOOZE_HOURS = 4;

/**
 * Decisions on proposals: what is in flight, and what the server refused.
 *
 * The proposals themselves are server state, in the query cache
 * (`queries/proposals.ts`). This store holds what exists only in this browser,
 * and it is about not lying to the user:
 *
 * **Decisions are applied to the server first, never optimistically.** An
 * optimistic update would show "Approved" for a proposal that expired thirty
 * seconds ago and was refused - and an approval is a ledger entry, so a UI that
 * claims one happened when it did not is the most expensive kind of wrong this
 * product can be. The button shows a pending state instead, and the card
 * changes only to the state the server answered with.
 *
 * **A refusal re-reads rather than just reporting.** When the server says a
 * proposal expired or was already decided elsewhere - a Telegram tap a second
 * earlier - the list is re-read, because the user's screen is now describing a
 * world that has moved. That is what FLOWS.md F3 means by "here is the
 * refreshed view".
 */
export class ProposalsStore {
  /**
   * The action in flight for each proposal. A map rather than a set so the
   * button that was clicked can say "Approving…" while its siblings are merely
   * disabled - the user sees which choice registered, not just that one did.
   */
  deciding = new Map<string, ProposalAction>();

  /** The last refusal, shown against the proposal it concerned. */
  refusal: { proposalId: string; message: string } | null = null;

  /** A decision that failed for a reason other than a refusal - the network, a 5xx. */
  decisionError: string | null = null;

  constructor(private readonly root: RootStore) {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  isDeciding(proposalId: string): boolean {
    return this.deciding.has(proposalId);
  }

  /** Which action is in flight for a proposal, if any. */
  decidingAction(proposalId: string): ProposalAction | null {
    return this.deciding.get(proposalId) ?? null;
  }

  async decide(proposalId: string, action: ProposalAction): Promise<void> {
    // One decision per proposal at a time, whichever button: the buttons are
    // disabled too, but a double click can land before the re-render does.
    if (this.deciding.has(proposalId)) return;
    this.deciding.set(proposalId, action);
    this.refusal = null;
    this.decisionError = null;
    const client = this.root.queryClient;
    // A background read already in flight predates this decision; landing
    // after the answer, it would put the old state back on the card.
    await client.cancelQueries({ queryKey: queryKeys.proposals });

    try {
      const body =
        action === 'snooze'
          ? {
              action,
              // Computed here and sent as an absolute instant, because the
              // server compares it against a deadline it wrote - sending a
              // duration would have the server resolve it against a different
              // clock from the one the user is looking at.
              snoozeUntil: new Date(Date.now() + SNOOZE_HOURS * 3_600_000).toISOString(),
            }
          : { action };

      const result = await api.post<DecisionResponse>(`/proposals/${proposalId}/decision`, body);
      // `applied` and `unchanged` are both successes. The second means somebody
      // already answered - possibly this user, on their phone - and the honest
      // response is to show what is true rather than an error. The card takes
      // the state the server answered with, until the re-read below replaces
      // the whole list.
      client.setQueryData<Proposal[]>(queryKeys.proposals, (proposals) =>
        proposals?.map((proposal) =>
          proposal.id === proposalId
            ? {
                ...proposal,
                state: result.state,
                storedState: result.state,
                // Only used to order the recent approvals, so the one just made
                // sits at the top until the server's timestamp arrives.
                decidedAt:
                  result.outcome === 'applied' ? new Date().toISOString() : proposal.decidedAt,
                // Not guessed: the server's own undo window arrives with the
                // re-read below, rather than on the next background tick.
                undoableUntil: result.state === 'approved' ? proposal.undoableUntil : null,
              }
            : proposal,
        ),
      );
    } catch (error) {
      runInAction(() => {
        if (error instanceof ApiRequestError && error.status === 422) {
          // About one card, not the page: "this one expired while you were
          // reading" is rendered against the proposal it concerned.
          this.refusal = { proposalId, message: error.message };
        } else {
          this.decisionError =
            error instanceof ApiRequestError ? error.message : t('errors.decisionFailed');
        }
      });
    } finally {
      runInAction(() => {
        this.deciding.delete(proposalId);
      });
    }
    // After every decision, and after `finally` so the background re-read is
    // running again: the server's list, with its undo windows, replaces the
    // patched card. After a refusal this is what removes the stale row.
    await client.invalidateQueries({ queryKey: queryKeys.proposals });
    // A rejected trade leaves the consolidated view's pending list (D63).
    void client.invalidateQueries({ queryKey: queryKeys.consolidated });
  }

  /** Signing out must not leave one account's refusals on screen for the next. */
  reset(): void {
    this.refusal = null;
    this.decisionError = null;
    this.deciding.clear();
  }
}
