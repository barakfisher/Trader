"""The market line on a move finding (decision 149).

The holding is built as a multiple of one benchmark's daily returns, so which
benchmark fits best is known by construction rather than by statistics luck.
Thresholds are read from `THRESHOLDS`, never restated as numbers.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.analysis.findings import Finding
from app.analysis.market_context import Benchmark, with_market_context
from app.analysis.pipeline import ScanBenchmark, ScanSubject, run_portfolio_scan
from app.analysis.price_move import price_move_findings
from app.analysis.price_series import PricePoint
from app.analysis.thresholds import AnalysisThresholds

THRESHOLDS = AnalysisThresholds()
START = datetime(2026, 6, 1, 20, 0, tzinfo=UTC)
DAYS = THRESHOLDS.market_fit_min_observations + 20

#: A deterministic, irregular return pattern - an index's ordinary days.
PATTERN = [0.004, -0.006, 0.002, 0.007, -0.003, -0.005, 0.006, 0.001, -0.002, 0.003, -0.007]
#: Uncorrelated with PATTERN by construction: a different period and phase.
OTHER = [0.003, 0.003, -0.004, -0.002, 0.005, -0.005, 0.0]


def series(returns: list[float], start_minor: int = 100_000) -> list[PricePoint]:
    prices = [start_minor]
    for ratio in returns:
        prices.append(round(prices[-1] * (1 + ratio)))
    return [
        PricePoint(START + timedelta(days=index), price, "USD")
        for index, price in enumerate(prices)
    ]


def history(pattern: list[float], today: float) -> list[float]:
    return [pattern[index % len(pattern)] for index in range(DAYS)] + [today]


def benchmark(
    symbol: str, returns: list[float], *, continuous: bool = False, instrument_id: str | None = None
) -> Benchmark:
    return Benchmark(
        instrument_id=instrument_id or f"id-{symbol}",
        symbol=symbol,
        points=series(returns),
        continuous=continuous,
    )


def move(points: list[PricePoint], symbol: str = "OUST") -> Finding:
    (finding,) = price_move_findings(symbol, points, THRESHOLDS)
    return finding


MARKET_DOWN = -2 * THRESHOLDS.market_frame_min_move
HOLDING = series([3 * ratio for ratio in history(PATTERN, MARKET_DOWN)])
QQQ = benchmark("QQQ", history(PATTERN, MARKET_DOWN))
SPY = benchmark("SPY", history(OTHER, MARKET_DOWN))


def frame(finding: Finding, benchmarks: list[Benchmark], **kwargs) -> Finding:
    options = {"instrument_id": "id-OUST", "points": HOLDING, "continuous": False} | kwargs
    return with_market_context(
        finding,
        options["instrument_id"],
        options["points"],
        benchmarks,
        THRESHOLDS,
        continuous=options["continuous"],
    )


# -- the market line ---------------------------------------------------------


def test_a_move_with_the_market_names_the_best_fitting_benchmark():
    finding = move(HOLDING)
    framed = frame(finding, [SPY, QQQ])

    market = framed.evidence["market"]
    assert market["symbol"] == "QQQ"
    assert market["change_pct"] == pytest.approx(MARKET_DOWN, abs=1e-4)
    assert market["as_of"] == QQQ.points[-1].as_of.isoformat()
    assert market["previous_as_of"] == QQQ.points[-2].as_of.isoformat()
    assert market["r_squared"] == pytest.approx(1.0, abs=1e-3)
    assert market["fit_observations"] >= THRESHOLDS.market_fit_min_observations
    assert market["fit_window_days"] == THRESHOLDS.market_fit_window_days
    assert market["min_move_pct"] == THRESHOLDS.market_frame_min_move


def test_the_line_adds_evidence_and_changes_nothing_else():
    finding = move(HOLDING)
    framed = frame(finding, [QQQ])

    assert (framed.kind, framed.severity, framed.subject_ref, framed.as_of) == (
        finding.kind,
        finding.severity,
        finding.subject_ref,
        finding.as_of,
    )
    assert {k: v for k, v in framed.evidence.items() if k != "market"} == finding.evidence


# -- when nothing is said ----------------------------------------------------


def test_a_quiet_market_is_not_mentioned():
    quiet = THRESHOLDS.market_frame_min_move / 2
    holding = series([3 * r for r in history(PATTERN, -0.05)])
    index = benchmark("QQQ", history(PATTERN, -quiet))
    assert "market" not in frame(move(holding), [index], points=holding).evidence


def test_a_market_moving_the_other_way_is_not_mentioned():
    holding = series([3 * r for r in history(PATTERN, -0.05)])
    index = benchmark("QQQ", history(PATTERN, -MARKET_DOWN))
    assert "market" not in frame(move(holding), [index], points=holding).evidence


def test_a_benchmark_not_priced_on_the_same_days_is_not_used():
    # Today's close is missing: yesterday's move would be a different day's market.
    stale = Benchmark("id-QQQ", "QQQ", QQQ.points[:-1], continuous=False)
    assert "market" not in frame(move(HOLDING), [stale]).evidence


def test_too_short_a_shared_history_chooses_nothing():
    short = THRESHOLDS.market_fit_min_observations - 2
    holding = series([3 * r for r in history(PATTERN, MARKET_DOWN)[-short:]])
    index = benchmark("QQQ", history(PATTERN, MARKET_DOWN)[-short:])
    assert "market" not in frame(move(holding), [index], points=holding).evidence


def test_a_benchmark_is_never_its_own_benchmark():
    itself = benchmark("QQQ", history(PATTERN, MARKET_DOWN), instrument_id="id-OUST")
    assert "market" not in frame(move(HOLDING), [itself]).evidence


def test_a_crypto_holding_is_set_beside_crypto_only_and_an_equity_beside_equities_only():
    bitcoin = benchmark("BTC-USD", history(PATTERN, MARKET_DOWN), continuous=True)

    equity = frame(move(HOLDING), [bitcoin, SPY])
    assert equity.evidence["market"]["symbol"] == "SPY"

    coin = frame(move(HOLDING, "ETH-USD"), [QQQ, bitcoin], continuous=True)
    assert coin.evidence["market"]["symbol"] == "BTC-USD"


def test_a_drawdown_is_never_framed():
    drawdown = Finding(
        kind="drawdown",
        severity="info",
        subject_ref="instrument:OUST",
        as_of=HOLDING[-1].as_of,
        evidence={"drawdown_pct": -0.12},
    )
    assert frame(drawdown, [QQQ]) is drawdown


# -- through the scan ----------------------------------------------------------


class SeriesByInstrument:
    """Serves each instrument's history by id, so the pipeline needs no database."""

    def __init__(self, by_id: dict[str, list[PricePoint]]) -> None:
        self._by_id = by_id

    def execute(self, _statement, parameters):
        return [
            type(
                "Row", (), {"as_of": p.as_of, "price_minor": p.price_minor, "currency": p.currency}
            )
            for p in self._by_id[parameters["instrument_id"]]
        ]


