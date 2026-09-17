import { makeAutoObservable, runInAction } from 'mobx';

import type {
  DecisionResponse,
  Proposal,
  ProposalAction,
  ProposalsResponse,
} from '@traders/shared';

import { ApiRequestError, api } from '../api/client.ts';
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
 * The approvals inbox.
 *
 * Two things here exist because the server and the clock can disagree with what
 * is on screen, and both are about not lying to the user:
 *
 * **Decisions are applied to the server first, never optimistically.** An
 * optimistic update would show "Approved" for a proposal that expired thirty
 * seconds ago and was refused - and an approval is a ledger entry, so a UI that
 * claims one happened when it did not is the most expensive kind of wrong this
 * product can be. The button shows a pending state instead.
 *
 * **A refusal refreshes rather than just reporting.** When the server says a
 * proposal expired or was already decided elsewhere - a Telegram tap a second
 * earlier - the list is reloaded, because the user's screen is now describing a
 * world that has moved. That is what FLOWS.md F3 means by "here is the refreshed
 * view".
 */
export class ProposalsStore {
  proposals: Proposal[] = [];
  loading = false;
  error: string | null = null;

  /** Proposal ids with a decision in flight, so their buttons can be disabled. */
  deciding = new Set<string>();

  /** The last refusal, shown against the proposal it concerned. */
  refusal: { proposalId: string; message: string } | null = null;

  constructor(private readonly root: RootStore) {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  /**
   * Open questions only.
   *
   * Filtered on the computed `state`, never on `storedState`: between a
   * deadline passing and the sweep noticing, the row still says pending and the
   * proposal is not.
   */
  get open(): Proposal[] {
    return this.proposals.filter(
      (proposal) => proposal.state === 'pending' || proposal.state === 'snoozed',
    );
  }

  /** What the dashboard badge counts. */
  get openCount(): number {
    return this.open.length;
  }

  get isEmpty(): boolean {
    return !this.loading && this.proposals.length === 0;
  }

  isDeciding(proposalId: string): boolean {
    return this.deciding.has(proposalId);
  }

  async load(): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      const response = await api.get<ProposalsResponse>('/proposals?state=open');
      runInAction(() => {
        this.proposals = response.proposals;
      });
    } catch (error) {
      runInAction(() => {
        this.error =
          error instanceof ApiRequestError ? error.message : 'Could not load your proposals.';
      });
    } finally {
      runInAction(() => {
        this.loading = false;
      });
    }
  }

  async decide(proposalId: string, action: ProposalAction): Promise<void> {
    if (this.deciding.has(proposalId)) return;
    runInAction(() => {
      this.deciding.add(proposalId);
      this.refusal = null;
    });

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
      // response is to show what is true rather than an error.
      runInAction(() => {
        this.proposals = this.proposals.map((proposal) =>
          proposal.id === proposalId
            ? { ...proposal, state: result.state, storedState: result.state }
            : proposal,
        );
      });
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 422) {
        runInAction(() => {
          this.refusal = { proposalId, message: error.message };
        });
        // The screen is describing a world that has moved on. Reload rather
        // than leaving a stale row beside a message explaining it is stale.
        await this.load();
        return;
      }
      runInAction(() => {
        this.error =
          error instanceof ApiRequestError ? error.message : 'Could not record your decision.';
      });
    } finally {
      runInAction(() => {
        this.deciding.delete(proposalId);
      });
    }
  }

  /** Signing out must not leave one account's questions on screen for the next. */
  reset(): void {
    this.proposals = [];
    this.loading = false;
    this.error = null;
    this.refusal = null;
    this.deciding.clear();
  }
}
