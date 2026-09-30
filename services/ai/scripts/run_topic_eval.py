"""Run the topic-resolution eval (M5) against a loaded, embedded universe.

    python scripts/run_topic_eval.py [--cases PATH] [--verbose]

Each case in `data/eval/topics.json` is a topic and what resolution must do:
offer every listed symbol among its candidates, or resolve to nothing. A case
passes or fails; there is no partial credit, for `run_eval.py`'s reason - a
behaviour that is right 80% of the time is a behaviour that is wrong. The report
does print, per failing case, where each missing symbol actually ranked, because
"ranked 17th with a limit of 15" and "not in the universe" need different fixes.

**Keyed only.** Resolution is a judgement about meaning, and the fixture
embedder counts shared words, so "chips" could never find NVIDIA through it. A
run on a non-semantic embedder is refused rather than reported, since a pass or
a fail there would describe the placeholder rather than the resolver.

**It also re-measures the thresholds on held-out topics.** `resolution.py`'s
bands were fitted to `threshold_fitting_topics`; the report prints the best-match
similarity separation on those and, separately, on the eval's own cases, and
says whether `NOTHING_BELOW` still sits between the classes on data it was not
chosen from.

**Sealed cases are skipped unless `--unseal` is passed.** They are the user's
second batch, handed over after the first run exposed the ranking problem, and
kept unrun until the fix was final - otherwise they would have become the
fixture the fix was tuned against. A seal holds exactly once.

No model is called. Exits non-zero if any case fails.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

from sqlalchemy import text

from app.config import get_settings
from app.corpus.embedder_factory import build_embedder
from app.corpus.retrieval import _NON_SEMANTIC_MODELS
from app.db import get_engine
from app.topics.resolution import (
    BAND,
    CANDIDATE_FLOOR,
    CANDIDATE_LIMIT,
    MEANINGS_SPLIT_BELOW,
    NOTHING_BELOW,
    STRONG_ABOVE,
    resolve_topic,
)
from app.universe.profiles import search_profiles

#: How deep to look when reporting where a missing symbol ranked. Diagnostic
#: only: no pass or fail is decided at this depth.
DIAGNOSTIC_DEPTH = 100


def default_cases() -> Path:
    return Path(get_settings().corpus_dir).parent / "eval" / "topics.json"


def _separation(label: str, in_domain: list[float], out_of_domain: list[float]) -> None:
    low_in, high_out = min(in_domain), max(out_of_domain)
    placed = "inside" if high_out < NOTHING_BELOW <= low_in else "OUTSIDE"
    print(
        f"{label}: lowest in-domain {low_in:.4f}, highest out-of-domain {high_out:.4f}, "
        f"separation {low_in - high_out:+.4f}; NOTHING_BELOW={NOTHING_BELOW} is {placed} the gap"
    )


def _in_universe(connection: Any, symbols: list[str]) -> set[str]:
    rows = connection.execute(
        text(
            """
            SELECT i.symbol
              FROM instrument_profiles p
              JOIN instruments i ON i.id = p.instrument_id
             WHERE i.symbol = ANY(:symbols) AND p.membership = 'screened'
            """
        ),
        {"symbols": symbols},
    )
    return {row.symbol for row in rows}


async def run(data: dict[str, Any], *, verbose: bool, unseal: bool) -> int:
    embedder = build_embedder(get_settings())
    if embedder.model in _NON_SEMANTIC_MODELS:
        print(f"refusing to run on non-semantic embedder {embedder.model}", file=sys.stderr)
        return 2

    failures = 0
    eval_in: list[float] = []
    eval_out: list[float] = []
    with get_engine().begin() as connection:
        cases = [c for c in data["cases"] if unseal or not c.get("sealed")]
        skipped = len(data["cases"]) - len(cases)
        for case in cases:
            resolution = await resolve_topic(connection, embedder, case["topic"])
            best = resolution.judgement.best_similarity
            # A case is judged on the interpretation the user would pick: the
            # one holding the most expected symbols. Ambiguity is not a pass or
            # a fail in itself - "chips" meaning snacks too is true.
            lists = [[c.symbol for c in i.candidates] for i in resolution.interpretations]
            expect = case["expect"]
            shape = (
                f" [{len(lists)} meanings: "
                + " | ".join(str(i.label) for i in resolution.interpretations)
                + "]"
                if resolution.ambiguous
                else ""
            )

            if "must_include" in expect:
                eval_in.append(best)
                wanted = expect["must_include"]
                chosen = max(
                    lists, key=lambda offered: sum(s in offered for s in wanted), default=[]
                )
                missing = [s for s in wanted if s not in chosen]
                passed = resolution.resolved and not missing
                detail = ""
                if missing:
                    deep = search_profiles(
                        connection,
                        embedding=await embedder.embed_query(case["topic"]),
                        model=embedder.model,
                        limit=DIAGNOSTIC_DEPTH,
                    )
                    rank = {m.symbol: i + 1 for i, m in enumerate(deep)}
                    present = _in_universe(connection, missing)
                    detail = " missing " + ", ".join(
                        f"{s}@{rank.get(s, f'>{DIAGNOSTIC_DEPTH}')}"
                        if s in present
                        else f"{s}@not-in-universe"
                        for s in missing
                    )
            else:
                eval_out.append(best)
                passed = not resolution.resolved
                detail = f" offered {lists[0][:5]}" if not passed else ""

            failures += not passed
            verdict = "PASS" if passed else "FAIL"
            print(
                f"{verdict} {case['id']:34} {resolution.judgement.relevance.value:9} "
                f"best={best:.4f}{shape}{detail}"
            )
            if verbose:
                for interpretation in resolution.interpretations:
                    print(f"     -- {interpretation.label}")
                    for candidate in interpretation.candidates:
                        held = ",".join(f"{h.etf}:{h.weight}" for h in candidate.held_by)
                        print(
                            f"       {candidate.symbol:6} {candidate.similarity:.4f} "
                            f"{candidate.confidence.value:9} [{held}] {candidate.rationale[:70]}"
                        )

        fitting = data["threshold_fitting_topics"]
        fit_scores: dict[str, list[float]] = {}
        for group in ("in_domain", "out_of_domain"):
            fit_scores[group] = []
            for topic in fitting[group]:
                matches = search_profiles(
                    connection,
                    embedding=await embedder.embed_query(topic),
                    model=embedder.model,
                    limit=1,
                )
                fit_scores[group].append(matches[0].similarity if matches else 0.0)

    total = len(cases)
    print(
        f"\n{total - failures}/{total} passed"
        + (f" ({skipped} sealed cases not run)" if skipped else "")
        + " "
        f"(limit {CANDIDATE_LIMIT}, nothing below {NOTHING_BELOW}, strong above "
        f"{STRONG_ABOVE}, band {BAND}, floor {CANDIDATE_FLOOR}, "
        f"meanings split below {MEANINGS_SPLIT_BELOW})"
    )
    _separation("fitting set", fit_scores["in_domain"], fit_scores["out_of_domain"])
    if eval_in and eval_out:
        _separation("held-out eval", eval_in, eval_out)
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the topic-resolution eval.")
    parser.add_argument("--cases", type=Path, default=None)
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--unseal", action="store_true", help="also run sealed cases")
    args = parser.parse_args()
    data = json.loads((args.cases or default_cases()).read_text(encoding="utf-8"))
    return asyncio.run(run(data, verbose=args.verbose, unseal=args.unseal))


if __name__ == "__main__":
    raise SystemExit(main())
