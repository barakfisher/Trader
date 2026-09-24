"""Run the `/ask` eval set (M3 slice 4) against a real database.

    python scripts/run_eval.py --tier keyless|keyed [--cases PATH] [--verbose]

Every case in `data/eval/ask.json` is a question and what `/ask` must do with it:
answer from a named concept, compute from the demo portfolio, or decline for an
exact reason. A case either passes or it does not; there is no partial credit and
no hit-rate bar to tune, because each case is a claim about behaviour and a
behaviour that is right 80% of the time is a behaviour that is wrong.

**Two tiers, because CI is keyless and the headline behaviour is not.** The
`keyless` tier runs on every PR against the fixture embedder: routing, the
deterministic refusals, portfolio arithmetic, and concept questions phrased in
the corpus's own words. The `keyed` tier additionally runs paraphrases and
out-of-domain refusals, which need a semantic embedder - the relevance floor
abstains on the fixture by design, so the `not_in_corpus` refusal M3's exit
criterion names **cannot happen** on the keyless path, and asserting it there
would assert something false. A keyed run on a non-semantic embedder is refused
outright rather than reported as a pass.

**The keyed tier also re-derives the relevance thresholds** from questions they
were not fitted to, and that is half its value. `relevance.py`'s numbers came
from sixteen questions that are listed in the eval file and excluded from it, so
this is the first measurement of the floor on held-out data. The report prints
the lowest in-domain and highest out-of-domain similarity and says whether
`REFUSE_BELOW` still sits between them.

**No model is called, deliberately.** `/ask` can use an LLM to write a connecting
paragraph, but generation is non-deterministic and costs money per run, and
nothing about routing, retrieval or refusal depends on it - every case here is
decided before a model would be consulted. An eval that sometimes fails because
a model phrased something differently would teach everyone to ignore it.

Exits non-zero if any case in the tier fails.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import dataclass
from pathlib import Path

from app.ask.portfolio import Position
from app.ask.relevance import REFUSE_BELOW
from app.ask.service import WEAK_MATCH_PREFIX, Answer, answer
from app.config import get_settings
from app.corpus.embedder_factory import build_embedder
from app.corpus.retrieval import _NON_SEMANTIC_MODELS
from app.corpus.vector_store import PgVectorStore
from app.db import get_engine

#: The portfolio every `holdings: "demo"` case is asked against. Fixed rather
#: than read from the database, so the eval measures `/ask` and not whatever the
#: last smoke test happened to import. One unpriced holding on purpose: it is the
#: case most likely to be silently dropped, and every portfolio answer must still
#: account for it.
DEMO_HOLDINGS = [
    Position("VOO", 1_250_000, "USD"),
    Position("AAPL", 480_000, "USD"),
    Position("MSFT", 320_000, "USD"),
    Position("XYZ", None, "USD"),
]
DEMO_TARGETS = {"VOO": "0.50", "AAPL": "0.30", "MSFT": "0.20"}


def default_cases() -> Path:
    """`data/eval/ask.json`, beside the corpus in both places this runs.

    Derived from `Settings.corpus_dir` rather than from this file's location,
    for the reason `ingest_corpus.py` gives: a repo-relative guess raises from
    /app/scripts inside the container. The eval directory sits next to the
    corpus in the checkout and in the image, so one resolution serves both.
    """
    return Path(get_settings().corpus_dir).parent / "eval" / "ask.json"


@dataclass(frozen=True, slots=True)
class Outcome:
    case_id: str
    question: str
    passed: bool
    reason: str
    answer: Answer
    expect: dict[str, object]
    out_of_domain: bool = False


def check(case: dict[str, object], result: Answer) -> tuple[bool, str]:
    """Does `result` satisfy the case? Returns (passed, why-not)."""
    expect = case["expect"]
    assert isinstance(expect, dict)

    if result.intent.value != case["intent"]:
        return False, f"routed to {result.intent.value}, expected {case['intent']}"

    if "refused" in expect:
        if result.answered:
            return False, f"answered ({result.answer_source}), expected refusal {expect['refused']}"
        if result.refused_reason != expect["refused"]:
            return False, f"refused as {result.refused_reason}, expected {expect['refused']}"
        return True, ""

    if not result.answered:
        return False, f"refused ({result.refused_reason}), expected an answer"

    if expect.get("hedged"):
        # Answered, graded weak, and *saying so in the text* - not merely
        # flagged on the wire, where a reader of the reply never sees it.
        if result.relevance.value != "weak":
            return False, f"graded {result.relevance.value}, expected a weak (hedged) match"
        if not result.text.startswith(WEAK_MATCH_PREFIX):
            return False, "graded weak but the text does not say so"

    if "answer_source" in expect and result.answer_source != expect["answer_source"]:
        return False, f"answer_source {result.answer_source}, expected {expect['answer_source']}"

    if "slugs" in expect:
        wanted = set(expect["slugs"])  # type: ignore[arg-type]
        cited = {c.concept_slug for c in result.citations}
        if not wanted & cited:
            return False, f"cited {sorted(s for s in cited if s)}, expected one of {sorted(wanted)}"

    return True, ""


async def run(tier: str, data: dict[str, object], verbose: bool) -> int:
    settings = get_settings()
    embedder = build_embedder(settings)
    semantic = embedder.model not in _NON_SEMANTIC_MODELS

    if tier == "keyed" and not semantic:
        # A keyed run on the fixture would "pass" the paraphrase cases by
        # accident or fail them for no reason, and it cannot reach a single
        # `not_in_corpus` refusal. Reporting that as a result would be worse
        # than reporting nothing.
        print(
            f"error: the keyed tier needs a semantic embedder; EMBEDDINGS_PROVIDER "
            f"resolved to {embedder.model}. Set EMBEDDINGS_PROVIDER=openrouter."
        )
        return 2

    cases = [c for c in data["cases"] if tier in c["tiers"]]  # type: ignore[union-attr]
    store = PgVectorStore()
    outcomes: list[Outcome] = []

    with get_engine().connect() as connection:
        for case in cases:
            holdings = DEMO_HOLDINGS if case.get("holdings") == "demo" else []
            result = await answer(
                connection,
                store,
                embedder,
                question=case["question"],
                positions=holdings,
                currency="USD",
                targets=DEMO_TARGETS if holdings else {},
                llm=None,
            )
            passed, reason = check(case, result)
            outcomes.append(
                Outcome(
                    case["id"],
                    case["question"],
                    passed,
                    reason,
                    result,
                    case["expect"],
                    bool(case.get("out_of_domain")),
                )
            )

    # --- report --------------------------------------------------------------
    print(f"eval tier={tier}  embedder={embedder.model}  semantic={semantic}  cases={len(cases)}")
    print()
    for o in outcomes:
        sim = f"{o.answer.best_similarity:.3f}" if o.answer.best_similarity is not None else "  -  "
        mark = "PASS" if o.passed else "FAIL"
        line = f"  {mark}  {o.case_id:22} sim={sim}  {o.answer.relevance.value:9}"
        if not o.passed or verbose:
            line += f"  {o.question!r}"
        if not o.passed:
            line += f"\n        -> {o.reason}"
        print(line)

    failed = [o for o in outcomes if not o.passed]
    print()
    print(f"{len(outcomes) - len(failed)}/{len(outcomes)} passed")

    if semantic:
        _report_thresholds(outcomes)

    return 1 if failed else 0


def _report_thresholds(outcomes: list[Outcome]) -> None:
    """Re-derive the relevance floor on held-out questions.

    Only concept cases count: a portfolio answer never consults the floor. The
    in-domain set is every concept case expected to be answered; out-of-domain
    is every case expected to be refused as `not_in_corpus`.
    """
    inside = [
        o.answer.best_similarity
        for o in outcomes
        if o.answer.intent.value == "concept"
        and "slugs" in o.expect
        and o.answer.best_similarity is not None
    ]
    # Out-of-domain by what a case *is*, not by what it expects. `adjacent-gold`
    # is hedged rather than refused, and counting only refusals would drop the
    # single hardest out-of-domain question from this figure - which is exactly
    # what happened the first time: separation "improved" from +0.0667 to
    # +0.1404 and the floor was reported "inside the gap", with no change to
    # retrieval at all, purely because a case was relabelled.
    outside = [
        o.answer.best_similarity
        for o in outcomes
        if (o.expect.get("refused") == "not_in_corpus" or o.out_of_domain)
        and o.answer.best_similarity is not None
    ]
    if not inside or not outside:
        return

    lo, hi = min(inside), max(outside)
    print()
    print("relevance floor, measured on held-out questions")
    print(f"  lowest in-domain similarity    {lo:.4f}")
    print(f"  highest out-of-domain          {hi:.4f}")
    print(f"  separation                     {lo - hi:+.4f}")
    print(f"  REFUSE_BELOW                   {REFUSE_BELOW:.4f}", end="  ")
    if hi < REFUSE_BELOW <= lo:
        print("-> inside the gap")
    elif lo <= hi:
        print("-> NO GAP: the classes overlap, so no single threshold separates them")
    else:
        print(f"-> outside the gap; a value in ({hi:.4f}, {lo:.4f}] would separate these")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the /ask eval set.")
    parser.add_argument("--tier", choices=("keyless", "keyed"), required=True)
    parser.add_argument("--cases", type=Path, default=None)
    parser.add_argument("--verbose", action="store_true", help="print every question")
    args = parser.parse_args()
    # Read before entering the event loop: a blocking file read inside a
    # coroutine is harmless here and still the wrong habit to have in a file
    # that sits beside code serving requests.
    data = json.loads((args.cases or default_cases()).read_text(encoding="utf-8"))
    return asyncio.run(run(args.tier, data, args.verbose))


if __name__ == "__main__":
    sys.exit(main())
