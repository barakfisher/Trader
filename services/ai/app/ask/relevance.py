"""Does the corpus actually cover this question? Three answers, not two.

M3's exit criterion is that `/ask` "correctly refuses out-of-index questions",
so something has to decide. This is that decision, kept apart from the retrieval
that feeds it and from the answer that follows it, because it is the one place in
the pipeline whose *only* job is to say no.

**The threshold is on cosine similarity, and that choice is evidence rather than
taste.** The three candidate signals are not comparable:

  * An RRF score is a function of how many halves returned a chunk and where, so
    the same number means different things for different queries. A threshold on
    it is a threshold on nothing in particular.
  * `ts_rank_cd` is unbounded and length-dependent, and since the lexical half
    became strict it legitimately returns *zero rows* for good questions - so low
    lexical coverage no longer implies irrelevance.
  * Cosine from a real embedding model is bounded in [-1, 1] and behaves the same
    way across queries, which is the only property that makes a fixed number
    meaningful.

**What was measured, and how weak it is.** Eight in-domain questions and eight
plainly unrelated ones were embedded and scored against the real corpus:

    lowest in-domain    0.2498  ("why does my mix keep changing on its own")
    highest out-domain  0.2208  ("what is the weather tomorrow")
    separation          0.0289

Separable - and by three hundredths of a point, on sixteen questions written by
the person choosing the threshold. **That is enough to tell clearly-relevant from
clearly-irrelevant, and not enough to draw a line.** Pretending otherwise would
put a coin-flip behind a boolean and report it as a decision.

So there are three outcomes. Below `REFUSE_BELOW` the corpus does not cover the
question and `/ask` says so. Above `CONFIDENT_ABOVE` it plainly does. Between
them the answer is given *and labelled as a weak match*, because the measurement
supports "I am not sure" and a binary does not. This is the same instinct as
`null` for an unpriced holding: the uncertain case gets its own value rather than
being rounded into a confident one.

**Slice 4's eval set is what makes these numbers real**, and until it exists
nobody should tune them - a threshold fitted more tightly to sixteen questions is
not more accurate, only more confident.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

#: Best-match cosine below which the corpus is judged not to cover the question.
#: Sits inside the measured gap (0.2208 out-of-domain, 0.2498 in-domain), nearer
#: the out-of-domain end so a real question is admitted in preference to a
#: nonsense one being refused - the asymmetry is deliberate, because a wrongly
#: refused question is visible to the person who asked it and a wrongly admitted
#: one is answered with citations they can check.
REFUSE_BELOW = 0.23

#: Above this, the match is strong enough to present without a caveat. Set at the
#: top of the observed paraphrase band rather than at the bottom: direct term
#: questions scored ~0.71 and paraphrases 0.25-0.39, so this splits "asked in the
#: corpus's own words" from "asked in the user's".
CONFIDENT_ABOVE = 0.40


class Relevance(StrEnum):
    """How well the corpus covers a question, as three states."""

    #: A strong match. Answer normally.
    CONFIDENT = "confident"
    #: Retrieved something plausible, but close to the noise floor. Answer, and
    #: say so - the caller is expected to show this to the reader.
    WEAK = "weak"
    #: Nothing in the corpus is about this. Refuse.
    NONE = "none"


@dataclass(frozen=True, slots=True)
class RelevanceJudgement:
    """The verdict, the number behind it, and the thresholds it was judged by.

    The thresholds travel with the judgement rather than being looked up by the
    reader, so an answer can explain itself completely: "0.19, refused, floor is
    0.23" is debuggable months later, and "refused" alone is not. It also means
    changing a constant cannot silently invalidate a stored explanation.
    """

    relevance: Relevance
    best_similarity: float
    refuse_below: float = REFUSE_BELOW
    confident_above: float = CONFIDENT_ABOVE

    @property
    def is_answerable(self) -> bool:
        return self.relevance is not Relevance.NONE


def judge(
    best_similarity: float | None,
    *,
    vector_is_semantic: bool,
    refuse_below: float = REFUSE_BELOW,
    confident_above: float = CONFIDENT_ABOVE,
) -> RelevanceJudgement:
    """Grade a question by the best similarity retrieval found for it.

    `best_similarity` is None when the vector half returned nothing at all -
    an un-embedded corpus, or a namespace with no rows. That is not evidence of
    irrelevance, it is an absence of evidence, and the two must not collapse:
    refusing would tell the reader "we do not cover that" when the truth is "we
    have not indexed anything". It is graded WEAK so the answer is given with a
    caveat and the lexical half can still carry it.

    **`vector_is_semantic` disables the floor entirely when it is False**, and
    that is the important case. The fixture embedder's similarities measure
    shared words, so its numbers are not on the same scale as the ones these
    thresholds were measured against - a threshold applied to them would refuse
    or admit essentially at random while looking exactly like a considered
    decision. CI runs on that embedder. So when the vector half is a placeholder
    the floor abstains rather than guesses, every answer is graded WEAK, and the
    response says `vector_is_semantic: false` as it already did.
    """
    if not vector_is_semantic or best_similarity is None:
        return RelevanceJudgement(
            Relevance.WEAK, best_similarity or 0.0, refuse_below, confident_above
        )

    if best_similarity < refuse_below:
        relevance = Relevance.NONE
    elif best_similarity >= confident_above:
        relevance = Relevance.CONFIDENT
    else:
        relevance = Relevance.WEAK

    return RelevanceJudgement(relevance, best_similarity, refuse_below, confident_above)
