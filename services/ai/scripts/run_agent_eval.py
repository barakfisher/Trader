"""Run the agent-scan eval set (`data/eval/agent_scans.json`) on a real model.

    PYTHONPATH=. .venv/bin/python scripts/run_agent_eval.py \\
        --model google/gemini-3.5-flash-lite --max-usd 0.50 --env-file /path/to/.env \\
        [--side NAME] [--cases ID,ID] [--repeat N] [--concurrency N] [--out DIR]

Each case is one agent's scan in one frozen world (`scripts/agent_eval/`): the dump
restored, the clock set to the moment it was taken, and `run_scan` - the code
`POST /agents/{id}/scans` runs, its briefing, tools, checks and returns included -
asked on a copy of that world that is dropped afterwards.

**What a run compares is a commit.** The set is run on `main` and again on the
branch of a change, which is `main` plus that change and nothing else (D425). The
run records its commit and `--side`, a name for it; the default is the branch.

**Keyed only, never in CI.** A run costs money and varies run to run, so it reports
and gates nothing. `--repeat` defaults to three: one sample of a model says little.

**A spend cap, enforced twice**, as the assistant eval's is: `--max-usd` stops the
run between scans once the recorded spend reaches it, and is the spend guard's
daily cap for the run's own Redis counter. A model with no listed price is charged
at the pessimistic rate (`app/llm/pricing.py`), so the cap errs toward stopping.

**It writes to one server**, the eval's own Postgres (`scripts/eval-world.sh`), and
only to databases whose names end in `_ci`. It calls no orchestrator, so no
proposal is created and nothing is announced. A world's files missing stops the
run before the first model call, naming each file.

**`--briefings-only` costs nothing and needs no key.** It builds every case's
briefing twice, on two copies of its world, and says whether the two are the same
and how many of the briefing's symbols the world can price: the check that the
set is fixed, to run before a paid run and after freezing a world.

What it reads from each scan is `scripts/agent_eval/readings.py`. The judge and the
Langfuse experiment are the next PR's; this one writes the report to `--out`.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.agents.briefing import build_briefing
from app.agents.scan import run_scan
from app.agents.scan_log import ScanAgent, find_agent
from app.agents.tools import ToolContext, scan_context
from app.analysis.thresholds import AnalysisThresholds
from app.config import Settings, get_settings
from app.corpus.embedder_factory import build_embedder
from app.corpus.embeddings import BaseEmbedder
from app.corpus.vector_store import PgVectorStore
from app.llm.base import LLMProvider
from app.llm.call_log import DatabaseCallLog
from app.llm.factory import build_llm
from app.models import DailyClose
from app.providers.price_provenance import excluded_price_sources
from scripts.agent_eval.cases import (
    DEFAULT_CASES,
    DEFAULT_FROZEN_DIR,
    REPO_ROOT,
    Case,
    CaseFileError,
    missing_files,
    read_cases,
)
from scripts.agent_eval.frozen_market import (
    FrozenMarket,
    briefing_symbols,
    load_closes,
    movers_from_briefing,
    newest_briefing,
)
from scripts.agent_eval.frozen_world import (
    DEFAULT_SERVER_URL,
    LOOPBACK_HOSTS,
    WorldError,
    clone,
    earlier_theses,
    find_agent_id,
    local_server,
    prepare,
)
from scripts.agent_eval.readings import RETURN_KINDS, Readings, read_scan

#: The eval's own Redis (`scripts/eval-world.sh up`), not a stack's.
DEFAULT_REDIS = "redis://127.0.0.1:56379/1"
DEFAULT_REPEAT = 3
#: A provider refusing the key itself - spent, revoked or unpaid - rather than one request.
_REFUSED = re.compile(r"HTTP 40[123]\b")
_SLUG = re.compile(r"[^a-z0-9]+")


@dataclass
class Sample:
    case: str
    world: str
    agent: str
    sample: int
    seconds: float = 0.0
    #: sha256 of the briefing the scan was given: equal across a case's samples, or
    #: the world moved between them and the samples are not of one case.
    briefing_sha256: str | None = None
    readings: Readings | None = None
    #: Symbols the scan asked a price for that the frozen world could not give.
    unpriced: list[str] = field(default_factory=list)
    #: Why the scan could not be run at all; a scan that ran and failed has readings.
    error: str | None = None

    def as_json(self) -> dict[str, Any]:
        return {
            "case": self.case,
            "world": self.world,
            "agent": self.agent,
            "sample": self.sample,
            "seconds": self.seconds,
            "briefing_sha256": self.briefing_sha256,
            "unpriced": self.unpriced,
            "error": self.error,
            "readings": self.readings.as_json() if self.readings else None,
        }


@dataclass
class Spend:
    """What the run has spent, and why it stopped if it did."""

    cap_usd: Decimal
    micro_usd: int = 0
    stopped: str | None = None

    def may_start(self) -> bool:
        """Whether another scan may start: False once the run stopped or the recorded
        spend reached the cap, which it then says. Checked before each scan, so scans
        already running when the cap is reached finish: with `--concurrency` N the run
        can pass the cap by N - 1 scans, and the spend guard's own cap is the second wall."""
        if self.stopped:
            return False
        if self.micro_usd >= self.cap_usd * 1_000_000:
            self.stopped = f"the cap of ${self.cap_usd} was reached"
            return False
        return True


