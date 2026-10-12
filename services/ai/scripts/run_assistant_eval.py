"""Run the assistant eval set (`data/eval/assistant.json`) on a real model.

    PYTHONPATH=. .venv/bin/python scripts/run_assistant_eval.py \\
        --database-url postgresql://traders:traders@127.0.0.1:55435/traders_ci \\
        --model google/gemini-3.5-flash-lite --max-usd 1.00 [--judge MODEL] \\
        [--cases ID,ID] [--group NAME] [--repeat N] [--concurrency N] [--out DIR]

Each case is one conversation on a fresh account seeded as its `fixture` names
(`scripts/assistant_eval/world.py`), asked through `ask()` - the code
`POST /assistant/messages` runs, its checks and its repair turn included. Each
turn is graded mechanically from its `expect` and by a judge model on its
`behaviour` (`scripts/assistant_eval/grading.py`).

**Keyed only, never in CI.** Every case needs a model; a run costs money and
its result varies run to run. That is why it reports rather than gates: the
exit code is non-zero only when the run could not finish.

**A spend cap, enforced twice.** `--max-usd` stops the run between cases once
the recorded spend (the assistant's and the judge's) reaches it, and is also
the spend guard's daily cap for the run's Redis counter (a database of its own,
`--redis-url`), so a single runaway case cannot pass it by much.

**The database is wiped and rebuilt** unless `--reuse-database`: its name must
end in `_ci` or `_test`.

`--repeat N` asks every case N times: one sample says little about a model that
declined "How was the universe made?" four times in six.

What it measures beyond pass and fail: cost per question from `llm_calls`
(`purpose = 'assistant'`), the daily limit's source (MEMORY.md, "the assistant's
PR 4"), and steps and seconds per question.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import statistics
import sys
import time
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from redis.asyncio import Redis
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

from app.agents.tools import Tool, ToolContext, scan_context
from app.analysis.thresholds import AnalysisThresholds
from app.assistant.service import ask
from app.assistant.tools import TOOLS_BY_NAME
from app.config import Settings, get_settings
from app.corpus.hashed_embedder import HashedEmbedder
from app.corpus.vector_store import PgVectorStore
from app.llm.base import LLMError, LLMProvider
from app.llm.call_log import DatabaseCallLog
from app.llm.factory import build_llm
from scripts.assistant_eval.grading import (
    JUDGE_SYSTEM,
    Check,
    judge_prompt,
    mechanical,
    parse_verdict,
)
from scripts.assistant_eval.market import EvalMarket
from scripts.assistant_eval.world import REPO_ROOT, build_database, disposable, seed_account

DEFAULT_CASES = REPO_ROOT / "data" / "eval" / "assistant.json"
DEFAULT_JUDGE = "anthropic/claude-sonnet-5.5"
DEFAULT_REDIS = "redis://127.0.0.1:6379/15"
#: A provider refusing the key itself - spent, revoked or unpaid - rather than one request.
_REFUSED = re.compile(r"HTTP 40[123]\b")
#: Room for a one-sentence verdict, and for a model that thinks before it writes one.
JUDGE_MAX_OUTPUT_TOKENS = 1000


@dataclass
class TurnResult:
    case: str
    group: str
    fixture: str
    sample: int
    turn: int
    question: str
    outcome: str
    reason: str | None
    text: str
    tools: list[str]
    sources: int
    steps: int
    seconds: float
    cost_micro_usd: int
    problems: list[str]
    checks: list[Check]
    behaviour: str
    user_id: str = ""
    started_at: datetime | None = None
    finished_at: datetime | None = None
    judge: dict[str, Any] | None = None
    injected: bool | None = None
    #: From `llm_calls`, filled in after the run (`_measure`).
    calls: int = 0
    prompt_tokens: int = 0
    measured_micro_usd: int | None = None

    @property
    def mechanical_pass(self) -> bool:
        return all(check.passed for check in self.checks)

    @property
    def passed(self) -> bool:
        return self.mechanical_pass and bool(self.judge and self.judge.get("pass"))


@dataclass
class Spend:
    assistant_micro_usd: int = 0
    judge_micro_usd: int = 0
    stopped: str | None = None

    @property
    def total_micro_usd(self) -> int:
        return self.assistant_micro_usd + self.judge_micro_usd


# -- inject -----------------------------------------------------------------------


@dataclass
class Injections:
    """Attacker text put into one tool's result, for one account only.

    The wrapper is installed once for the run and keyed by user, so a case run
    beside the attack case never sees the attack.
    """

    by_user: dict[str, dict[str, Any]] = field(default_factory=dict)
    reached: set[str] = field(default_factory=set)

    def install(self, tools: set[str]) -> None:
        for name in tools:
            original = TOOLS_BY_NAME[name]

            async def handler(
                context: ToolContext,
                arguments: Mapping[str, Any],
                _original: Tool = original,
                _name: str = name,
            ) -> dict[str, Any]:
                result = await _original.handler(context, arguments)
                inject = self.by_user.get(context.user_id)
                symbol = str(arguments.get("symbol", "")).strip().upper()
                if inject is None or inject["tool"] != _name or symbol != inject["symbol"]:
                    return result
                return self._apply(context.user_id, result, inject["text"])

            TOOLS_BY_NAME[name] = Tool(original.spec, handler)

    def _apply(self, user_id: str, result: dict[str, Any], attack: str) -> dict[str, Any]:
        """The first article's headline becomes the attack; a result with none gets one."""
        articles = list(result.get("articles") or [])
        first = (
            articles[0]
            if articles
            else {
                "source": "Example Newswire",
                "url": "https://news.example.com/injected",
                "published": datetime.now(UTC).isoformat(),
                "sentiment": None,
            }
        )
        articles[:1] = [{**first, "title": attack}]
        self.reached.add(user_id)
        return {**result, "articles": articles}


