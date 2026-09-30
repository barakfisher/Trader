"""Whether a completion is text at all.

A model can fail by looping: on 2026-09-30 the free route answered "what is the
current price of gold" with "Hereellsellsellsellsell..." for most of its 2,500
output tokens, and `/ask` returned it as `answer_source: llm`. The evidence
validator did not object, and could not: it checks figures, and the one figure
in the loop ("120 to 102 is a drawdown of -15%") was in the cited passage. A
sentence can be free of invented numbers and still not be a sentence.

The test is narrow on purpose - a short unit of letters repeated many times in a
row - so ordinary prose never trips it: real text does not repeat a word eight
times back to back. Before it was used it was run over every stored text this
installation had - 36 corpus chunks, 72 observations and 7,410 article titles -
and matched none of them, while catching the looping answer above. Punctuation
runs ("--------", "......") do not count: a unit must contain a letter.
"""

from __future__ import annotations

import re

#: One to ten characters, then the same characters at least `MIN_REPEATS - 1`
#: more times. Lazy, so "sellsell" is read as "sell" twice, not "sellsell" once.
MIN_REPEATS = 8
_LOOP = re.compile(r"(.{1,10}?)\1{" + str(MIN_REPEATS - 1) + ",}", re.DOTALL)
_LETTER = re.compile(r"[^\W\d_]")


def repeated_run(text: str) -> str | None:
    """The first looping run in `text` (a short unit of letters repeated), or None."""
    for match in _LOOP.finditer(text):
        if _LETTER.search(match.group(1)):
            return match.group(0)
    return None


def is_degenerate(text: str) -> bool:
    """True when `text` contains a loop no sentence would: a model repeating itself."""
    return repeated_run(text) is not None
