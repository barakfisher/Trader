"""Is this a question about the corpus, or about the reader's own portfolio?

Two destinations with nothing in common: a concept question is answered from
`kb_chunks` with citations, and a portfolio question is answered from figures the
caller supplied, which the corpus knows nothing about. Routing wrongly is not a
degraded answer, it is an answer to a different question.

**The trap this module exists to avoid: first person does not mean portfolio.**
The obvious rule - "my", "I", "mine" → portfolio - fails immediately on the
question that motivated the whole embedding migration: *"how much did I lose from
the top"* is first-person and is a **concept** question about drawdown, answered
correctly from the corpus. So is "should I sell when things drop". Pronouns
signal how someone writes, not what they are asking about.

What actually distinguishes a portfolio question is a reference to the reader's
*holdings*: their positions, their weights, what they own, what it is worth.
That is a short, explicit list below, and it is short on purpose - the same
argument `PROPOSABLE_KINDS` makes in the orchestrator. A long list of clever
patterns would be a classifier nobody can reason about, sitting in front of the
one decision that sends a question to the wrong half of the system.

**Deliberately not an LLM call.** Routing has to work when no model is configured
- that is the deployment this product is required to run in - and it has to be
deterministic for the eval set in slice 4 to measure anything downstream of it. A
model that classifies intent differently on two runs makes every retrieval number
after it unreproducible. If this heuristic turns out to be the limiting factor, a
model becomes a *second* opinion consulted when the rules abstain, not a
replacement for them.

**Ambiguity resolves to concept, and that asymmetry is chosen.** A portfolio
question answered from the corpus gets a definition of a term the reader used -
unhelpful, obviously so, and harmless. A concept question routed to the portfolio
path gets figures about their holdings presented as if they answered it, which
reads as an answer and is not one.
"""

from __future__ import annotations

import re
from enum import StrEnum


class Intent(StrEnum):
    """Where a question is answered from."""

    #: Answered from the concept corpus, with citations.
    CONCEPT = "concept"
    #: Answered from the holdings the caller supplied.
    PORTFOLIO = "portfolio"


#: Phrases that name the reader's own holdings. Every one of these refers to
#: *what they hold*, never merely to *them* - that distinction is the whole
#: point, and a new entry that does not survive it (any bare pronoun, "should
#: I", "did I") belongs in the test file as a counter-example instead.
_PORTFOLIO_MARKERS: tuple[str, ...] = (
    "my portfolio",
    "my holding",  # matches "my holdings" too
    "my position",
    "my allocation",
    "my target",
    "my weight",
    "my account",
    "my investment",
    "i own",
    "i hold",
    "do i have",
    "am i holding",
    "am i overweight",
    "am i underweight",
    "biggest position",
    "largest position",
    "smallest position",
    "biggest holding",
    "largest holding",
    "portfolio worth",
    "portfolio value",
)

#: Asking what a word means is a concept question however it is phrased, and
#: these override a portfolio marker appearing in the same sentence: "what does
#: overweight mean for my portfolio" wants the definition, not the number.
_DEFINITION_MARKERS: tuple[str, ...] = (
    "what is a ",
    "what is an ",
    "what does ",
    "what are ",
    "explain ",
    "definition of",
    "mean by",
    "meaning of",
    "how is it computed",
    "how is it calculated",
)

_WHITESPACE = re.compile(r"\s+")


def _normalise(question: str) -> str:
    return _WHITESPACE.sub(" ", question.lower().strip())


def classify(question: str, *, symbols: tuple[str, ...] = ()) -> Intent:
    """Route one question. `symbols` are the tickers the caller actually holds.

    A bare symbol is treated as a portfolio marker only when it is one of
    *theirs*: "how much AAPL do I have" is about their position, while "what is
    a drawdown" must not become a portfolio question because some corpus example
    mentions a ticker. Passing the real holdings is what makes that distinction
    available, and an empty tuple simply means the caller supplied none - in
    which case no symbol can match and routing falls back to the phrase lists.
    """
    text = _normalise(question)

    # Checked first: a definition request outranks a possessive, because the
    # reader is asking what a word means and mentioning their portfolio only as
    # the setting.
    if any(marker in text for marker in _DEFINITION_MARKERS):
        return Intent.CONCEPT

    if any(marker in text for marker in _PORTFOLIO_MARKERS):
        return Intent.PORTFOLIO

    # Case-SENSITIVE, against the original question rather than the lowered
    # copy, and that is not fussiness. A word boundary is not enough: `SO` is
    # Southern Company and `so` is one of the commonest words in English, so
    # `\bso\b` matches "so what is volatility" and routes a definition request
    # into the arithmetic path. Tickers are written in upper case by convention,
    # which is the only signal that separates the two.
    #
    # The cost is that a lowercase "how much aapl do i have" is not recognised
    # and falls through to CONCEPT. That is the harmless direction (see the
    # module docstring) and is preferred to hijacking every question containing
    # a short common word that happens to be listed somewhere.
    for symbol in symbols:
        if symbol and re.search(rf"\b{re.escape(symbol)}\b", question):
            return Intent.PORTFOLIO

    return Intent.CONCEPT
