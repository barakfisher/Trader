"""`/ask`: route the question, judge coverage, answer or refuse.

The orchestration only. Routing is `intent.py`, the floor is `relevance.py`, the
arithmetic is `portfolio.py`, and the retrieval is `app/corpus`. What lives here
is the sequence and, more importantly, **what the reader is told about how the
answer was produced**.

**Every answer is extractive first.** The passages retrieved are returned
verbatim with their citations, and they are the answer. A model, when one is
configured and working, is asked for a short connecting paragraph *over those
passages* - and if it writes a figure the passages do not contain, the paragraph
is discarded and the extract stands. That mirrors narration's `llm`/`template`
split exactly, including its badge: `answer_source` says which happened and
`fallback_reason` says why the model did not. It also means `/ask` works with no
model at all, which is the deployment this product is required to run in.

**A refusal is an answer.** M3's exit criterion names it specifically, and it is
the output most likely to be quietly dropped for looking like a failure. A
refusal carries the same structure as any other reply - the question, the
judgement, the number behind it - so "we do not cover that" is distinguishable
from "something broke", by a reader and by a test.

**Three ways to decline, and they are not the same.** Below the floor means the
corpus does not cover it. A portfolio question with no holdings supplied means
the caller did not send what is needed. A portfolio question outside the short
list of computable ones means the product cannot compute it. Collapsing them
would tell someone their question was out of scope when the truth was that their
portfolio had not loaded.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation

from sqlalchemy.engine import Connection

from app.ask import portfolio as portfolio_answers
from app.ask.intent import Intent, classify
from app.ask.relevance import Relevance, judge
from app.core.logging import get_logger
from app.corpus.embeddings import BaseEmbedder
from app.corpus.retrieval import ScoredChunk, hybrid_search
from app.corpus.vector_store import VectorStore
from app.llm.base import Caller, LLMError, LLMProvider
from app.llm.degenerate_text import is_degenerate, repeated_run
from app.narration.evidence_validator import unsourced_figures

log = get_logger("ask.service")

#: How many passages back a concept answer. Three is what fits in a reply
#: somebody will actually read, and enough that a question spanning two
#: documents is not answered from one of them.
DEFAULT_PASSAGES = 3

#: Numbers appearing in retrieved passage text, used as the sourced set when
#: checking a generated paragraph. Same job as a finding's evidence mapping in
#: narration, built from prose instead of from computed figures.
_NUMBER = re.compile(r"-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?")

#: What a weak match says before anything else. The `relevance: weak` flag was
#: on the wire from the start, but the *text* of a weak answer was identical to a
#: confident one - so a reader of the reply alone got no signal at all, and "what
#: is the current price of gold" came back as the drawdown formula, stated flatly.
#:
#: The eval set is what made this unavoidable. On held-out questions the floor
#: could not separate that gold question (0.2502) from a legitimate one - "why
#: does my mix keep changing on its own" (0.2498) - which overlap by 0.0004. No
#: threshold classifies both correctly, and moving one to fix the eval would have
#: turned the held-out set into a training set. So the uncertainty is stated in
#: the answer instead of being resolved by a coin flip: at the boundary, the
#: honest reply is "I don't know, and here is the closest thing I found".
#:
#: Applied by the service from the verdict, never by the model, so whether an
#: answer is hedged cannot depend on how a model chose to phrase it.
WEAK_MATCH_PREFIX = "I'm not sure the reference corpus covers this. The closest match I found is:"

_SYSTEM_PROMPT = (
    "You explain financial terms to a non-expert. You are given passages from a "
    "reference corpus and a question. Write at most three sentences that answer the "
    "question using only those passages. Never state a number that does not appear "
    "in them. If the passages do not answer the question, say so plainly. Do not "
    "give investment advice or tell the reader what to buy or sell."
)


@dataclass(frozen=True, slots=True)
class Citation:
    """Where one sentence of an answer came from."""

    chunk_id: str
    document_id: str
    concept_slug: str | None
    title: str
    heading: str | None
    text: str
    similarity: float | None


@dataclass(frozen=True, slots=True)
class Answer:
    """What `/ask` returns, refusals included."""

    question: str
    intent: Intent
    answered: bool
    text: str
    citations: tuple[Citation, ...] = ()
    concept_refs: tuple[str, ...] = ()
    evidence: dict[str, object] = field(default_factory=dict)
    #: `extractive`, `llm`, or `none` when nothing was answered.
    answer_source: str = "extractive"
    #: Why a model did not write this. `none` when one did, or when none was
    #: ever going to - mirrors `ObservationOut.fallback_reason`.
    fallback_reason: str = "none"
    relevance: Relevance = Relevance.NONE
    best_similarity: float | None = None
    refused_reason: str | None = None
    vector_is_semantic: bool = False


def _citation(chunk: ScoredChunk) -> Citation:
    return Citation(
        chunk_id=chunk.chunk_id,
        document_id=chunk.document_id,
        concept_slug=chunk.concept_slug,
        title=chunk.title,
        heading=chunk.heading,
        text=chunk.text,
        similarity=chunk.vector_similarity,
    )


def _extractive(question: str, chunks: tuple[ScoredChunk, ...]) -> str:
    """The answer when no model writes one: the passages, named and quoted.

    Deliberately not a summary. Anything that condenses the corpus is generation
    by another name, and the whole point of this path is that it cannot invent.
    """
    if not chunks:
        return "Nothing in the reference corpus matches that question."

    lead = chunks[0]
    where = f"{lead.title}" + (f" - {lead.heading}" if lead.heading else "")
    return f"From {where}:\n\n{lead.text}"


async def _generated(
    llm: LLMProvider,
    question: str,
    chunks: tuple[ScoredChunk, ...],
    user_id: str | None = None,
) -> tuple[str | None, str]:
    """Ask a model to connect the passages. Returns (text, fallback_reason).

    `reasoning_effort` is **not** turned off here, unlike narration. Decision 21:
    narration restates figures under rules and has no judgement to improve,
    while deciding whether these passages actually answer this question is
    exactly the judgement worth paying for. `None` means "no opinion, use the
    deployment default" rather than forcing one.
    """
    passages = "\n\n".join(
        f"[{i}] {c.title}" + (f" - {c.heading}" if c.heading else "") + f"\n{c.text}"
        for i, c in enumerate(chunks, start=1)
    )
    try:
        completion = await llm.complete(
            system=_SYSTEM_PROMPT,
            user=f"Passages:\n\n{passages}\n\nQuestion: {question}",
            reasoning_effort=None,
            caller=Caller(agent="ask", user_id=user_id),
        )
    except LLMError as error:
        return None, type(error).__name__

    text = completion.text.strip()
    if not text:
        await llm.record_verdict(completion.call_id, "empty_completion")
        return None, "empty_completion"
    # Before the figures: a loop can carry a sourced number and pass that check.
    if is_degenerate(text):
        log.warning("ask.degenerate_completion", run=(repeated_run(text) or "")[:40])
        await llm.record_verdict(completion.call_id, "degenerate_completion")
        return None, "degenerate_completion"

    # The same check narration applies, with the passages standing in for a
    # finding's evidence: a figure in the answer that is not in the corpus text
    # is invented, however plausible it reads.
    sourced: dict[str, object] = {}
    for chunk_index, chunk in enumerate(chunks):
        for number_index, token in enumerate(_NUMBER.findall(chunk.text)):
            try:
                sourced[f"p{chunk_index}_{number_index}"] = Decimal(token.replace(",", ""))
            except InvalidOperation:  # pragma: no cover - pattern only matches numbers
                continue

    unsourced = unsourced_figures(text, sourced)
    if unsourced:
        log.warning("ask.unsourced_figures", figures=unsourced[:5], question=question[:80])
        await llm.record_verdict(completion.call_id, "unsourced_figures")
        return None, "unsourced_figures"

    await llm.record_verdict(completion.call_id, "accepted")
    return text, "none"


async def answer_concept_question(
    connection: Connection,
    store: VectorStore,
    embedder: BaseEmbedder,
    *,
    question: str,
    llm: LLMProvider | None = None,
    passages: int = DEFAULT_PASSAGES,
    user_id: str | None = None,
) -> Answer:
    """Retrieve, judge, and either answer from the corpus or refuse."""
    result = await hybrid_search(connection, store, embedder, query=question, limit=passages)

    # The vector half's own best score, not the fused one: RRF is not comparable
    # across queries, and `relevance.py` exists because cosine is. `hybrid_search`
    # carries it through fusion for exactly this, so the floor costs no second
    # query.
    verdict = judge(result.best_similarity, vector_is_semantic=result.vector_is_semantic)

    if not verdict.is_answerable:
        return Answer(
            question=question,
            intent=Intent.CONCEPT,
            answered=False,
            text=(
                "I do not have anything in the reference corpus about that. It covers "
                "the terms this product uses in its own observations - things like "
                "drawdown, volatility and rebalancing."
            ),
            answer_source="none",
            relevance=verdict.relevance,
            best_similarity=verdict.best_similarity,
            refused_reason="not_in_corpus",
            vector_is_semantic=result.vector_is_semantic,
        )

    text = _extractive(question, result.chunks)
    source, reason = "extractive", "no_llm_configured" if llm is None else "none"

    if llm is not None:
        generated, reason = await _generated(llm, question, result.chunks, user_id)
        if generated is not None:
            text, source = generated, "llm"

    if verdict.relevance is Relevance.WEAK:
        text = f"{WEAK_MATCH_PREFIX}\n\n{text}"

    return Answer(
        question=question,
        intent=Intent.CONCEPT,
        answered=True,
        text=text,
        citations=tuple(_citation(c) for c in result.chunks),
        concept_refs=tuple(dict.fromkeys(c.concept_slug for c in result.chunks if c.concept_slug)),
        answer_source=source,
        fallback_reason=reason,
        relevance=verdict.relevance,
        best_similarity=verdict.best_similarity,
        vector_is_semantic=result.vector_is_semantic,
    )


#: The portfolio questions this product can compute, matched in order. Short on
#: purpose - see `portfolio.py`. Each entry is (marker phrases, handler name);
#: the first whose marker appears wins, so more specific phrases come first.
#: "largest" before "position" matters, and is the only ordering constraint.
_PORTFOLIO_HANDLERS: tuple[tuple[tuple[str, ...], str], ...] = (
    (("largest position", "biggest position", "largest holding", "biggest holding"), "largest"),
    (("smallest position", "smallest holding"), "smallest"),
    (("target", "drift", "overweight", "underweight", "rebalance"), "drift"),
    (("worth", "total", "value", "how much do i have", "portfolio value"), "total"),
)


#: Asking what to *do* with a holding. Checked before any handler, because each
#: of these can contain a phrase a handler matches - "should I sell my largest
#: position" names the largest position, and answering it with that position's
#: value would dodge the question silently instead of declining it. Guideline 2:
#: no personalised investment advice. Found by the eval set, not by review.
_ADVICE_MARKERS: tuple[str, ...] = (
    "should i buy",
    "should i sell",
    "should i hold",
    "should i invest",
    "should i add",
    "should i trim",
    "should i rebalance",
    "is it a good time",
    "is now a good time",
    "what should i do",
    "do you recommend",
    "would you recommend",
)

#: Asking about a future value. A forecast is not arithmetic over what the caller
#: supplied, so no handler can answer it - but "what will my portfolio be worth
#: next year" contains "worth", and the total handler would answer with today's
#: figure, confidently, to a question about next year. Also found by the eval.
_FORECAST_MARKERS: tuple[str, ...] = (
    " will ",
    "going to be",
    "next year",
    "next month",
    "next week",
    "in the future",
    "predict",
    "forecast",
    "expect it to",
    "by the end of",
)


def _match_handler(question: str) -> str | None:
    text = question.lower()
    for markers, name in _PORTFOLIO_HANDLERS:
        if any(marker in text for marker in markers):
            return name
    return None


def answer_portfolio_question(
    *,
    question: str,
    positions: list[portfolio_answers.Position],
    currency: str = "USD",
    targets: dict[str, str] | None = None,
) -> Answer:
    """Answer from arithmetic over the caller's holdings, or decline by name.

    The ways of declining are kept apart deliberately - see the module
    docstring. `no_holdings` is the caller's problem to fix, `not_computable` is
    the product's boundary, `advice` is guideline 2, and none of them is "the
    corpus does not cover it". Advice and forecasts are checked *before* the
    handlers, because both kinds of question routinely contain a phrase some
    handler would otherwise answer.
    """
    if not positions:
        return Answer(
            question=question,
            intent=Intent.PORTFOLIO,
            answered=False,
            text=(
                "That looks like a question about your portfolio, but no holdings "
                "were supplied with it, so there is nothing to compute from."
            ),
            answer_source="none",
            refused_reason="no_holdings",
        )

    # Padded so a marker with its own spaces (" will ") matches at either end.
    lowered = f" {question.lower().strip()} "

    if any(marker in lowered for marker in _ADVICE_MARKERS):
        return Answer(
            question=question,
            intent=Intent.PORTFOLIO,
            answered=False,
            text=(
                "I can't tell you whether to buy, sell or hold anything - this product "
                "never gives personal investment advice. I can tell you what your "
                "holdings are worth, how large each one is, and how far your weights "
                "sit from the targets you set."
            ),
            answer_source="none",
            refused_reason="advice",
        )

    if any(marker in lowered for marker in _FORECAST_MARKERS):
        return Answer(
            question=question,
            intent=Intent.PORTFOLIO,
            answered=False,
            text=(
                "I can only report what your portfolio is worth now, from current "
                "prices. I can't forecast what it will be worth later."
            ),
            answer_source="none",
            refused_reason="not_computable",
        )

    handler = _match_handler(question)
    result = None

    if handler == "largest":
        result = portfolio_answers.extreme_position(positions, currency, largest=True)
    elif handler == "smallest":
        result = portfolio_answers.extreme_position(positions, currency, largest=False)
    elif handler == "drift":
        result = portfolio_answers.drift_against_targets(positions, currency, targets=targets or {})
    elif handler == "total":
        result = portfolio_answers.total_value(positions, currency)
    else:
        # Before giving up, check whether they named one of their own holdings -
        # "how much AAPL do I have" has no marker phrase and is answerable.
        for position in positions:
            if re.search(rf"\b{re.escape(position.symbol.lower())}\b", question.lower()):
                result = portfolio_answers.position_weight(
                    positions, currency, symbol=position.symbol
                )
                break

    if result is None:
        return Answer(
            question=question,
            intent=Intent.PORTFOLIO,
            answered=False,
            text=(
                "I can answer what your portfolio is worth, which holding is largest "
                "or smallest, what a particular holding is worth, and how far your "
                "weights sit from your targets. I cannot answer that one."
            ),
            answer_source="none",
            refused_reason="not_computable",
        )

    return Answer(
        question=question,
        intent=Intent.PORTFOLIO,
        answered=True,
        text=result.text,
        concept_refs=result.concept_refs,
        evidence=result.evidence,
        # Never `llm`, and not by omission: a model is never asked what a
        # portfolio contains. Every figure here is arithmetic over what the
        # caller supplied, which is the only way a number about someone's money
        # can be trusted (guideline 7).
        answer_source="computed",
        fallback_reason="none",
        relevance=Relevance.CONFIDENT,
    )


async def answer(
    connection: Connection,
    store: VectorStore,
    embedder: BaseEmbedder,
    *,
    question: str,
    positions: list[portfolio_answers.Position] | None = None,
    currency: str = "USD",
    targets: dict[str, str] | None = None,
    llm: LLMProvider | None = None,
    passages: int = DEFAULT_PASSAGES,
    user_id: str | None = None,
) -> Answer:
    """Route one question and answer it. The entry point the router calls."""
    positions = positions or []
    intent = classify(question, symbols=tuple(p.symbol for p in positions))

    if intent is Intent.PORTFOLIO:
        return answer_portfolio_question(
            question=question, positions=positions, currency=currency, targets=targets
        )

    return await answer_concept_question(
        connection,
        store,
        embedder,
        question=question,
        llm=llm,
        passages=passages,
        user_id=user_id,
    )