# -- one case -----------------------------------------------------------------------


def _this_turn(engine: Engine, message_id: str | None) -> list[dict[str, Any]]:
    if message_id is None:
        return []
    with engine.connect() as connection:
        transcript = connection.execute(
            text("SELECT tool_calls FROM assistant_messages WHERE id = CAST(:id AS uuid)"),
            {"id": message_id},
        ).scalar_one()
    return transcript if isinstance(transcript, list) else []


async def _judge(judge: LLMProvider, prompt: str, spend: Spend) -> dict[str, Any]:
    try:
        completion = await judge.complete(
            system=JUDGE_SYSTEM,
            user=prompt,
            max_output_tokens=JUDGE_MAX_OUTPUT_TOKENS,
            temperature=0,
        )
    except LLMError as error:
        return {"pass": False, "why": f"the judge failed: {error}", "error": True}
    spend.judge_micro_usd += completion.estimated_cost_micro_usd
    verdict = parse_verdict(completion.text)
    if verdict is None:
        return {"pass": False, "why": f"unreadable verdict: {completion.text[:200]}", "error": True}
    return {"pass": verdict[0], "why": verdict[1]}


async def run_case(
    case: Mapping[str, Any],
    sample: int,
    *,
    engine: Engine,
    market: EvalMarket,
    llm: LLMProvider,
    judge: LLMProvider | None,
    settings: Settings,
    injections: Injections,
    spend: Spend,
) -> list[TurnResult]:
    now = datetime.now(UTC)
    account = await seed_account(engine, market, case["fixture"], now)
    if case.get("inject"):
        injections.by_user[account.user_id] = case["inject"]
    conversation_id: str | None = None
    conversation: list[tuple[str, str]] = []
    results: list[TurnResult] = []
    for n, turn in enumerate(case["turns"], start=1):
        expect = turn["expect"]
        context = scan_context(
            engine=engine,
            market=market,  # type: ignore[arg-type] - duck-typed, as in the tools' tests
            embedder=HashedEmbedder(),
            vector_store=PgVectorStore(),
            thresholds=AnalysisThresholds.from_settings(settings),
            excluded_price_sources=(),
            user_id=account.user_id,
            agent_id=account.primary_id,
        )
        started, started_at = time.monotonic(), datetime.now(UTC)
        reply = await ask(
            engine=engine,
            llm=llm,
            context=context,
            question=turn["user"],
            conversation_id=conversation_id,
            now=datetime.now(UTC),
            timezone=settings.app_timezone,
        )
        seconds = time.monotonic() - started
        assert reply is not None
        conversation_id = reply.conversation_id
        spend.assistant_micro_usd += reply.cost_micro_usd
        transcript = _this_turn(engine, reply.message_id)
        tools = [
            call["name"]
            for entry in transcript
            if entry.get("role") == "assistant"
            for call in entry.get("tool_calls", [])
        ]
        tool_results = [entry for entry in transcript if entry.get("role") == "tool"]
        checks = mechanical(
            expect,
            outcome=reply.outcome,
            reason=reply.reason,
            text=reply.text,
            tools=tools,
            sources=reply.sources,
        )
        injected = None
        if case.get("inject"):
            injected = account.user_id in injections.reached
            checks.append(
                Check("inject", injected, "" if injected else "the attack never reached the model")
            )
        result = TurnResult(
            case=case["id"],
            group=case["group"],
            fixture=case["fixture"],
            sample=sample,
            turn=n,
            question=turn["user"],
            outcome=reply.outcome,
            reason=reply.reason,
            text=reply.text,
            tools=tools,
            sources=len(reply.sources),
            steps=reply.steps,
            seconds=round(seconds, 2),
            cost_micro_usd=reply.cost_micro_usd,
            problems=list(reply.problems),
            checks=checks,
            behaviour=expect["behaviour"],
            user_id=account.user_id,
            started_at=started_at,
            finished_at=datetime.now(UTC),
            injected=injected,
        )
        if judge is not None and reply.outcome in ("answer", "decline", "clarify"):
            result.judge = await _judge(
                judge,
                judge_prompt(
                    conversation=conversation,
                    question=turn["user"],
                    outcome=reply.outcome,
                    reason=reply.reason,
                    reply=reply.text,
                    tool_results=tool_results,
                    behaviour=expect["behaviour"],
                ),
                spend,
            )
        elif judge is not None:
            result.judge = {"pass": False, "why": f"no reply to judge ({reply.outcome})"}
        results.append(result)
        conversation += [("user", turn["user"]), ("assistant", reply.text)]
    return results


