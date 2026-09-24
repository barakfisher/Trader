import { makeAutoObservable, runInAction } from 'mobx';

import type {
  DecisionResponse,
  Proposal,
  ProposalAction,
  ProposalsResponse,
} from '@traders/shared';

/** Open questions first, then recent approvals; one row per proposal. */
function merge(open: Proposal[], approved: Proposal[]): Proposal[] {
  const seen = new Set<string>();
  return [...open, ...approved].filter((proposal) => {
    if (seen.has(proposal.id)) return false;
    seen.add(proposal.id);
    return true;
  });
}

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
 * How often an open inbox re-reads the server.
 *
 * A decision can arrive from Telegram at any moment, and a page that only
 * loads on mount goes on offering Approve on something the user already
 * approved from their phone. Fifteen seconds is well inside the time anybody
 * spends reading a card, and a focus event refreshes sooner.
 */
export const REFRESH_INTERVAL_MS = 15_000;

/** How many recent approvals the inbox keeps within reach of Undo. */
export const RECENT_APPROVALS = 10;

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
 * **The page keeps re-reading while it is open.** A tap in Telegram changes a
 * proposal without this page doing anything, so it refreshes on an interval and
 * on window focus; see `REFRESH_INTERVAL_MS`.
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

  /**
   * The action in flight for each proposal. A map rather than a set so the
   * button that was clicked can say "Approving…" while its siblings are merely
   * disabled - the user sees which choice registered, not just that one did.
   */
  deciding = new Map<string, ProposalAction>();

  private refreshTimer: ReturnType<typeof setInterval> | null = null;

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

  /**
   * Approvals still within reach of Undo, newest decision first. Approved is
   * terminal, so the stored state and the computed one cannot disagree here.
   */
  get recentlyApproved(): Proposal[] {
    return this.proposals
      .filter((proposal) => proposal.state === 'approved')
      .sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''));
  }

  /** What the dashboard badge counts. */
  get openCount(): number {
    return this.open.length;
  }

  /** Nothing waiting. Recent approvals do not count: they are answers, not questions. */
  get isEmpty(): boolean {
    return !this.loading && this.open.length === 0;
  }

  isDeciding(proposalId: string): boolean {
    return this.deciding.has(proposalId);
  }

  /** Which action is in flight for a proposal, if any. */
  decidingAction(proposalId: string): ProposalAction | null {
    return this.deciding.get(proposalId) ?? null;
  }

  async load(): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      await this.fetchBoth();
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

  private async fetchBoth(): Promise<void> {
    const [open, approved] = await Promise.all([
      api.get<ProposalsResponse>('/proposals?state=open'),
      api.get<ProposalsResponse>(`/proposals?state=approved&limit=${RECENT_APPROVALS}`),
    ]);
    runInAction(() => {
      this.proposals = merge(open.proposals, approved.proposals);
    });
  }

  /**
   * Re-read the server without the loading state, so the page does not flash.
   *
   * Skipped while a decision is in flight: the response to that decision is
   * the fresher truth for its card, and a refresh that landed first and was
   * then overwritten - or the reverse - would make the card flicker between
   * two answers. A failure is silent for the same reason a background poll
   * should be: the last good view stays up and the next tick tries again.
   */
  async refresh(): Promise<void> {
    if (this.loading || this.deciding.size > 0) return;
    try {
      await this.fetchBoth();
    } catch {
      // Deliberately quiet; see above.
    }
  }

  /** Keep the inbox current while it is on screen. Returns the stop function. */
  startAutoRefresh(): () => void {
    this.stopAutoRefresh();
    this.refreshTimer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
    const onFocus = () => void this.refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      this.stopAutoRefresh();
      window.removeEventListener('focus', onFocus);
    };
  }

  stopAutoRefresh(): void {
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  async decide(proposalId: string, action: ProposalAction): Promise<void> {
    // One decision per proposal at a time, whichever button: the buttons are
    // disabled too, but a double click can land before the re-render does.
    if (this.deciding.has(proposalId)) return;
    runInAction(() => {
      this.deciding.set(proposalId, action);
      this.refusal = null;
    });
    let fetchUndoWindow = false;

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
            ? {
                ...proposal,
                state: result.state,
                storedState: result.state,
                // Only used to order the recent approvals, so the one just
                // made sits at the top until the next refresh brings the
                // server's timestamp.
                decidedAt: result.outcome === 'applied' ? new Date().toISOString() : proposal.decidedAt,
                // Not guessed: the server's own window arrives with the next
                // read, which is requested straight after an approval.
                undoableUntil: result.state === 'approved' ? proposal.undoableUntil : null,
              }
            : proposal,
        );
      });
      // The undo window is the server's to state; fetch it straight away
      // rather than on the next tick, or Undo would appear up to 15s late.
      fetchUndoWindow = result.outcome === 'applied' && result.state === 'approved';
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
    // After `finally`, so the refresh does not see this decision in flight.
    if (fetchUndoWindow) await this.refresh();
  }

  /** Signing out must not leave one account's questions on screen for the next. */
  reset(): void {
    this.proposals = [];
    this.loading = false;
    this.error = null;
    this.refusal = null;
    this.deciding.clear();
    this.stopAutoRefresh();
  }
}
