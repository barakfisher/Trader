/**
 * The approvals inbox as server state: the open questions and the approvals
 * still within reach of Undo, as one list.
 *
 * Decisions are not here. They stay in `ProposalsStore`, because a decision
 * needs a synchronous guard - one per proposal, whichever button, even when a
 * double click lands before the re-render - and a per-button label that two
 * card components share. The store writes the server's answer into this cache;
 * it holds no copy of the list.
 */

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  Proposal,
  ProposalDetailResponse,
  ProposalsResponse,
  TradeApprovalPreview,
  TradeApprovalResult,
} from '@traders/shared';

import { ApiRequestError, api } from '../api/client.ts';
import { useStore } from '../stores/context.tsx';
import { queryKeys } from './queryKeys.ts';

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

/** Open questions first, then recent approvals; one row per proposal. */
function merge(open: Proposal[], approved: Proposal[]): Proposal[] {
  const seen = new Set<string>();
  return [...open, ...approved].filter((proposal) => {
    if (seen.has(proposal.id)) return false;
    seen.add(proposal.id);
    return true;
  });
}

export const proposalsQuery = queryOptions({
  queryKey: queryKeys.proposals,
  queryFn: async () => {
    const [open, approved] = await Promise.all([
      api.get<ProposalsResponse>('/proposals?state=open'),
      api.get<ProposalsResponse>(`/proposals?state=approved&limit=${RECENT_APPROVALS}`),
    ]);
    return merge(open.proposals, approved.proposals);
  },
});

/**
 * Open questions only.
 *
 * Filtered on the computed `state`, never on `storedState`: between a deadline
 * passing and the sweep noticing, the row still says pending and the proposal
 * is not.
 */
export function openProposals(proposals: Proposal[] | undefined): Proposal[] {
  return (proposals ?? []).filter(
    (proposal) => proposal.state === 'pending' || proposal.state === 'snoozed',
  );
}

/**
 * Approvals still within reach of Undo, newest decision first. Approved is
 * terminal, so the stored state and the computed one cannot disagree here.
 */
export function recentlyApproved(proposals: Proposal[] | undefined): Proposal[] {
  return (proposals ?? [])
    .filter((proposal) => proposal.state === 'approved')
    .sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''));
}

/**
 * The background re-read while the inbox is on screen, paused while a decision
 * is in flight: that decision's answer is the fresher truth for its card, and a
 * read landing on either side of it would make the card flicker between two.
 */
export function inboxRefetchInterval(decisionsInFlight: number): number | false {
  return decisionsInFlight > 0 ? false : REFRESH_INTERVAL_MS;
}

/**
 * The inbox. `live` is for the inbox page itself: it re-reads on an interval.
 * Elsewhere (the dashboard badge) one read, refreshed on focus, is enough.
 *
 * **Call it from a MobX `observer`.** The in-flight count is read during render,
 * not inside a callback, because TanStack Query evaluates a `refetchInterval`
 * function only when the query itself updates: starting a decision changes
 * nothing it watches, so the timer kept running through the decision. Read
 * here, the count re-renders the caller and the option changes with it.
 */
export function useProposalsQuery({ live = false }: { live?: boolean } = {}) {
  const { proposals } = useStore();
  const inFlight = proposals.deciding.size;
  return useQuery({
    ...proposalsQuery,
    refetchInterval: live ? inboxRefetchInterval(inFlight) : false,
    refetchOnWindowFocus: inFlight === 0,
  });
}

/** How many decided proposals the inbox's history shows: the latest page, not an archive. */
export const HISTORY_PAGE = 20;

/**
 * What happened to past proposals: approved, rejected, and expired - the last
 * being the outcome nobody chose, and the one a user most needs to be able to
 * find ("I never saw that one"). Newest decision first.
 */
export const proposalHistoryQuery = queryOptions({
  queryKey: queryKeys.proposalHistory,
  queryFn: async () =>
    (await api.get<ProposalsResponse>(`/proposals?state=history&limit=${HISTORY_PAGE}`)).proposals,
});

export function useProposalHistoryQuery() {
  return useQuery(proposalHistoryQuery);
}

/**
 * One proposal and its audit trail. A 404 resolves as `null`: "no such
 * proposal" is an answer a stale link gets, not a failure to retry.
 */
export function proposalQuery(proposalId: string) {
  return queryOptions({
    queryKey: queryKeys.proposal(proposalId),
    queryFn: async (): Promise<ProposalDetailResponse | null> => {
      try {
        return await api.get<ProposalDetailResponse>(`/proposals/${encodeURIComponent(proposalId)}`);
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 404) return null;
        throw error;
      }
    },
  });
}

/**
 * A proposal's page is live like the inbox: a Telegram tap can decide it while
 * it is on screen, and a page still offering Approve on it is the thing to avoid.
 */
export function useProposalQuery(proposalId: string) {
  const { proposals } = useStore();
  const inFlight = proposals.deciding.size;
  return useQuery({
    ...proposalQuery(proposalId),
    refetchInterval: inboxRefetchInterval(inFlight),
    refetchOnWindowFocus: inFlight === 0,
  });
}

/** Everything in the history except what the undo section is still showing. */
export function decidedHistory(
  history: Proposal[] | undefined,
  shownAbove: ReadonlySet<string>,
): Proposal[] {
  return (history ?? []).filter((proposal) => !shownAbove.has(proposal.id));
}

/**
 * *Approve* on a trade proposal: the server prices it at the live quote beside
 * the agent's price (D47). Writes nothing; a refusal is recorded server-side and
 * leaves the proposal pending (D49), so the inbox is re-read either way.
 */
export function usePreviewTradeApproval(proposalId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<TradeApprovalPreview>(`/proposals/${proposalId}/preview`, {}),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.proposal(proposalId) }),
  });
}

/**
 * *Confirm*: the fill and the approval in one transaction. A success moves the
 * agent's cash and holdings, so the agents and the consolidated view are re-read
 * with the inbox.
 */
export function useConfirmTradeApproval(proposalId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (shownPriceMinor: number) =>
      api.post<TradeApprovalResult>(`/proposals/${proposalId}/confirm`, { shownPriceMinor }),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.proposals }),
        client.invalidateQueries({ queryKey: queryKeys.agents }),
        client.invalidateQueries({ queryKey: queryKeys.consolidated }),
      ]),
  });
}
