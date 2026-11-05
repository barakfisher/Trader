/**
 * The app's main places, in one list for the two things that show them: the
 * row in the header on a wide screen and the bottom bar on a phone (D382).
 * Settings, Admin and Sign out are not places in this sense: they sit behind
 * the account button at every width.
 */

import { Bot, Lightbulb, MessageCircleQuestion, Microscope } from 'lucide-react';

import { useTranslation } from '../i18n/index.ts';
import { unreadCount, useInsightsDaysQuery } from '../queries/insightsDays.ts';
import { openProposals, useProposalsQuery } from '../queries/proposals.ts';

export type Place = {
  to: '/' | '/insights' | '/agents' | '/research' | '/ask' | '/settings' | '/admin';
  label: string;
  icon: typeof Bot;
  count?: number;
  /** Something new to read there (decision 133), shown beside the count. */
  dot?: boolean;
};

/** A place is current on its own address and below it: /agents/x is still Agents. */
export function isCurrent(to: string, pathname: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`);
}

export function useMainPlaces(): Place[] {
  const { t } = useTranslation();
  // Open questions, on Insights: a question that expires unanswered because
  // nobody knew it was there is what the inbox exists to prevent.
  const openCount = openProposals(useProposalsQuery().data).length;
  // Unread findings are a dot beside the count, not a second number (the user,
  // 2026-10-11): the number is what has a deadline.
  const hasUnread = unreadCount(useInsightsDaysQuery().data) > 0;
  return [
    // Proposals is a tab of Insights (decision 134), so its count is here.
    { to: '/insights', label: t('nav.insights'), icon: Lightbulb, count: openCount, dot: hasUnread },
    { to: '/agents', label: t('nav.agents'), icon: Bot },
    { to: '/research', label: t('nav.research'), icon: Microscope },
    { to: '/ask', label: t('nav.ask'), icon: MessageCircleQuestion },
    // Targets is on the holdings card (UX5): it is about those rows.
  ];
}
