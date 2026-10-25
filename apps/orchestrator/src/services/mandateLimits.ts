/**
 * The mandate's rules, checked again when a buy is approved: size (D299) and
 * universe (D301).
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
 *
 * The universe rules (D301) repeat `mandate.universe_problems` the same way: a
 * symbol blocked, or a universe narrowed, after the scan proposed the buy. The
 * blocked list alone answers when it applies, as the scan's does.
 */

import type { MandateBreach, MarketCap, TradeSide } from '@traders/shared';

import type { AgentRow, UniverseProfileRow } from '../db/queries.js';
import { MAX_HOLDINGS_LIMIT } from '../http/agentMandate.js';

const BPS = 10_000n;
const PERCENT = 100n;

export type MandateLimits = Pick<AgentRow, 'max_position_bps' | 'cash_buffer_bps' | 'max_holdings'>;

export type UniverseRules = Pick<
  AgentRow,
  'allow_etfs' | 'market_caps' | 'sectors' | 'industries' | 'etf_categories' | 'blocked_symbols'
>;

/**
 * The equity market-cap bands' floors in USD minor units (D172), as
 * `mandate.py` has them; `test_mandate_limits_contract.py` holds them equal.
 */
export const MEGA_CAP_FLOOR_MINOR = 200_000_000_000n * 100n;
export const LARGE_CAP_FLOOR_MINOR = 10_000_000_000n * 100n;
export const MID_CAP_FLOOR_MINOR = 2_000_000_000n * 100n;

export function capBand(marketCapMinor: bigint): MarketCap {
  if (marketCapMinor >= MEGA_CAP_FLOOR_MINOR) return 'mega';
  if (marketCapMinor >= LARGE_CAP_FLOOR_MINOR) return 'large';
  if (marketCapMinor >= MID_CAP_FLOOR_MINOR) return 'mid';
  return 'small';
}

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

function inSelection(rules: UniverseRules, profile: UniverseProfileRow): boolean {
  if (profile.asset_class === 'etf') {
    if (profile.category === null) return false;
    return (
      rules.etf_categories.includes(profile.category) ||
      (profile.category_sector !== null && rules.sectors.includes(profile.category_sector))
    );
  }
  return (
    (profile.sector !== null && rules.sectors.includes(profile.sector)) ||
    (profile.industry !== null && rules.industries.includes(profile.industry))
  );
}

/** The universe rules a buy of `symbol` would break; empty when it breaks none, and always for a sell. */
export function universeBreaches(
  rules: UniverseRules,
  symbol: string,
  profile: UniverseProfileRow | null,
  side: TradeSide,
): MandateBreach[] {
  if (side !== 'buy') return [];
  if (rules.blocked_symbols.includes(symbol)) return [{ rule: 'blocked' }];
  if (profile === null) return [{ rule: 'unchecked', missing: 'profile' }];
  const isEtf = profile.asset_class === 'etf';
  const breaches: MandateBreach[] = [];
  if (isEtf && !rules.allow_etfs) breaches.push({ rule: 'etf' });
  if (!isEtf && rules.market_caps.length > 0) {
    if (profile.market_cap_minor === null || (profile.size_currency ?? '').toUpperCase() !== 'USD') {
      breaches.push({ rule: 'unchecked', missing: 'market_cap' });
    } else {
      const band = capBand(BigInt(profile.market_cap_minor));
      if (!rules.market_caps.includes(band)) {
        breaches.push({ rule: 'market_cap', band, allowed: rules.market_caps as MarketCap[] });
      }
    }
  }
  const selects = rules.sectors.length > 0 || rules.industries.length > 0 || rules.etf_categories.length > 0;
  if (selects && !inSelection(rules, profile)) {
    const suggested = isEtf
      ? profile.category !== null && profile.category_listed
        ? { field: 'etfCategories' as const, name: profile.category }
        : null
      : profile.industry !== null && profile.industry_listed
        ? { field: 'industries' as const, name: profile.industry }
        : null;
    breaches.push({
      rule: 'selection',
      assetClass: isEtf ? 'etf' : 'equity',
      sector: profile.sector,
      industry: profile.industry,
      category: profile.category,
      suggested,
    });
  }
  return breaches;
}
