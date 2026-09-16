"""Scoring the tone of an article, offline and deterministically.

**The limitation, stated first.** This is a word-counting lexicon. It knows that
"downgraded" is negative and "record" is positive, and it knows nothing else. It
cannot read irony, it cannot tell whose loss is being described, and it will
score "cut costs" and "cut guidance" identically because both contain "cut". It
is wrong on any sentence whose meaning depends on structure. What it is, is
free, instant, offline and identical on every run - and that last property is the
one this milestone needs, because a scheduled run must produce the same
observations from the same inputs (guideline 8) and CI must pass with no API key.

`app/llm/` exists on `main` and is deliberately not used here. Three reasons, in
order of weight:

  1. Sentiment runs over every article of every scan - tens to hundreds per run -
     while the LLM budget (`LLM_DAILY_BUDGET_USD`) is sized for narration, which
     runs over findings, of which there are a handful. Wiring the cheap
     high-volume step to the expensive low-volume budget would exhaust it before
     the step it was bought for.
  2. A model's score is not reproducible, so a re-run over unchanged data could
     produce a different opinion and therefore a different observation.
  3. Milestone 3 has not decided what a model-scored sentiment costs or how it is
     validated, and a deferred decision is cheaper than a wrong one.

The seam for that swap is `SentimentScorer` below. It is deliberately async even
though this implementation needs no await: an LLM-backed scorer will, and making
the interface async now means the swap adds a class and one line of wiring
instead of rewriting every caller (guideline 6). `article_sentiment` stores the
`model` name per row and is unique on `(article_id, model)`, so a second scorer
writes a second opinion beside this one rather than overwriting it.

The output is two numbers, because one cannot say both things:

  * `score` in [-1, 1] - direction. The net of the polarities that matched,
    divided by their total, so it is a balance rather than a count: a long
    article is not more positive than a short one for being long.
  * `magnitude` in [0, 1] - strength, independent of direction. Saturating at
    `MAGNITUDE_SATURATION_HITS` matched terms. An article with strong claims on
    both sides scores near zero with high magnitude; an article about nothing in
    particular scores near zero with low magnitude, and the reader has to be able
    to tell those apart.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

#: This lexicon's identity, stored in `article_sentiment.model`. Bump the suffix
#: when the word lists change: a score is only comparable to another score from
#: the same lexicon, and the unique key on (article_id, model) turns a bump into
#: a second opinion rather than a silent rewrite of the corpus.
LEXICON_MODEL_NAME = "lexicon-v1"

#: Matched terms at which `magnitude` reaches 1.0. Eight is roughly the point at
#: which a market story has made its position obvious; beyond it, more loaded
#: words say more about the outlet's style than about the news.
MAGNITUDE_SATURATION_HITS = 8

#: How many tokens after a negation cue have their polarity flipped. Three covers
#: "did not beat expectations" and "no sign of weakness" without reaching across
#: a clause boundary into a sentence it has no business inverting.
NEGATION_WINDOW = 3

#: Terms whose presence in market copy points one way. Market vocabulary, not
#: general English: "volatile" and "aggressive" are neutral here because they
#: describe both good and bad weeks.
POSITIVE_TERMS = frozenset(
    {
        "accelerated",
        "approval",
        "approved",
        "awarded",
        "beat",
        "beats",
        "breakthrough",
        "climbed",
        "exceeded",
        "expansion",
        "gains",
        "grew",
        "growth",
        "jumped",
        "momentum",
        "optimistic",
        "outperform",
        "profitable",
        "raised",
        "raises",
        "rallied",
        "rally",
        "record",
        "robust",
        "rose",
        "soared",
        "strength",
        "strong",
        "surge",
        "surged",
        "upgrade",
        "upgraded",
        "wins",
        "won",
    }
)

NEGATIVE_TERMS = frozenset(
    {
        "concerns",
        "cut",
        "cuts",
        "declined",
        "delay",
        "delayed",
        "downgrade",
        "downgraded",
        "fell",
        "fraud",
        "halted",
        "investigation",
        "lawsuit",
        "layoffs",
        "loss",
        "losses",
        "miss",
        "missed",
        "plunge",
        "plunged",
        "probe",
        "recall",
        "selloff",
        "shortfall",
        "slides",
        "slumped",
        "slumps",
        "tumbled",
        "underperform",
        "warned",
        "warning",
        "warns",
        "weak",
        "weakness",
    }
)

#: Cues that invert the polarity of what follows them.
NEGATION_CUES = frozenset({"not", "no", "never", "without", "hardly", "barely", "nor", "cannot"})

#: Words, apostrophes kept so "n't" survives tokenisation as part of its verb.
_TOKEN = re.compile(r"[a-z']+")


@dataclass(frozen=True, slots=True)
class SentimentScore:
    """One scorer's opinion of one article."""

    score: float
    magnitude: float
    model: str
    positive_hits: int = 0
    negative_hits: int = 0

    @property
    def is_neutral(self) -> bool:
        return self.score == 0.0


@runtime_checkable
class SentimentScorer(Protocol):
    """The seam an LLM-backed scorer will slot into.

    Async by intent, not by need - see the module docstring. Takes the title and
    body as strings rather than an article object so that the scorer has no
    dependency on the pipeline's own types and can be tested with two literals.
    """

    #: Recorded in `article_sentiment.model`.
    name: str

    async def score(self, title: str, body: str) -> SentimentScore: ...


class LexiconSentimentScorer:
    """Counts polarised market vocabulary. See the module docstring for its limits."""

    name = LEXICON_MODEL_NAME

    async def score(self, title: str, body: str) -> SentimentScore:
        # The title is counted once like any other sentence. Weighting it would
        # be defensible and is not done, because a headline is written to be
        # loaded and a per-headline weight is a tuning parameter with no evidence
        # behind it yet.
        positive, negative = _count(f"{title}. {body}")
        hits = positive + negative
        if hits == 0:
            return SentimentScore(score=0.0, magnitude=0.0, model=self.name)
        score = (positive - negative) / hits
        magnitude = min(hits / MAGNITUDE_SATURATION_HITS, 1.0)
        return SentimentScore(
            # Four decimals to match `article_sentiment numeric(5, 4)`.
            score=round(score, 4),
            magnitude=round(magnitude, 4),
            model=self.name,
            positive_hits=positive,
            negative_hits=negative,
        )


def _count(text: str) -> tuple[int, int]:
    """Positive and negative hits, with negation applied inside its window."""
    tokens = _TOKEN.findall(text.lower())
    positive = negative = 0
    negated_until = -1
    for index, token in enumerate(tokens):
        if token in NEGATION_CUES or token.endswith("n't"):
            negated_until = index + NEGATION_WINDOW
            continue
        flipped = index <= negated_until
        if token in POSITIVE_TERMS:
            negative += 1 if flipped else 0
            positive += 0 if flipped else 1
        elif token in NEGATIVE_TERMS:
            positive += 1 if flipped else 0
            negative += 0 if flipped else 1
    return positive, negative
