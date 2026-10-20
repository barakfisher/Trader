"""A re-check of one expired trade proposal (improvements item 4; D212-D216).

A trade proposal lives an hour from the next open (D4). One the user did not
answer in time can be re-checked once: the same agent looks at that one trade
again with today's evidence and either proposes it anew - same symbol and side,
the quantity set again at the fresh price (D216) - or says why not.

**It is a scan, narrowed** (D212): the same instructions, mandate and checks
(`scan.run_briefed`, `trade_review.py`), the same evidence validator, the same
budgets and caller - a scan's `Caller("agent_scan", user_id, agent_id)`, so the
monthly cap and the user's own key apply as to any scan. What differs:

- the briefing is about this one trade: the fresh quote, its findings, the
  agent's cash and holdings, and what was proposed and when it expired;
- one decision, at most `RECHECK_STEP_LIMIT` tool calls;
- a trade on any other symbol or side is refused (`not_this_trade`);
- the old thesis is told to the model *outside* the briefing, so none of its
  figures counts as evidence: a figure must be found again today;
- the briefing carries the symbol's news and the move since it was proposed,
  and the thesis must say whether the original reason still holds at today's
  price (D219): a re-check that only restates the old case decides nothing.

**Once** is the database's (`0066`, `agent_scans_one_refresh`, D213); the check
here only refuses before money is spent. Eligible (D215): a buy or sell that
expired unanswered, at most `RECHECK_WINDOW` ago. A rejected proposal is not,
and neither is one a later approved proposal for the same symbol and side
already carried out (D218): re-checking it would ask to do the trade twice.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.agents.scan import Focus, ScanResult, run_briefed
from app.agents.scan_log import ScanAgent
from app.agents.tools import (
    ToolContext,
    get_findings,
    get_news,
    get_position,
    get_quote,
    money,
)
from app.llm.base import LLMProvider

#: How long after its expiry a proposal may be re-checked (D215).
RECHECK_WINDOW = timedelta(days=7)
#: Tool calls a re-check may make: the briefing already has the quote and findings.
RECHECK_STEP_LIMIT = 4
#: Matches `0066_proposal_refresh.UNANSWERED_OUTCOMES`: these do not use the refresh up.
UNANSWERED_OUTCOMES = ("failed", "budget_reached", "cap_reached", "own_key_failed")


class NotRecheckableError(Exception):
    """Why a proposal cannot be re-checked, by code, before any model is called."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ExpiredTrade:
    proposal_id: str
    side: str
    symbol: str
    quantity: Decimal
    price_minor: int
    proposed_at: datetime
    expired_at: datetime
    #: The thesis the user did not answer, in the language it was written in.
    thesis: str | None


def find_expired_trade(
    engine: Engine, user_id: str, agent_id: str, proposal_id: str, now: datetime
) -> ExpiredTrade:
    """The agent's proposal, if it may be re-checked now; otherwise why not."""
    with engine.connect() as connection:
        row = connection.execute(
            text(
                """
                SELECT p.id::text AS id, p.kind, p.state, p.payload, p.created_at,
                       p.expires_at, o.explanation,
                       EXISTS (
                           SELECT 1 FROM agent_scans s
                            WHERE s.refreshes_proposal_id = p.id
                              AND (s.outcome IS NULL OR s.outcome <> ALL(:unanswered))
                       ) AS refreshed,
                       EXISTS (
                           SELECT 1 FROM proposals later
                            WHERE later.user_id = p.user_id AND later.agent_id = p.agent_id
                              AND later.kind = p.kind AND later.state = 'approved'
                              AND later.payload ->> 'symbol' = p.payload ->> 'symbol'
                              AND later.created_at > p.created_at
                       ) AS superseded
                  FROM proposals p
                  JOIN observations o ON o.id = p.observation_id
                 WHERE p.id = CAST(:proposal AS uuid) AND p.user_id = CAST(:user AS uuid)
                   AND p.agent_id = CAST(:agent AS uuid)
                """
            ),
            {
                "proposal": proposal_id,
                "user": user_id,
                "agent": agent_id,
                "unanswered": list(UNANSWERED_OUTCOMES),
            },
        ).one_or_none()
    if row is None:
        raise NotRecheckableError("proposal_not_found", "no such proposal for this agent")
    if row.kind not in ("buy", "sell"):
        raise NotRecheckableError("not_a_trade", "only a trade proposal is re-checked")
    # Expiry is computed (proposalState.ts): a passed deadline is expired, swept or not.
    if row.state not in ("pending", "snoozed", "expired") or row.expires_at > now:
        raise NotRecheckableError("not_expired", "only a proposal that expired unanswered")
    if now - row.expires_at > RECHECK_WINDOW:
        raise NotRecheckableError(
            "recheck_window_passed", f"it expired more than {RECHECK_WINDOW.days} days ago"
        )
    if row.refreshed:
        raise NotRecheckableError("already_rechecked", "this proposal has had its re-check")
    if row.superseded:
        raise NotRecheckableError("superseded", "a later approved proposal already made this trade")
    payload = row.payload
    return ExpiredTrade(
        proposal_id=row.id,
        side=row.kind,
        symbol=str(payload["symbol"]).upper(),
        quantity=Decimal(str(payload["quantity"])),
        price_minor=int(payload["priceMinor"]),
        proposed_at=row.created_at,
        expired_at=row.expires_at,
        thesis=row.explanation,
    )


