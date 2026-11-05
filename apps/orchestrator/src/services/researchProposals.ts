/**
 * A research view that asks for an action becomes an acknowledge-only proposal
 * on the real portfolio (D390, D387 case 1).
 *
 * **What raises one:** the assigned research agent's latest rating of a stock
 * is Buy more, Trim or Sell (a holding) or Buy (a stock researched on its
 * own), and it differs from the agent's rating of that stock before it. A Trim
 * repeated every day is one proposal, not one a day; Hold, Wait and Avoid are a
 * bottom line on the research page and raise nothing. One proposal per rating,
 * ever (`research:<rating id>`), so a sweep repeated, or a view the user
 * already answered, writes nothing.
 *
 * **What closes one:** its deadline, the rating's own stale age
 * (`RESEARCH_STALE_DAYS` after the rating), or a newer rating of the same stock
 * in another word - the view changed, and two contradicting proposals on one
 * stock must never be open together. That close is an expiry by the system.
 *
 * **What approving does:** acknowledges. The intent records the assent; no
 * holding changes until the user records the trade they made at the broker
 * (D387). The `0085` trigger refuses a research proposal carrying a quantity or
 * a price, and any fill on the primary.
 *
 * **When:** in the proposal sweep, every fifteen minutes on every installation,
 * because the AI service rates in the background after answering 202 and
 * tells nobody when it finishes. A view reaches the inbox and Telegram within
 * one sweep of its rating; the research page shows the rating at once.
 */

import {
  RESEARCH_STALE_DAYS,
  UI_LANGUAGES,
  isActionableRating,
  type LocalizedTexts,
  type ResearchProposalPayload,
  type TranslatedLanguage,
} from '@traders/shared';

import {
  applyProposalTransition,
  createResearchProposal,
  getOrCreateUserSettings,
  getUser,
  listLatestResearchViews,
  listSupersededResearchProposals,
  type ResearchViewRow,
} from '../db/queries.js';
import { logger } from '../logger.js';
import { messagesFor } from '../notify/messages.js';
import type { Notifier } from '../notify/notifier.js';
import { isAdvisory } from './advisoryMode.js';
import { fanOut, settingsForNotification } from './notifications.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ResearchProposalSweep {
  superseded: number;
  raised: number;
}

/** Whether a view raises a proposal: an action, and a change from the agent's word before it. */
export function raisesProposal(view: Pick<ResearchViewRow, 'rating' | 'previous_rating'>): boolean {
  return isActionableRating(view.rating) && view.rating !== view.previous_rating;
}

/** A research proposal's deadline: when its rating goes stale (D293). */
export function researchProposalExpiry(ratedAt: Date): Date {
  return new Date(ratedAt.getTime() + RESEARCH_STALE_DAYS * DAY_MS);
}

/** Close the open views a newer rating changed, then raise the new ones. */
export async function sweepResearchProposals(notifier: Notifier, now: Date = new Date()): Promise<ResearchProposalSweep> {
  let superseded = 0;
  for (const row of await listSupersededResearchProposals()) {
    const result = await applyProposalTransition({
      proposalId: row.id,
      userId: row.user_id,
      fromState: row.state,
      toState: 'expired',
      // Nobody decided this; a newer view did.
      surface: 'system',
      actorUserId: null,
      snoozedUntil: null,
      evidenceSnapshot: row.evidence,
      idempotencyKey: null,
      intent: null,
      revokeIntent: false,
    });
    if (result.applied) superseded += 1;
  }

  let raised = 0;
  const since = new Date(now.getTime() - RESEARCH_STALE_DAYS * DAY_MS);
  for (const view of await listLatestResearchViews(since)) {
    if (!raisesProposal(view) || !(await isAdvisory(view.user_id))) continue;
    try {
      if (await raise(view, notifier, now)) raised += 1;
    } catch (error) {
      // One user's view must not stop the others', nor the sweep's expiries.
      logger().warn({ err: error, ratingId: view.rating_id }, 'research.proposal_failed');
    }
  }
  if (superseded + raised > 0) logger().info({ superseded, raised }, 'research.proposals');
  return { superseded, raised };
}

async function raise(view: ResearchViewRow, notifier: Notifier, now: Date): Promise<boolean> {
  if (!isActionableRating(view.rating)) return false;
  const action = view.rating;
  const payload: ResearchProposalPayload = {
    action,
    symbol: view.symbol,
    instrumentId: view.instrument_id,
    ratingId: view.rating_id,
    researchAgentId: view.agent_id,
    researchAgentName: view.agent_name,
  };
  const headlineIn = (language: string) => messagesFor(language).researchProposalHeadline(view.agent_name, action, view.symbol);
  // The rationale is in the language the agent wrote it (the user's, D390):
  // every UI language shows the catalogue's headline over the same words.
  const localized: LocalizedTexts = Object.fromEntries(
    UI_LANGUAGES.filter((language): language is TranslatedLanguage => language !== 'en').map((language) => [
      language,
      { headline: headlineIn(language), explanation: view.rationale },
    ]),
  );
  const created = await createResearchProposal({
    userId: view.user_id,
    primaryAgentId: view.primary_agent_id,
    payload,
    expiresAt: researchProposalExpiry(view.rated_at),
    headline: headlineIn('en'),
    rationale: view.rationale,
    localized,
    ratedAt: view.rated_at,
  });
  if (created === null) return false;
  logger().info({ proposalId: created.proposalId, ratingId: view.rating_id, action }, 'proposal.research_raised');

  // Told like a trade proposal (D60): a question to decide, so the severity
  // floor is ignored; quiet hours and a mute are not. A failure to announce is
  // logged: the proposal is written and in the inbox.
  try {
    const [settings, user] = await Promise.all([getOrCreateUserSettings(view.user_id), getUser(view.user_id)]);
    await fanOut(
      view.user_id,
      view.primary_agent_id,
      [
        {
          refKind: 'observation',
          refId: created.observationId,
          severity: 'notable',
          headline: headlineIn('en'),
          explanation: view.rationale,
          localized,
          proposalId: created.proposalId,
          research: true,
        },
      ],
      settingsForNotification(settings, user?.timezone ?? 'UTC'),
      notifier,
      now,
    );
  } catch (error) {
    logger().warn({ err: error, proposalId: created.proposalId }, 'proposal.research_announce_failed');
  }
  return true;
}
