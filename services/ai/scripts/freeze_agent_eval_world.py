"""Freeze the worlds of the agent-scan eval set (`data/eval/agent_scans.json`).

    PYTHONPATH=. .venv/bin/python scripts/freeze_agent_eval_world.py \\
        --env-file /path/to/.env [--worlds ID,ID] [--refetch]

For each world the set names, once:

1. **Keep the dump**: copy it from the backups, which rotate, into the eval's folder
   (`scripts/eval-world.sh keep`).
2. **Fetch the closes it lacks.** Production stores closes only for symbols an agent
   already asked about, so the movers of a world's newest briefings mostly have none
   (`frozen_market.py`). The world is restored, the symbols its cases' agents were
   last briefed on are read, and their daily closes up to the world's clock are
   fetched from the configured provider and written beside the dump.

**This is the one step of the eval that reads the network, and it is done once.**
A world whose closes file exists is skipped: fetching again would move a world that
runs were already compared on. `--refetch` says to do it anyway; a run made before
and a run made after are then not comparable. A close dated after the world's clock
is never written.

Free: it calls the market data provider, not a model.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

from redis.asyncio import Redis

from app.agents.tools import HOLIDAY_MARGIN_DAYS, MAX_HISTORY_DAYS
from app.analysis.backfill import is_final
from app.config import Settings, get_settings
from app.core.cache import Cache
from app.core.ratelimit import RateLimiter
from app.models import DailyClose
from app.providers.registry import MarketDataService, build_providers
from scripts.agent_eval.cases import (
    DEFAULT_CASES,
    DEFAULT_FROZEN_DIR,
    Case,
    World,
    read_cases,
)
from scripts.agent_eval.frozen_market import briefing_symbols, dump_closes, newest_briefing
from scripts.agent_eval.frozen_world import (
    DEFAULT_SERVER_URL,
    WorldError,
    connect,
    find_agent_id,
    keep,
    prepare,
)

#: The eval's own Redis (`scripts/eval-world.sh up`): the market service's cache and limiter.
DEFAULT_REDIS = "redis://127.0.0.1:56379/1"
#: How far under the provider's rate limit the fetch stays. The market service answers
#: a rate-limited call with no closes, exactly as it answers a symbol that has none:
#: the first real freeze wrote 26 of 33 symbols down as "without history" that way.
PACE = 0.5
#: Symbols that came back empty are asked once more after this long, so a limit that
#: was hit anyway is not written into a world as a fact about the symbol.
RETRY_AFTER_SECONDS = 65.0


def history_days(as_of: datetime, today: datetime) -> int:
    """Calendar days to ask a provider for, so the longest window a tool reads at the
    world's clock is covered: providers count back from today, not from the clock."""
    longest = MAX_HISTORY_DAYS * 7 // 5 + HOLIDAY_MARGIN_DAYS
    return longest + max(0, (today.date() - as_of.date()).days)


def world_symbols(world: World, cases: list[Case], server_url: str) -> list[str]:
    """Every symbol the world's case agents were last briefed on."""
    engine = connect(server_url, world.database)
    symbols: list[str] = []
    try:
        for case in cases:
            _user, agent_id = find_agent_id(engine, case.agent)
            briefing = newest_briefing(engine, agent_id, world.as_of)
            if briefing is None:
                raise WorldError(
                    f"case {case.id!r}: {case.agent!r} has no finished scan before"
                    f" {world.as_of.isoformat()}, so the world has no movers for it"
                )
            symbols += briefing_symbols(briefing)
    finally:
        engine.dispose()
    return list(dict.fromkeys(symbols))


def pause_seconds(limit_per_minute: int) -> float:
    """Seconds between two fetches that keep the run at `PACE` of the provider's limit."""
    return 60 / (limit_per_minute * PACE)


async def fetch_closes(
    market: MarketDataService,
    symbols: list[str],
    as_of: datetime,
    today: datetime,
    *,
    pause: float,
    retry_after: float = RETRY_AFTER_SECONDS,
) -> tuple[dict[str, list[DailyClose]], list[str]]:
    """Each symbol's final closes up to the world's clock, and the symbols with none
    after being asked twice."""
    closes: dict[str, list[DailyClose]] = {}

    async def ask(wanted: list[str]) -> list[str]:
        empty: list[str] = []
        for symbol in wanted:
            fetched = await market.history(symbol, history_days(as_of, today))
            final = sorted(
                (close for close in fetched if is_final(symbol, close.as_of, as_of)),
                key=lambda close: close.as_of,
            )
            if final:
                closes[symbol] = final
            else:
                empty.append(symbol)
            await asyncio.sleep(pause)
        return empty

    without = await ask(symbols)
    if without:
        await asyncio.sleep(retry_after)
        without = await ask(without)
    return closes, without


async def main_async(args: argparse.Namespace) -> int:
    cases = read_cases(Path(args.cases_file))
    frozen_dir = Path(args.frozen_dir)
    wanted = set(args.worlds.split(",")) if args.worlds else None
    worlds = {case.world.id: case.world for case in cases}
    if wanted is not None and (unknown := wanted - set(worlds)):
        print(f"no such world: {sorted(unknown)}", file=sys.stderr)
        return 2
    settings = Settings(_env_file=args.env_file) if args.env_file else get_settings()  # type: ignore[call-arg]
    redis = Redis.from_url(args.redis_url, decode_responses=True)
    market = MarketDataService(
        build_providers(settings), Cache(redis), RateLimiter(redis), settings
    )
    today = datetime.now(UTC)
    try:
        for world in worlds.values():
            if wanted is not None and world.id not in wanted:
                continue
            target = world.closes_file(frozen_dir)
            if target.is_file() and not args.refetch:
                print(f"{world.id}: already frozen ({target.name}); left as it is")
                continue
            keep(world, frozen_dir)
            prepare(world, frozen_dir, args.server_url)
            symbols = world_symbols(
                world, [case for case in cases if case.world.id == world.id], args.server_url
            )
            closes, without = await fetch_closes(
                market,
                symbols,
                world.as_of,
                today,
                pause=pause_seconds(settings.provider_rate_limit_per_minute),
            )
            target.write_text(
                json.dumps(
                    {
                        "world": world.id,
                        "dump": world.dump,
                        "as_of": world.as_of.isoformat(),
                        "fetched_at": today.isoformat(timespec="seconds"),
                        "providers": settings.market_data_chain,
                        "without_history": without,
                        "closes": dump_closes(closes),
                    },
                    indent=1,
                ),
                encoding="utf-8",
            )
            print(
                f"{world.id}: closes for {len(closes)} of {len(symbols)} symbols"
                f" -> {target}" + (f"; none for {without}" if without else "")
            )
    except WorldError as error:
        print(str(error), file=sys.stderr)
        return 1
    finally:
        await redis.aclose()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Freeze the agent-scan eval's worlds.")
    parser.add_argument("--cases-file", default=str(DEFAULT_CASES))
    parser.add_argument("--frozen-dir", default=str(DEFAULT_FROZEN_DIR))
    parser.add_argument("--server-url", default=DEFAULT_SERVER_URL)
    parser.add_argument("--redis-url", default=DEFAULT_REDIS)
    parser.add_argument("--worlds", default=None, help="comma-separated world ids")
    parser.add_argument(
        "--env-file",
        default=None,
        help="settings file naming the market data chain (a worktree has no .env of its own)",
    )
    parser.add_argument(
        "--refetch",
        action="store_true",
        help="fetch a frozen world's closes again; earlier runs stop being comparable",
    )
    return asyncio.run(main_async(parser.parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
