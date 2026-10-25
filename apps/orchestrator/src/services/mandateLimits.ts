/**
 * The mandate's size rules, checked again when a buy is approved (D299).
 *
 * The scan checks a buy against the agent's position, cash-buffer and holdings
 * limits before it proposes it (`services/ai/app/agents/mandate.py`,
 * `size_problems`). A proposal approved later can still break one: another
 * approval may have spent the cash in between, or the live price may differ
 * from the agent's. This module repeats those three rules over the ledger as it
 * stands at approval, with the same arithmetic:
 *
 * - capital is cash plus holdings at cost, before the trade (D171);
 * - comparisons are exact, in integers - nothing is rounded to decide a limit;
 * - only buys are checked, so a sell can never be trapped by a limit (D165).
 *
 * A breach is a **warning, never a refusal**: approving is the user's explicit
 * act (the user, 2026-10-25). Each one says how far past the limit the trade
 * goes and suggests the setting that would allow it, as a whole percent, so
 * an intended override can be made the agent's rule.
 */

import type { MandateBreach, TradeSide } from '@traders/shared';

import type { AgentRow } from '../db/queries.js';
import { MAX_HOLDINGS_LIMIT } from '../http/agentMandate.js';

const BPS = 10_000n;
const PERCENT = 100n;

export type MandateLimits = Pick<AgentRow, 'max_position_bps' | 'cash_buffer_bps' | 'max_holdings'>;

/** The agent's book before the trade (`getAgentBook`), in minor units. */
export interface MandateBook {
  cashMinor: bigint;
  holdingsCostMinor: bigint;
  symbolCostMinor: bigint;
  heldCount: number;
  holdsSymbol: boolean;
}

export interface CheckedTrade {
  side: TradeSide;
  notionalMinor: bigint;
  feeMinor: bigint;
}

/** `a / b` rounded up, for `a >= 0` and `b > 0`. */
function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** The limits `trade` would break; empty when it breaks none, and always for a sell. */
export function mandateBreaches(limits: MandateLimits, book: MandateBook, trade: CheckedTrade): MandateBreach[] {
  if (trade.side !== 'buy') return [];
  const capital = book.cashMinor + book.holdingsCostMinor;
  const breaches: MandateBreach[] = [];

  if (limits.max_position_bps !== null) {
    const limit = BigInt(limits.max_position_bps);
    const after = book.symbolCostMinor + trade.notionalMinor;
    if (after * BPS > limit * capital) {
      // The smallest limit that allows it, then the whole percent at or above it.
      const needed = ceilDiv(after * BPS, capital);
      const suggested = ceilDiv(needed, PERCENT) * PERCENT;
      breaches.push({
        rule: 'max_position',
        limitBps: limits.max_position_bps,
        capitalMinor: Number(capital),
        positionAfterMinor: Number(after),
        positionAfterBps: Number(needed),
        overByMinor: Number(ceilDiv(after * BPS - limit * capital, BPS)),
        suggestedBps: suggested <= BPS ? Number(suggested) : null,
      });
    }
  }

  if (limits.cash_buffer_bps !== null) {
    const limit = BigInt(limits.cash_buffer_bps);
    const cashAfter = book.cashMinor - trade.notionalMinor - trade.feeMinor;
    if (cashAfter * BPS < limit * capital) {
      // The largest buffer that allows it, then the whole percent at or below it.
      const allowed = (cashAfter * BPS) / capital;
      breaches.push({
        rule: 'cash_buffer',
        limitBps: limits.cash_buffer_bps,
        capitalMinor: Number(capital),
        cashAfterMinor: Number(cashAfter),
        cashAfterBps: Number(allowed),
        shortByMinor: Number(ceilDiv(limit * capital - cashAfter * BPS, BPS)),
        suggestedBps: Number((allowed / PERCENT) * PERCENT),
      });
    }
  }

  if (limits.max_holdings !== null && !book.holdsSymbol && book.heldCount >= limits.max_holdings) {
    const suggested = book.heldCount + 1;
    breaches.push({
      rule: 'max_holdings',
      limit: limits.max_holdings,
      heldCount: book.heldCount,
      suggestedLimit: suggested <= MAX_HOLDINGS_LIMIT ? suggested : null,
    });
  }

  return breaches;
}