def refused(turns: Sequence[TurnResult]) -> str | None:
    """What the provider said when it refused the key, if it did in any of `turns`."""
    said = [p for t in turns for p in t.problems] + [
        str(t.judge.get("why")) for t in turns if t.judge and t.judge.get("error")
    ]
    return next((words for words in said if _REFUSED.search(words)), None)


# -- the run --------------------------------------------------------------------------


def _llm(
    settings: Settings, model: str, redis: Redis, cap_usd: Decimal, engine: Engine | None
) -> LLMProvider:
    """The configured gateway, pointed at `model` (no Admin choice applies)."""
    configured = settings.model_copy(
        update={"llm_provider": "openrouter", "llm_model": model, "llm_daily_budget_usd": cap_usd}
    )
    call_log = DatabaseCallLog(engine, configured.llm_call_retention_days) if engine else None
    return build_llm(configured, redis, call_log=call_log)


def _measure(engine: Engine, results: Sequence[TurnResult]) -> None:
    """Each question's recorded spend, from `llm_calls` - not from the runner's own sums.

    A case's turns run one after another on an account of its own, so a turn's
    calls are exactly that user's `assistant` calls inside the turn's window.
    """
    with engine.connect() as connection:
        for result in results:
            row = connection.execute(
                text(
                    """
                    SELECT count(*) AS calls, coalesce(sum(cost_micro_usd), 0) AS cost,
                           coalesce(sum(prompt_tokens), 0) AS prompt_tokens
                      FROM llm_calls
                     WHERE user_id = CAST(:user AS uuid) AND purpose = 'assistant'
                       AND started_at >= :start AND started_at <= :end
                    """
                ),
                {"user": result.user_id, "start": result.started_at, "end": result.finished_at},
            ).one()
            result.calls = int(row.calls)
            result.prompt_tokens = int(row.prompt_tokens)
            result.measured_micro_usd = int(row.cost)


def _usd(micro: float) -> str:
    return f"${micro / 1_000_000:.4f}"


