"""A research rating: what the model wrote, and the checks that keep it an observation (D254, D292).

The model answers with one JSON object per holding:

    {"rating": "bullish", "rationale": "...", "findings": ["...", "..."]}

Three checks stand between that answer and the Dashboard, each one of D254's
guardrails made a mechanism:

1. **The form**: a rating of Bullish / Bearish / Neutral, a rationale short
   enough to read, at most `MAX_FINDINGS` findings.
2. **The wording** (guardrail 1): the rating is about the stock's outlook, never
   the reader's position. No word in `FORBIDDEN_WORDS` - "you", "your", buy,
   sell, hold, trim, accumulate, a target price - appears anywhere in it.
   Matched as whole words, case-insensitively, so "household" passes and "Sell"
   does not. A strict list refuses some innocent sentences ("the support level
   holds"); a refused rating costs a retry, a permitted instruction costs the
   guardrail.
3. **The figures** (guardrail 2): every number in the rationale and the
   findings is sourced from the holding's evidence by the evidence validator,
   as a scan's thesis is (guideline 7).

A problem is a reason string, never an exception: the run stores a refused
rating with its reasons, and the research page says it was refused.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

from app.narration.evidence_validator import unsourced_figures

Rating = Literal["bullish", "bearish", "neutral"]
#: `0070_holding_research.RATINGS`; a test holds the two equal.
RATINGS: tuple[Rating, ...] = ("bullish", "bearish", "neutral")

#: Long enough for the reasons, short enough to read in a table's detail.
MAX_RATIONALE_CHARS = 1200
#: Findings a rating lists, each a short line.
MAX_FINDINGS = 5
MAX_FINDING_CHARS = 300

#: Words a rating never uses (D254 guardrail 1): it speaks of the stock, not to
#: the reader, and never tells anyone what to do with a position. Each is a
#: regular expression matched as a whole word.
FORBIDDEN_WORDS: tuple[str, ...] = (
    r"you",
    r"your",
    r"yours",
    r"yourself",
    r"buy(?:s|ing)?",
    r"bought",
    r"sell(?:s|ing)?",
    r"sold",
    r"hold(?:s|ings?)?",
    r"trim(?:s|med|ming)?",
    r"accumulat(?:e|es|ed|ing|ion)",
    r"target price",
    r"price target",
)
_FORBIDDEN = re.compile(r"\b(" + "|".join(FORBIDDEN_WORDS) + r")\b", re.IGNORECASE)

_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$")

#: How a problem naming unsourced figures begins.
UNSOURCED_PREFIX = "figures not in the evidence"
#: How a problem naming forbidden words begins.
WORDING_PREFIX = "words a rating never uses"


@dataclass(frozen=True)
class ParsedRating:
    rating: Rating
    rationale: str
    findings: tuple[str, ...]

    def texts(self) -> tuple[str, ...]:
        return (self.rationale, *self.findings)


def parse_rating(raw: str) -> tuple[ParsedRating | None, list[str]]:
    """The rating the model wrote, or why it is not one."""
    body = _FENCE.sub("", raw.strip())
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return None, ["the answer is not a JSON object"]
    if not isinstance(data, dict):
        return None, ["the answer is not a JSON object"]
    problems: list[str] = []
    rating = data.get("rating")
    rating = rating.strip().lower() if isinstance(rating, str) else None
    if rating not in RATINGS:
        problems.append("rating is one of bullish, bearish or neutral")
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


def forbidden_words(text: str) -> list[str]:
    """The forbidden words `text` uses, lower-cased, in order, each once."""
    return list(dict.fromkeys(match.group(1).lower() for match in _FORBIDDEN.finditer(text)))


def rating_problems(parsed: ParsedRating, evidence: Mapping[str, object]) -> list[str]:
    """Why a well-formed rating may still not be shown: its wording, its figures."""
    problems: list[str] = []
    words = list(dict.fromkeys(w for text in parsed.texts() for w in forbidden_words(text)))
    if words:
        problems.append(f"{WORDING_PREFIX}: {', '.join(words)}")
    figures = list(
        dict.fromkeys(f for text in parsed.texts() for f in unsourced_figures(text, evidence))
    )
    if figures:
        problems.append(f"{UNSOURCED_PREFIX}: {', '.join(figures)}")
    return problems
