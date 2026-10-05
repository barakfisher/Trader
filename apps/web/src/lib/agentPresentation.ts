/**
 * How an agent is named and described on screen (multi-agent Stage 2).
 *
 * The primary is the user's real portfolio. Its stored name ("Main portfolio")
 * is data the product chose, not the user, so it is never shown: the reader's
 * catalogue names it, in their language. Every other agent is simulated, and
 * says so wherever it appears (the P2 amendment's third condition).
 */

import type { AgentState, AgentView } from '@traders/shared';

import { ApiRequestError } from '../api/client.ts';
import { t } from '../i18n/index.ts';

export function agentName(agent: Pick<AgentView, 'isPrimary' | 'name'>): string {
  return agent.isPrimary ? t('agents.primaryName') : agent.name;
}

export function agentStateWord(state: AgentState): string {
  return t(`agents.states.${state}`);
}

/** Dollars and cents, as the server accepts them: refused, never rounded, past two decimals. */
export const BUDGET_INPUT = /^\d+(\.\d{1,2})?$/;

/**
 * The sentence for a refused write, in the reader's language for the refusals
 * the page can cause; anything else falls back to the server's own message.
 */
export function agentErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError) {
    switch (error.code) {
      case 'agent_name_taken':
        return t('agents.errors.nameTaken');
      case 'budget_out_of_range':
        return t('agents.errors.budgetRange');
      case 'invalid_body':
        return t('agents.errors.invalid');
      default:
        return error.message;
    }
  }
  return fallback;
}