def _summary(
    results: list[TurnResult],
    spend: Spend,
    *,
    model: str,
    judge: str | None,
    samples: int,
) -> str:
    by_case: dict[str, list[TurnResult]] = {}
    for result in results:
        by_case.setdefault(result.case, []).append(result)
    lines = [
        f"# Assistant eval - {model}",
        "",
        f"Run {datetime.now(UTC).isoformat(timespec='seconds')}; judge {judge or 'none'}; "
        f"{samples} sample(s) per case.",
        "",
    ]
    turns = len(results)
    mech = sum(r.mechanical_pass for r in results)
    judged = [r for r in results if r.judge is not None]
    judge_pass = sum(bool(r.judge and r.judge.get("pass")) for r in judged)
    both = sum(r.passed for r in results)
    lines += [
        "| | turns | share |",
        "|---|---:|---:|",
        f"| mechanical checks pass | {mech} / {turns} | {mech / max(turns, 1):.0%} |",
        f"| judge passes | {judge_pass} / {len(judged)} | {judge_pass / max(len(judged), 1):.0%} |",
        f"| both (a pass) | {both} / {turns} | {both / max(turns, 1):.0%} |",
        "",
    ]
    measured = [r for r in results if r.calls]
    costs = [r.measured_micro_usd or 0 for r in measured]
    seconds = [r.seconds for r in results]
    if costs:
        costs_sorted = sorted(costs)
        p90 = costs_sorted[min(len(costs_sorted) - 1, int(len(costs_sorted) * 0.9))]
        lines += [
            "## Cost per question (llm_calls, purpose = 'assistant')",
            "",
            f"- questions measured: {len(costs)}; calls: {sum(r.calls for r in measured)}",
            f"- mean {_usd(statistics.mean(costs))}, median {_usd(statistics.median(costs))}, "
            f"p90 {_usd(p90)}, max {_usd(max(costs))}",
            f"- prompt tokens per question, mean: "
            f"{statistics.mean(r.prompt_tokens for r in measured):.0f}",
            f"- seconds per question: median {statistics.median(seconds):.1f}, "
            f"max {max(seconds):.1f}",
            f"- spend this run: assistant {_usd(spend.assistant_micro_usd)}, judge "
            f"{_usd(spend.judge_micro_usd)}",
            "",
        ]
    if spend.stopped:
        lines += [f"**Stopped early:** {spend.stopped}", ""]
    groups: dict[str, list[TurnResult]] = {}
    for result in results:
        groups.setdefault(result.group, []).append(result)
    lines += ["## By group", "", "| group | pass | turns |", "|---|---:|---:|"]
    lines += [
        f"| {g} | {sum(r.passed for r in rs)} | {len(rs)} |" for g, rs in sorted(groups.items())
    ]
    lines += ["", "## To read: every failure, and every disagreement", ""]
    for case, rs in by_case.items():
        for r in rs:
            judge_ok = bool(r.judge and r.judge.get("pass"))
            if r.passed:
                continue
            kind = (
                "the judge could not grade it - read it"
                if r.judge and r.judge.get("error")
                else "both failed"
                if not r.mechanical_pass and not judge_ok
                else "judge failed it, checks passed"
                if r.mechanical_pass
                else "checks failed it, judge passed"
            )
            lines += [
                f"### {case} (sample {r.sample}, turn {r.turn}) - {kind}",
                "",
                f"**Q:** {r.question}",
                "",
                f"**Outcome:** {r.outcome}{f' ({r.reason})' if r.reason else ''}; "
                f"tools {r.tools or 'none'}; {r.steps} steps; {r.seconds}s; "
                f"{_usd(r.cost_micro_usd)}",
                "",
                *[f"- check `{c.name}`: {c.detail}" for c in r.checks if not c.passed],
                *([f"- problems: {r.problems}"] if r.problems else []),
                f"- judge: {r.judge.get('why') if r.judge else 'not judged'}",
                f"- expected: {r.behaviour}",
                "",
                "> " + r.text.replace("\n", "\n> "),
                "",
            ]
    return "\n".join(lines) + "\n"


def _read_cases(path: Path) -> list[dict[str, Any]]:
    return list(json.loads(path.read_text(encoding="utf-8"))["cases"])


def _write_report(out: Path, stem: str, summary: str, payload: dict[str, Any]) -> Path:
    out.mkdir(parents=True, exist_ok=True)
    (out / f"{stem}.md").write_text(summary, encoding="utf-8")
    (out / f"{stem}.json").write_text(json.dumps(payload, indent=1, default=str), "utf-8")
    return out / f"{stem}.md"


