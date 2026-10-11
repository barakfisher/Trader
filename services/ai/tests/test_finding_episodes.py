"""States are said when they cross a band; one move is one observation (decision 132).

Measured on kind, 2026-10-09: SMR's single fall was written as "high drawdown"
seven times in ten days, because the dedupe key buckets a state by day. These
tests drive the scan day by day the way the orchestrator does - carrying the
keys it stored and the episodes it keeps - and count what reaches the feed.
"""

from __future__ import annotations

import importlib.util
from datetime import UTC, datetime, timedelta
from pathlib import Path

from app.analysis.episodes import STATE_KINDS, EpisodeBook, OpenEpisode
from app.analysis.findings import SEVERITY_ORDER, Finding
from app.analysis.pipeline import ScanSubject, run_portfolio_scan
from app.analysis.price_series import PricePoint
from app.analysis.thresholds import AnalysisThresholds

THRESHOLDS = AnalysisThresholds()
START = datetime(2026, 9, 1, 20, 0, tzinfo=UTC)
HIGH = 100_000
SUBJECT = ScanSubject(instrument_id="i1", symbol="SMR", value_minor=HIGH, currency="USD")
REF = "instrument:SMR"


class SeriesConnection:
    """Serves whatever prices the test has revealed so far."""

    def __init__(self) -> None:
        self.points: list[PricePoint] = []

    def execute(self, _statement, _parameters):
        return [
            type(
                "Row", (), {"as_of": p.as_of, "price_minor": p.price_minor, "currency": p.currency}
            )
            for p in self.points
        ]


class Orchestrator:
    """What `portfolioScan.ts` keeps between scans: stored keys and open episodes."""

    def __init__(self) -> None:
        self.keys: set[str] = set()
        self.episodes: dict[tuple[str, str], str] = {}
        self.written: list[Finding] = []

    async def scan(self, connection: SeriesConnection) -> None:
        observations, stats = await run_portfolio_scan(
            connection,
            [SUBJECT],
            {},
            base_currency="USD",
            thresholds=THRESHOLDS,
            llm=None,
            known_dedupe_keys=self.keys,
            open_episodes=[
                OpenEpisode(kind=kind, subject_ref=ref, severity=severity)
                for (kind, ref), severity in self.episodes.items()
            ],
            now=connection.points[-1].as_of,
        )
        for item in observations:
            self.keys.add(item.dedupe_key)
            self.written.append(item.finding)
            if item.finding.kind in STATE_KINDS:
                key = (item.finding.kind, item.finding.subject_ref)
                previous = self.episodes.get(key, "info")
                self.episodes[key] = max(previous, item.finding.severity, key=SEVERITY_ORDER.index)
        seen = {(entry["kind"], entry["subject_ref"]) for entry in stats.seen}
        for key in [key for key in self.episodes if key not in seen]:
            del self.episodes[key]

    def drawdowns(self) -> list[str]:
        return [finding.severity for finding in self.written if finding.kind == "drawdown"]


def _below_high_by(fraction: float) -> int:
    return round(HIGH * (1 - fraction))


def _flat_then(connection: SeriesConnection, closes: list[int]) -> list[int]:
    """Twenty days at the high, so the window has a high and enough points."""
    history = [HIGH] * 20
    connection.points = [
        PricePoint(as_of=START + timedelta(days=day), price_minor=price, currency="USD")
        for day, price in enumerate(history)
    ]
    return closes


async def _run_days(orchestrator: Orchestrator, connection: SeriesConnection, closes: list[int]):
    for close in closes:
        as_of = connection.points[-1].as_of + timedelta(days=1)
        connection.points.append(PricePoint(as_of=as_of, price_minor=close, currency="USD"))
        await orchestrator.scan(connection)


async def test_a_ten_day_drawdown_is_one_observation_per_band() -> None:
    bands = THRESHOLDS.drawdown
    margin = 0.01
    info, notable, high = (
        _below_high_by(bands.info + margin),
        _below_high_by(bands.notable + margin),
        _below_high_by(bands.high + margin),
    )
    # Ten trading days: into info, deeper into notable, high, then a partial
    # recovery back into notable - the episode has already said more than that.
    closes = [info, info, notable, notable, notable, high, high, high, notable, notable]
    connection = SeriesConnection()
    orchestrator = Orchestrator()

    await _run_days(orchestrator, connection, _flat_then(connection, closes))

    assert orchestrator.drawdowns() == ["info", "notable", "high"]