async def test_the_scan_frames_a_holdings_move_with_the_benchmarks_it_is_given():
    connection = SeriesByInstrument(
        {"id-OUST": HOLDING, "id-QQQ": QQQ.points, "id-SPY": SPY.points}
    )
    observations, _ = await run_portfolio_scan(
        connection,
        [ScanSubject(instrument_id="id-OUST", symbol="OUST", value_minor=None, currency="USD")],
        {},
        base_currency="USD",
        thresholds=THRESHOLDS,
        llm=None,
        now=HOLDING[-1].as_of + timedelta(hours=1),
        benchmarks=[ScanBenchmark("id-SPY", "SPY"), ScanBenchmark("id-QQQ", "QQQ")],
    )

    moves = [o for o in observations if o.finding.kind in {"price_move", "sigma_move"}]
    assert moves, "the fixture must produce a move"
    assert all(o.finding.evidence["market"]["symbol"] == "QQQ" for o in moves)
    others = [o for o in observations if o not in moves]
    assert all("market" not in o.finding.evidence for o in others)


async def test_a_scan_without_benchmarks_says_nothing_about_the_market():
    connection = SeriesByInstrument({"id-OUST": HOLDING})
    observations, _ = await run_portfolio_scan(
        connection,
        [ScanSubject(instrument_id="id-OUST", symbol="OUST", value_minor=None, currency="USD")],
        {},
        base_currency="USD",
        thresholds=THRESHOLDS,
        llm=None,
        now=HOLDING[-1].as_of + timedelta(hours=1),
    )
    assert observations
    assert all("market" not in o.finding.evidence for o in observations)