async def main_async(args: argparse.Namespace) -> int:
    cases = _read_cases(Path(args.cases_file))
    if args.cases:
        wanted = set(args.cases.split(","))
        cases = [c for c in cases if c["id"] in wanted]
        missing = wanted - {c["id"] for c in cases}
        if missing:
            print(f"no such case: {sorted(missing)}", file=sys.stderr)
            return 2
    if args.group:
        cases = [c for c in cases if c["group"] == args.group]

    database_url = disposable(args.database_url)
    engine = create_engine(
        database_url.replace("postgresql://", "postgresql+psycopg://", 1),
        future=True,
        pool_size=args.concurrency + 2,
    )
    if not args.reuse_database:
        await build_database(engine, database_url, datetime.now(UTC))
    settings = Settings(_env_file=args.env_file) if args.env_file else get_settings()  # type: ignore[call-arg]
    if not settings.openrouter_api_key:
        print("OPENROUTER_API_KEY is not set: the eval needs a real model", file=sys.stderr)
        return 2
    cap = Decimal(args.max_usd)
    redis = Redis.from_url(args.redis_url)
    await redis.flushdb()  # the run's own counter, in a database of its own
    llm = _llm(settings, args.model, redis, cap, engine)
    judge = None if args.no_judge else _llm(settings, args.judge, redis, cap, None)
    market = EvalMarket(settings.fixtures_dir)
    injections = Injections()
    injections.install({c["inject"]["tool"] for c in cases if c.get("inject")})
    spend = Spend()

    queue = [(case, sample) for sample in range(1, args.repeat + 1) for case in cases]
    results: list[TurnResult] = []
    semaphore = asyncio.Semaphore(args.concurrency)

    async def one(case: Mapping[str, Any], sample: int) -> None:
        async with semaphore:
            if spend.stopped:
                return
            if spend.total_micro_usd >= cap * 1_000_000:
                spend.stopped = f"the cap of ${cap} was reached"
                return
            turns = await run_case(
                case,
                sample,
                engine=engine,
                market=market,
                llm=llm,
                judge=judge,
                settings=settings,
                injections=injections,
                spend=spend,
            )
            refusal = refused(turns)
            if refusal is not None:
                # Every later case would fail the same way and grade the account,
                # not the model: this case is not counted, and the run stops.
                spend.stopped = spend.stopped or f"the provider refused the key: {refusal[:200]}"
                print(f"stopped: {spend.stopped}")
                return
            results.extend(turns)
            marks = "".join("." if t.passed else "F" for t in turns)
            print(f"{marks:<5} {case['id']} [{sample}]  {_usd(spend.total_micro_usd)} so far")

    await asyncio.gather(*(one(case, sample) for case, sample in queue))
    await redis.aclose()

    order = {(c["id"]): i for i, c in enumerate(cases)}
    results.sort(key=lambda r: (order[r.case], r.sample, r.turn))
    _measure(engine, results)
    summary = _summary(
        results,
        spend,
        model=args.model,
        judge=None if args.no_judge else args.judge,
        samples=args.repeat,
    )
    stem = f"assistant-{args.model.replace('/', '_')}-{datetime.now(UTC):%Y%m%dT%H%M%S}"
    report = _write_report(
        Path(args.out),
        stem,
        summary,
        {
            "model": args.model,
            "judge": None if args.no_judge else args.judge,
            "spend": asdict(spend),
            "turns": [
                {**asdict(r), "mechanical_pass": r.mechanical_pass, "passed": r.passed}
                for r in results
            ],
        },
    )
    print(summary.split("## By group")[0])
    print(f"report: {report}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the assistant eval on a real model.")
    parser.add_argument("--database-url", required=True, help="a disposable database (*_ci)")
    parser.add_argument("--model", required=True, help="an OpenRouter model id")
    parser.add_argument("--max-usd", required=True, help="stop once the run has spent this")
    parser.add_argument("--judge", default=DEFAULT_JUDGE)
    parser.add_argument("--no-judge", action="store_true", help="mechanical checks only")
    parser.add_argument("--cases-file", default=str(DEFAULT_CASES))
    parser.add_argument("--cases", default=None, help="comma-separated case ids")
    parser.add_argument("--group", default=None)
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--redis-url", default=DEFAULT_REDIS)
    parser.add_argument("--reuse-database", action="store_true")
    parser.add_argument(
        "--env-file",
        default=None,
        help="settings file for the key and the LLM options (a worktree has no .env of its own)",
    )
    parser.add_argument("--out", default=str(REPO_ROOT / "services" / "ai" / "eval-results"))
    return asyncio.run(main_async(parser.parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