async def test_a_recovery_below_the_info_band_ends_the_episode() -> None:
    bands = THRESHOLDS.drawdown
    fallen = _below_high_by(bands.info + 0.01)
    recovered = _below_high_by(bands.info / 2)
    connection = SeriesConnection()
    orchestrator = Orchestrator()

    closes = [fallen, fallen, recovered, fallen, fallen]
    await _run_days(orchestrator, connection, _flat_then(connection, closes))

    # Entered, ended by the recovery, entered again: two episodes, two findings.
    assert orchestrator.drawdowns() == ["info", "info"]


async def test_a_state_the_episode_has_reached_is_counted_as_known_not_written() -> None:
    bands = THRESHOLDS.drawdown
    connection = SeriesConnection()
    closes = _flat_then(connection, [_below_high_by(bands.notable + 0.01)])
    connection.points.append(
        PricePoint(
            as_of=connection.points[-1].as_of + timedelta(days=1),
            price_minor=closes[0],
            currency="USD",
        )
    )

    observations, stats = await run_portfolio_scan(
        connection,
        [SUBJECT],
        {},
        base_currency="USD",
        thresholds=THRESHOLDS,
        llm=None,
        open_episodes=[OpenEpisode(kind="drawdown", subject_ref=REF, severity="high")],
        now=connection.points[-1].as_of,
    )

    assert "drawdown" not in [item.finding.kind for item in observations]
    assert stats.held_in_episode == 1
    # Still reported as seen: that is how the caller knows the episode continues.
    assert {"kind": "drawdown", "subject_ref": REF, "severity": "notable"} in stats.seen


def test_an_event_is_never_held_by_an_episode() -> None:
    book = EpisodeBook([OpenEpisode(kind="price_move", subject_ref=REF, severity="high")])
    finding = Finding(kind="price_move", severity="info", subject_ref=REF, as_of=START)
    assert not book.already_said(finding)


def _moves(connection: SeriesConnection, returns: list[float]) -> None:
    price = float(HIGH)
    connection.points = [PricePoint(as_of=START, price_minor=HIGH, currency="USD")]
    for day, change in enumerate(returns, start=1):
        price *= 1 + change
        connection.points.append(
            PricePoint(as_of=START + timedelta(days=day), price_minor=round(price), currency="USD")
        )


async def _kinds_found(connection: SeriesConnection) -> list[str]:
    _, stats = await run_portfolio_scan(
        connection,
        [SUBJECT],
        {},
        base_currency="USD",
        thresholds=THRESHOLDS,
        llm=None,
        now=connection.points[-1].as_of,
    )
    return [entry["kind"] for entry in stats.seen]


async def test_an_unusual_move_absorbs_the_price_move() -> None:
    # A quiet stock, then a move past the price rule's high band: both rules
    # would fire, and only the sigma rule - the one that knows the stock - speaks.
    quiet = THRESHOLDS.sigma_stdev_floor / 2
    jump = -(THRESHOLDS.price_move.high + 0.01)
    connection = SeriesConnection()
    _moves(connection, [quiet, -quiet] * 15 + [jump])

    kinds = await _kinds_found(connection)

    assert "sigma_move" in kinds
    assert "price_move" not in kinds


async def test_a_large_move_that_is_ordinary_for_the_stock_still_stands_alone() -> None:
    # A volatile stock whose usual day is bigger than the move: the z-score is
    # below its floor, so the sigma rule is silent - and the price move is kept
    # rather than merged away (the user, 2026-10-09: a 6% fall is never invisible).
    usual = THRESHOLDS.price_move.notable + 0.03
    move = -(THRESHOLDS.price_move.notable + 0.01)
    connection = SeriesConnection()
    _moves(connection, [usual, -usual] * 15 + [move])

    kinds = await _kinds_found(connection)

    assert "sigma_move" not in kinds
    assert "price_move" in kinds


def test_the_migration_and_the_scan_agree_on_which_kinds_are_states() -> None:
    path = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "0049_finding_episodes.py"
    spec = importlib.util.spec_from_file_location("migration_0049", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert frozenset(module.STATE_KINDS) == STATE_KINDS