def run_counter(redis_url: str) -> Redis:
    """The run's own Redis database, which it empties first; raises `WorldError` for
    one that is not on this machine or is database 0, where a stack keeps its cache,
    its rate limits and its spend counters."""
    redis = Redis.from_url(redis_url)
    kwargs = redis.connection_pool.connection_kwargs
    if kwargs.get("host") not in LOOPBACK_HOSTS or not kwargs.get("db"):
        raise WorldError(
            "the run empties its Redis database first, so --redis-url must name a database"
            f" other than 0 on this machine; got host {kwargs.get('host')!r},"
            f" database {kwargs.get('db')!r}"
        )
    return redis


def clone_name(case_id: str, sample: int) -> str:
    return f"run_{_SLUG.sub('_', case_id.lower()).strip('_')}_{sample}_ci"


def digest(briefing: Any) -> str:
    canonical = json.dumps(
        briefing, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def briefing_digest(engine: Engine, scan_id: str) -> str:
    """The stored briefing's digest, read back as the scan row keeps it."""
    with engine.connect() as connection:
        briefing = connection.execute(
            text("SELECT briefing FROM agent_scans WHERE id = CAST(:id AS uuid)"), {"id": scan_id}
        ).scalar_one()
    return digest(briefing)


def world_context(
    case: Case,
    engine: Engine,
    *,
    closes: dict[str, list[DailyClose]],
    settings: Settings,
    embedder: BaseEmbedder,
) -> tuple[ScanAgent, FrozenMarket, ToolContext]:
    """The case's agent, its world's market and the tools' context at the world's clock."""
    user_id, agent_id = find_agent_id(engine, case.agent)
    agent = find_agent(engine, user_id, agent_id)
    assert agent is not None
    shown = newest_briefing(engine, agent_id, case.world.as_of)
    if shown is None:
        raise WorldError(f"{case.agent!r} has no finished scan in this world")
    market = FrozenMarket(
        engine, case.world.as_of, closes=closes, movers=movers_from_briefing(shown)
    )
    context = scan_context(
        engine=engine,
        market=market,  # type: ignore[arg-type] - duck-typed, as in the tools' tests
        embedder=embedder,
        vector_store=PgVectorStore(),
        thresholds=AnalysisThresholds.from_settings(settings),
        excluded_price_sources=excluded_price_sources(settings.market_data_chain),
        user_id=user_id,
        agent_id=agent_id,
        now=case.world.as_of,
        # No news fetch: `get_news` reads what the world had stored.
        news=None,
    )
    return agent, market, context


def _llm(
    settings: Settings, model: str, redis: Redis, cap_usd: Decimal, engine: Engine
) -> LLMProvider:
    """The configured gateway, pointed at `model`, recording into the scan's own copy
    of the world so the agent's daily allowance reads this scan's calls and no other's."""
    configured = settings.model_copy(
        update={"llm_provider": "openrouter", "llm_model": model, "llm_daily_budget_usd": cap_usd}
    )
    return build_llm(
        configured,
        redis,
        call_log=DatabaseCallLog(engine, configured.llm_call_retention_days),
    )


async def run_sample(
    case: Case,
    sample: int,
    *,
    server_url: str,
    closes: dict[str, list[DailyClose]],
    settings: Settings,
    embedder: BaseEmbedder,
    model: str,
    redis: Redis,
    cap_usd: Decimal,
) -> Sample:
    out = Sample(case=case.id, world=case.world.id, agent=case.agent, sample=sample)
    started = time.monotonic()
    try:
        with clone(case.world, server_url, clone_name(case.id, sample)) as engine:
            agent, market, context = world_context(
                case, engine, closes=closes, settings=settings, embedder=embedder
            )
            earlier = earlier_theses(engine, agent.agent_id)
            result = await run_scan(
                engine=engine,
                llm=_llm(settings, model, redis, cap_usd, engine),
                context=context,
                agent=agent,
                trigger="manual",
                movers=await market.movers(),
            )
            out.readings = read_scan(result, earlier)
            out.briefing_sha256 = briefing_digest(engine, result.scan_id)
            out.unpriced = list(dict.fromkeys(market.unpriced))
    except Exception as error:  # noqa: BLE001 - one case failing is recorded; the run goes on
        out.error = f"{type(error).__name__}: {error}"
    out.seconds = round(time.monotonic() - started, 1)
    return out


async def check_briefings(
    cases: list[Case],
    *,
    server_url: str,
    closes: dict[str, dict[str, list[DailyClose]]],
    settings: Settings,
    embedder: BaseEmbedder,
) -> bool:
    """Build each case's briefing on two copies of its world; print what was found.
    True when every case's two briefings are the same."""
    fixed = True
    for case in cases:
        digests: list[str] = []
        priced = named = 0
        for copy in (1, 2):
            with clone(case.world, server_url, clone_name(case.id, copy)) as engine:
                agent, market, context = world_context(
                    case, engine, closes=closes[case.world.id], settings=settings, embedder=embedder
                )
                briefing = await build_briefing(
                    context, await market.movers(), mandate=agent.mandate, topics=agent.topics
                )
                digests.append(digest(briefing))
                symbols = briefing_symbols(briefing)
                quotes, _missing = await market.quotes(symbols) if symbols else ([], [])
                priced, named = len(quotes), len(symbols)
        same = digests[0] == digests[1]
        fixed = fixed and same
        print(
            f"{case.id}: {'one briefing' if same else 'TWO DIFFERENT BRIEFINGS'}"
            f" ({digests[0][:12]}); {priced} of {named} of its symbols priced"
        )
    return fixed


def refused_key(sample: Sample) -> str | None:
    """What the provider said when it refused the key itself, if it did."""
    said = [sample.error or "", (sample.readings.error if sample.readings else None) or ""]
    return next((words for words in said if _REFUSED.search(words)), None)


# -- the report -----------------------------------------------------------------------


def _usd(micro: float) -> str:
    return f"${micro / 1_000_000:.4f}"


def _share(count: int, total: int) -> str:
    return f"{count} / {total}"


def summary(
    samples: list[Sample],
    spend: Spend,
    *,
    model: str,
    side: str,
    commit: str,
    repeat: int,
) -> str:
    ran = [s for s in samples if s.readings is not None]
    readings = [s.readings for s in ran if s.readings is not None]
    passes = [r for r in readings if r.outcome == "no_trade"]
    lines = [
        f"# Agent-scan eval - {side} - {model}",
        "",
        f"Run {datetime.now(UTC).isoformat(timespec='seconds')}; commit `{commit}`;"
        f" {repeat} sample(s) per case; {len(ran)} of {len(samples)} scans ran;"
        f" spend {_usd(spend.micro_usd)}.",
        "",
    ]
    if spend.stopped:
        lines += [f"**Stopped early:** {spend.stopped}", ""]
    lines += [
        "| reading | scans |",
        "|---|---:|",
        "| decided a trade | "
        f"{_share(sum(r.outcome == 'trade' for r in readings), len(readings))} |",
        f"| passed (no trade) | {_share(len(passes), len(readings))} |",
        "| passed without a tool call | "
        f"{_share(sum(r.passed_without_tools for r in readings), len(passes))} of the passes |",
        "| passed, idle cash not addressed | "
        f"{_share(sum(r.cash_unjustified for r in readings), len(passes))} of the passes |",
        "| a sentence repeated word for word from an earlier thesis | "
        f"{_share(sum(bool(r.repeated_sentences) for r in readings), len(readings))} |",
        *[
            f"| sent back for {kind.replace('_', ' ')} | "
            f"{_share(sum(r.returned[kind] > 0 for r in readings), len(readings))} |"
            for kind in RETURN_KINDS
        ],
        f"| ended invalid_answer | "
        f"{_share(sum(r.outcome == 'invalid_answer' for r in readings), len(readings))} |",
        f"| ended rule_rejected | "
        f"{_share(sum(r.outcome == 'rule_rejected' for r in readings), len(readings))} |",
        "| asked a price the frozen world lacks | "
        f"{_share(sum(bool(s.unpriced) for s in ran), len(ran))} |",
        "",
        "**What this cannot show.** A share of "
        f"{len(readings)} scans moves by {100 / max(len(readings), 1):.0f} points when one scan"
        " changes, and the samples of a case are not independent. Whether a thesis says what"
        " would prove it wrong, and a reason repeated in other words, are not read here.",
        "",
        "## By case",
        "",
        "| case | sample | outcome | tools | sent back | repeated | trades | cost | one briefing |",
        "|---|---:|---|---:|---|---:|---|---:|---|",
    ]
    digests: dict[str, set[str]] = {}
    for s in ran:
        digests.setdefault(s.case, set()).add(s.briefing_sha256 or "")
    for s in samples:
        r = s.readings
        if r is None:
            lines.append(f"| {s.case} | {s.sample} | **not run**: {s.error} | | | | | | |")
            continue
        back = ", ".join(f"{kind} {n}" for kind, n in r.returned.items() if n) or "-"
        same = "yes" if len(digests[s.case]) == 1 else "**NO**"
        lines.append(
            f"| {s.case} | {s.sample} | {r.outcome} | {len(r.tools)} | {back} |"
            f" {len(r.repeated_sentences)} | {', '.join(r.trades) or '-'} |"
            f" {_usd(r.cost_micro_usd)} | {same} |"
        )
    moved = sorted(case for case, seen in digests.items() if len(seen) > 1)
    if moved:
        lines += [
            "",
            f"**The world moved between samples of {moved}:** their briefings differ, so"
            " they are not samples of one case. Find out why before reading this run.",
        ]
    lines += ["", "## Every thesis", ""]
    for s in ran:
        r = s.readings
        assert r is not None
        lines += [
            f"### {s.case} (sample {s.sample}) - {r.outcome}",
            "",
            f"Tools: {', '.join(r.tools) or 'none'}; {r.steps} steps; {s.seconds}s."
            + (f" Unpriced: {', '.join(s.unpriced)}." if s.unpriced else "")
            + (f" Error: {r.error}." if r.error else ""),
            "",
            *[f"- repeated: {sentence}" for sentence in r.repeated_sentences],
            *([f"- refused: {r.refused}"] if r.refused else []),
            "",
            "> " + (r.thesis or "(no thesis)").replace("\n", "\n> "),
            "",
        ]
    return "\n".join(lines) + "\n"


def write_report(out: Path, stem: str, report: str, payload: dict[str, Any]) -> Path:
    out.mkdir(parents=True, exist_ok=True)
    (out / f"{stem}.md").write_text(report, encoding="utf-8")
    (out / f"{stem}.json").write_text(
        json.dumps(payload, indent=1, ensure_ascii=False, default=str), encoding="utf-8"
    )
    return out / f"{stem}.md"


def current_commit() -> tuple[str, str]:
    """This checkout's commit, marked when it has uncommitted changes, and its branch."""

    def git(*args: str) -> str:
        result = subprocess.run(
            ["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, check=False
        )
        return result.stdout.strip()

    commit = git("rev-parse", "--short=7", "HEAD") or "unknown"
    if git("status", "--porcelain"):
        commit += "-dirty"
    return commit, git("rev-parse", "--abbrev-ref", "HEAD") or "unknown"


# -- the run --------------------------------------------------------------------------


async def main_async(args: argparse.Namespace) -> int:
    try:
        cases = read_cases(Path(args.cases_file))
    except CaseFileError as error:
        print(f"the case file cannot be run: {error}", file=sys.stderr)
        return 2
    if args.cases:
        wanted = set(args.cases.split(","))
        missing_ids = wanted - {case.id for case in cases}
        if missing_ids:
            print(f"no such case: {sorted(missing_ids)}", file=sys.stderr)
            return 2
        cases = [case for case in cases if case.id in wanted]

    frozen_dir: Path = args.frozen_dir
    if absent := missing_files(cases, frozen_dir):
        print("the frozen worlds are incomplete; nothing was run. Missing:", file=sys.stderr)
        for path in absent:
            print(f"  {path}", file=sys.stderr)
        print("Freeze them with scripts/freeze_agent_eval_world.py.", file=sys.stderr)
        return 2

    settings = Settings(_env_file=args.env_file) if args.env_file else get_settings()  # type: ignore[call-arg]
    if not args.briefings_only and not settings.openrouter_api_key:
        print("OPENROUTER_API_KEY is not set: the eval needs a real model", file=sys.stderr)
        return 2
    if not args.briefings_only and (args.max_usd is None or args.model is None):
        print("--model and --max-usd are required for a run that calls a model", file=sys.stderr)
        return 2
    commit, branch = current_commit()
    side = args.side or branch

    worlds = {case.world.id: case.world for case in cases}
    closes: dict[str, dict[str, list[DailyClose]]] = {}
    try:
        local_server(args.server_url)
        for world in worlds.values():
            print(f"preparing world {world.id} ({world.dump})")
            prepare(world, frozen_dir, args.server_url)
            closes[world.id] = load_closes(world.closes_file(frozen_dir))
    except WorldError as error:
        print(f"{error}\nnothing was run.", file=sys.stderr)
        return 1

    embedder = build_embedder(settings)
    if args.briefings_only:
        try:
            fixed = await check_briefings(
                cases,
                server_url=args.server_url,
                closes=closes,
                settings=settings,
                embedder=embedder,
            )
        except WorldError as error:
            print(str(error), file=sys.stderr)
            return 1
        print("the set is fixed" if fixed else "THE SET IS NOT FIXED: do not compare runs on it")
        return 0 if fixed else 1

    try:
        cap = Decimal(args.max_usd)
        redis = run_counter(args.redis_url)
    except InvalidOperation:
        print(f"--max-usd {args.max_usd!r} is not an amount", file=sys.stderr)
        return 2
    except WorldError as error:
        print(f"{error}\nnothing was run.", file=sys.stderr)
        return 2
    await redis.flushdb()  # the run's own counter, in a database of its own
    spend = Spend(cap_usd=cap)
    samples: list[Sample] = []
    semaphore = asyncio.Semaphore(args.concurrency)

    async def one(case: Case, sample: int) -> None:
        async with semaphore:
            if not spend.may_start():
                return
            done = await run_sample(
                case,
                sample,
                server_url=args.server_url,
                closes=closes[case.world.id],
                settings=settings,
                embedder=embedder,
                model=args.model,
                redis=redis,
                cap_usd=cap,
            )
            if (refusal := refused_key(done)) is not None:
                # Every later scan would fail the same way and grade the account, not
                # the model: this one is not counted, and the run stops.
                spend.stopped = spend.stopped or f"the provider refused the key: {refusal[:200]}"
                print(f"stopped: {spend.stopped}")
                return
            samples.append(done)
            if done.readings is not None:
                spend.micro_usd += done.readings.cost_micro_usd
            mark = done.readings.outcome if done.readings else f"not run ({done.error})"
            print(f"{case.id} [{sample}] {mark}  {_usd(spend.micro_usd)} so far")

    await asyncio.gather(
        *(one(case, sample) for sample in range(1, args.repeat + 1) for case in cases)
    )
    await redis.aclose()

    order = {case.id: index for index, case in enumerate(cases)}
    samples.sort(key=lambda s: (order[s.case], s.sample))
    report = summary(samples, spend, model=args.model, side=side, commit=commit, repeat=args.repeat)
    stem = (
        f"agent-scans-{_SLUG.sub('-', side.lower()).strip('-')}-"
        f"{args.model.replace('/', '_')}-{datetime.now(UTC):%Y%m%dT%H%M%S}"
    )
    written = write_report(
        Path(args.out),
        stem,
        report,
        {
            "model": args.model,
            "side": side,
            "commit": commit,
            "repeat": args.repeat,
            "spend_micro_usd": spend.micro_usd,
            "stopped": spend.stopped,
            "samples": [s.as_json() for s in samples],
        },
    )
    print(report.split("## By case")[0])
    print(f"report: {written}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the agent-scan eval on a real model.")
    parser.add_argument("--model", default=None, help="an OpenRouter model id")
    parser.add_argument("--max-usd", default=None, help="stop once the run has spent this")
    parser.add_argument(
        "--briefings-only",
        action="store_true",
        help="call no model: build every briefing twice and say whether the set is fixed",
    )
    parser.add_argument("--side", default=None, help="a name for what is run; default: the branch")
    parser.add_argument("--cases-file", default=str(DEFAULT_CASES))
    parser.add_argument("--cases", default=None, help="comma-separated case ids")
    parser.add_argument("--repeat", type=int, default=DEFAULT_REPEAT)
    parser.add_argument("--concurrency", type=int, default=2)
    parser.add_argument("--frozen-dir", default=str(DEFAULT_FROZEN_DIR))
    parser.add_argument("--server-url", default=DEFAULT_SERVER_URL)
    parser.add_argument("--redis-url", default=DEFAULT_REDIS)
    parser.add_argument(
        "--env-file",
        default=None,
        help="settings file for the key and the embedder (a worktree has no .env of its own)",
    )
    parser.add_argument("--out", default=str(REPO_ROOT / "services" / "ai" / "eval-results"))
    args = parser.parse_args()
    args.frozen_dir = Path(args.frozen_dir).resolve()
    if args.frozen_dir.is_relative_to(REPO_ROOT):
        print(
            f"--frozen-dir {args.frozen_dir} is inside the repository: a dump holds every row"
            " of the database and must never be one `git add .` away from a commit",
            file=sys.stderr,
        )
        return 2
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    raise SystemExit(main())