async def recheck_briefing(context: ToolContext, trade: ExpiredTrade) -> dict[str, Any]:
    """What a re-check starts from: the one trade, then today's evidence about it."""
    position = await get_position(context, {})
    quote = await get_quote(context, {"symbols": [trade.symbol]})
    then = money(trade.price_minor, "USD")
    recheck: dict[str, Any] = {
        "side": trade.side,
        "symbol": trade.symbol,
        "quantity_proposed": f"{trade.quantity.normalize():f}",
        "price_when_proposed": then,
        "proposed_at": trade.proposed_at.isoformat(),
        "expired_at": trade.expired_at.isoformat(),
    }
    now = quote.get("quotes", {}).get(trade.symbol, {}).get("price")
    if now is not None:
        # Computed here, so the thesis can quote the move rather than work it out (D219).
        change = (Decimal(now) - Decimal(then)) / Decimal(then) * 100
        recheck["price_now"] = now
        recheck["change_since_proposed_percent"] = str(change.quantize(Decimal("0.01")))
    return {
        "as_of": context.now.isoformat(),
        "recheck": recheck,
        "quote": quote,
        "findings": (await get_findings(context, {"symbol": trade.symbol})).get("findings", []),
        # Read for the model, not left to it: a move with no reason found is the
        # weakest case for re-proposing, and the model did not look (D219).
        "news": await get_news(context, {"symbol": trade.symbol}),
        "cash": position["cash"],
        "holdings": position["holdings"],
    }


def preface(trade: ExpiredTrade) -> str:
    """What the model is told before the briefing. Not evidence (see the module)."""
    quantity = f"{trade.quantity.normalize():f}"
    lines = [
        "This is a re-check, not a scan. You proposed to "
        f"{trade.side} {quantity} {trade.symbol}; the user did not answer before it expired.",
        "The question is whether your reason then still holds at today's price. Your thesis"
        " must say, in this order: the price when proposed and the price now with the change"
        ' between them, exactly as the briefing\'s "recheck" gives them; whether the reason'
        " still holds, and what in today's evidence (the news, the findings, your holdings)"
        " says so; then the decision. Your current holdings already include any shares"
        " bought since: size the trade knowing them.",
        "Answer with this one trade - "
        f"{trade.side} {trade.symbol}, the quantity set again at the current price - or with"
        ' {"trades": [], "thesis": "why not now"}. Any other symbol or side is refused.',
        f"You have at most {RECHECK_STEP_LIMIT} tool calls; the briefing has the quote and"
        " the news.",
    ]
    if trade.thesis:
        lines.append(
            "Your thesis then, for reference only. It is not evidence: a figure in it counts"
            " only if the briefing or a tool gives it again today.\n"
            f"<<<\n{trade.thesis}\n>>>"
        )
    return "\n".join(lines)


async def run_recheck(
    *,
    engine: Engine,
    llm: LLMProvider,
    context: ToolContext,
    agent: ScanAgent,
    trade: ExpiredTrade,
) -> ScanResult:
    """Re-check `trade` for `agent` and store it as a `refresh` scan. The caller has
    checked the agent as for a scan, and found the trade with `find_expired_trade`."""
    briefing = await recheck_briefing(context, trade)
    return await run_briefed(
        engine=engine,
        llm=llm,
        context=context,
        agent=replace(agent, max_decisions=1),
        trigger="refresh",
        briefing=briefing,
        focus=Focus(
            proposal_id=trade.proposal_id,
            side=trade.side,
            symbol=trade.symbol,
            preface=preface(trade),
            step_limit=RECHECK_STEP_LIMIT,
        ),
    )
