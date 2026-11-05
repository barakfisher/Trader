"""A research rating: what the model wrote, and the checks that keep its figures true (D254, D392).

The model answers with one JSON object per stock:

    {"rating": "trim", "rationale": "...", "findings": ["...", "..."]}

Since D392 (D387 case 1) a rating is a view on what to do, like an advisor's:
**Buy more / Hold / Trim / Sell** for a stock the real portfolio holds, and
**Buy / Wait / Avoid** for one researched on its own that it does not (D369).
D254's guardrail 1 - no "you", no buy or sell wording - is gone with it; the
others stand, and two of them are here:

1. **The form**: a rating from the stock's own vocabulary, a rationale short
   enough to read, at most `MAX_FINDINGS` findings. A held stock rated "buy",
   or one not held rated "trim", is refused: the word would be about a
   position that does not exist.
2. **The figures** (guardrail 2): every number in the rationale and the
   findings is sourced from the stock's evidence by the evidence validator, as
   a scan's thesis is (guideline 7). It reads figures the same way in every
   language, which is what lets the rationale be in the user's (D392).

A problem is a reason string, never an exception: the run stores a refused
rating with its reasons, and the research page says it was refused.

The ratings stored before D392 (Bullish / Bearish / Neutral) stay in the table
and on the page until a newer rating replaces them (D392): `LEGACY_RATINGS` is
part of the column's CHECK, never of what a model may answer.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

from app.narration.evidence_validator import unsourced_figures

HeldRating = Literal["buy_more", "hold", "trim", "sell"]
UnheldRating = Literal["buy", "wait", "avoid"]
LegacyRating = Literal["bullish", "bearish", "neutral"]
Rating = HeldRating | UnheldRating

#: What a model may answer about a stock the real portfolio holds.
HELD_RATINGS: tuple[HeldRating, ...] = ("buy_more", "hold", "trim", "sell")
#: What a model may answer about a stock researched on its own, not held (D369).
UNHELD_RATINGS: tuple[UnheldRating, ...] = ("buy", "wait", "avoid")
#: Stored before D392, shown until replaced, never answered again.
LEGACY_RATINGS: tuple[LegacyRating, ...] = ("bullish", "bearish", "neutral")
#: Every value `research_ratings.rating` may hold: `0085_research_advice.RATINGS`;
#: a test holds the two equal, and the web's `RESEARCH_RATINGS` says the same.
RATINGS: tuple[str, ...] = (*HELD_RATINGS, *UNHELD_RATINGS, *LEGACY_RATINGS)
#: The ratings that ask for an action, and so raise an acknowledge-only proposal
#: on the real portfolio (D392). Hold, Wait and Avoid are a bottom line on the
#: research page only.
ACTIONABLE_RATINGS: tuple[Rating, ...] = ("buy_more", "trim", "sell", "buy")

#: Long enough for the reasons, short enough to read in a table's detail.
MAX_RATIONALE_CHARS = 1200
#: Findings a rating lists, each a short line.
MAX_FINDINGS = 5
MAX_FINDING_CHARS = 300

_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$")

#: How a problem naming unsourced figures begins.
UNSOURCED_PREFIX = "figures not in the evidence"


def ratings_for(held: bool) -> tuple[Rating, ...]:
    """The vocabulary a stock is rated in: a holding's, or a stock not held."""
    return HELD_RATINGS if held else UNHELD_RATINGS


@dataclass(frozen=True)
class ParsedRating:
    rating: Rating
    rationale: str
    findings: tuple[str, ...]

    def texts(self) -> tuple[str, ...]:
        return (self.rationale, *self.findings)


def parse_rating(raw: str, *, held: bool) -> tuple[ParsedRating | None, list[str]]:
    """The rating the model wrote, or why it is not one."""
    body = _FENCE.sub("", raw.strip())
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return None, ["the answer is not a JSON object"]
    if not isinstance(data, dict):
        return None, ["the answer is not a JSON object"]
    problems: list[str] = []
    allowed = ratings_for(held)
    rating = data.get("rating")
    rating = rating.strip().lower().replace(" ", "_") if isinstance(rating, str) else None
    if rating not in allowed:
        problems.append(f"rating is one of {', '.join(allowed)}")
    rationale = data.get("rationale")
    rationale = rationale.strip() if isinstance(rationale, str) else ""
    if not rationale:
        problems.append("the rationale says why")
    elif len(rationale) > MAX_RATIONALE_CHARS:
        problems.append(f"the rationale is at most {MAX_RATIONALE_CHARS} characters")
    raw_findings = data.get("findings", [])
    if not isinstance(raw_findings, list) or not all(isinstance(f, str) for f in raw_findings):
        problems.append("findings is a list of short sentences")
        raw_findings = []
    findings = tuple(f.strip() for f in raw_findings if f.strip())
    if len(findings) > MAX_FINDINGS:
        problems.append(f"at most {MAX_FINDINGS} findings")
    if any(len(f) > MAX_FINDING_CHARS for f in findings):
        problems.append(f"each finding is at most {MAX_FINDING_CHARS} characters")
    if problems:
        return None, problems
    return ParsedRating(rating=rating, rationale=rationale, findings=findings), []  # type: ignore[arg-type]


def rating_problems(parsed: ParsedRating, evidence: Mapping[str, object]) -> list[str]:
    """Why a well-formed rating may still not be shown: a figure the evidence lacks."""
    figures = list(
        dict.fromkeys(f for text in parsed.texts() for f in unsourced_figures(text, evidence))
    )
    return [f"{UNSOURCED_PREFIX}: {', '.join(figures)}"] if figures else []
