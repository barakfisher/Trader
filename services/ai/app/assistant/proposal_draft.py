"""Whether a proposal the model drafted may be shown (D393, D387 case 4).

The model only drafts: an action and a stock with its reason, stored on its reply.
What is written to the inbox is the user's tap, in the orchestrator. So this is
not a guard on a write; it is what keeps a button from being offered on a draft
that makes no sense:

- **The word matches the stock**, as research's does (D392): Buy more, Trim or
  Sell for what the real portfolio holds, Buy for what it does not.
- **The stock is one the app knows**: in the universe, or held. A holding outside
  the universe can still be trimmed; the app makes no instrument from a reply.

A refused draft goes back to the model once, with why, like an unsourced figure.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.assistant.reply import ProposalDraft


@dataclass(frozen=True)
class DraftCheck:
    instrument_id: str | None = None
    #: Why the draft may not be shown, in words the model can act on; None when it may.
    problem: str | None = None


def check_draft(
    connection: Connection, *, user_id: str, primary_agent_id: str, draft: ProposalDraft
) -> DraftCheck:
    row = connection.execute(
        text(
            """
            SELECT i.id::text AS id,
                   EXISTS (
                       SELECT 1 FROM holdings h
                        WHERE h.instrument_id = i.id
                          AND h.agent_id = CAST(:agent AS uuid)
                          AND h.user_id = CAST(:user AS uuid)
                          AND h.quantity > 0
                   ) AS held,
                   coalesce(p.membership <> 'dropped', false) AS in_universe
              FROM instruments i
              LEFT JOIN instrument_profiles p ON p.instrument_id = i.id
             WHERE i.symbol = :symbol
            """
        ),
        {"agent": primary_agent_id, "user": user_id, "symbol": draft.symbol},
    ).one_or_none()
    if row is None or not (row.held or row.in_universe):
        return DraftCheck(problem=f"the proposal names {draft.symbol}, which the app does not know")
    if row.held and draft.action == "buy":
        return DraftCheck(
            problem=f"the proposal says buy, but {draft.symbol} is held: use buy_more, trim or sell"
        )
    if not row.held and draft.action != "buy":
        return DraftCheck(
            problem=f"the proposal says {draft.action}, but {draft.symbol} is not held: use buy"
        )
    return DraftCheck(instrument_id=row.id)
