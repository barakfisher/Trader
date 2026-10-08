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
import { formatMoney, formatNumber, formatPercent } from '../i18n/format.ts';
import { t } from '../i18n/index.ts';
import { formatExactTime } from './relativeTime.ts';

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
      case 'budget_decrease_after_trade':
        return t('agents.errors.budgetDecrease');
      case 'llm_budget_out_of_range':
        return t('agents.scans.budgetInvalid');
      case 'invalid_body':
        return t('agents.errors.invalid');
      default:
        return error.message;
    }
  }
  return fallback;
}

/** Whole shares, as the trade form and the server accept them (D9). */
export const QUANTITY_INPUT = /^[1-9]\d{0,9}$/;

function detail<T>(error: ApiRequestError, key: string): T | undefined {
  const details = error.details as Record<string, unknown> | undefined;
  return details?.[key] as T | undefined;
}

/**
 * The sentence for a refused trade or preview (Stage 3, D21 and D27-D30), with
 * the figures the server sent: the next open, the moved price, the cash short.
 */
export function tradeErrorMessage(error: unknown, fallback: string, currency = 'USD'): string {
  if (!(error instanceof ApiRequestError)) return fallback;
  switch (error.code) {
    case 'market_closed': {
      const nextOpen = detail<string>(error, 'nextOpen');
      return t('agents.trade.errors.marketClosed', { time: formatExactTime(nextOpen) });
    }
    case 'quote_too_old':
      return t('agents.trade.errors.quoteTooOld');
    case 'quote_unavailable':
      return t('agents.trade.errors.quoteUnavailable');
    case 'price_moved':
      return t('agents.trade.errors.priceMoved', {
        price: formatMoney(detail<number>(error, 'livePriceMinor'), currency),
      });
    case 'insufficient_cash':
      return t('agents.trade.errors.insufficientCash', {
        required: formatMoney(detail<number>(error, 'requiredMinor'), currency),
        cash: formatMoney(detail<number>(error, 'cashMinor'), currency),
      });
    case 'insufficient_holding':
      return t('agents.trade.errors.insufficientHolding', {
        held: formatNumber(Number(detail<string>(error, 'heldQuantity') ?? 0)),
      });
    case 'not_tradable': {
      const reason = detail<string>(error, 'reason');
      if (reason === 'not_usd') return t('agents.trade.errors.notUsd');
      if (reason === 'no_calendar') return t('agents.trade.errors.noCalendar');
      return t('agents.trade.errors.outsideUniverse');
    }
    case 'not_found':
      return t('agents.trade.errors.unknownSymbol');
    case 'invalid_quantity':
      return t('agents.trade.errors.invalidQuantity');
    case 'invalid_price':
      return t('agents.trade.errors.invalidPrice');
    case 'agent_archived':
      return t('agents.trade.errors.archived');
    case 'budget_out_of_range':
      return t('agents.errors.budgetRange');
    case 'price_far_from_agent':
      return t('proposal.trade.errors.priceFarFromAgent', {
        live: formatMoney(detail<number>(error, 'livePriceMinor'), currency),
        agent: formatMoney(detail<number>(error, 'agentPriceMinor'), currency),
        distance: formatPercent((detail<number>(error, 'distanceBps') ?? 0) / 100, 1),
      });
    case 'expired':
      return t('proposal.trade.errors.expired');
    case 'already_decided':
      return t('proposal.trade.errors.alreadyDecided');
    default:
      return error.message;
  }
}

/**
 * Why approving an agent's trade was refused (D49), in the words of an approval:
 * a proposal has no typed price to fall back on, and is tried again by Approve.
 * Every other refusal reads as it does for a manual trade.
 */
export function approvalErrorMessage(error: unknown, fallback: string, currency = 'USD'): string {
  if (!(error instanceof ApiRequestError)) return fallback;
  switch (error.code) {
    case 'market_closed':
      return t('proposal.trade.errors.marketClosed', {
        time: formatExactTime(detail<string>(error, 'nextOpen')),
      });
    case 'quote_too_old':
      return t('proposal.trade.errors.quoteTooOld');
    case 'quote_unavailable':
      return t('proposal.trade.errors.quoteUnavailable');
    case 'price_moved':
      return t('proposal.trade.errors.priceMoved', {
        price: formatMoney(detail<number>(error, 'livePriceMinor'), currency),
      });
    default:
      return tradeErrorMessage(error, fallback, currency);
  }
}
