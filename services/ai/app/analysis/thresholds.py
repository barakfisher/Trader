"""Every tunable number the rule layer uses, in one validated object.

A threshold is configuration, not a constant: the same code has to serve someone
who wants to hear about every 2% move and someone who only wants shocks. So the
rules take an `AnalysisThresholds` and hold no numbers of their own, and the
defaults live here where they can be read side by side.

The defaults are deliberately unexciting, and chosen against the demo portfolio:
a 3% daily move is roughly where a single-name equity stops being noise, a 2σ
move is the conventional "unusual" line, a 10% drawdown is the point at which a
holding's story has changed, and five percentage points of allocation drift is
about where rebalancing starts to be worth a transaction. They are starting
points for an operator to tune, not findings about markets.

`from_settings` is the only bridge to `app.config`, so the rules themselves stay
importable and testable with nothing but this dataclass.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.analysis.findings import SeverityBands
from app.analysis.price_series import DEFAULT_MAX_GAP_DAYS


def _price_move_bands() -> SeverityBands:
    return SeverityBands(info=0.03, notable=0.05, high=0.08)


def _sigma_bands() -> SeverityBands:
    return SeverityBands(info=2.0, notable=3.0, high=4.0)


def _drawdown_bands() -> SeverityBands:
    return SeverityBands(info=0.10, notable=0.15, high=0.25)


def _drift_bands() -> SeverityBands:
    return SeverityBands(info=0.05, notable=0.10, high=0.15)


@dataclass(frozen=True, slots=True)
class AnalysisThresholds:
    """Thresholds and windows for the four deterministic rules.

    Fractions throughout, never percentages: `0.03` is 3%. Allocation drift is a
    difference between two weights, so its bands are in the same units - `0.05`
    is five percentage points of weight, not 5% of the target.
    """

    price_move: SeverityBands = field(default_factory=_price_move_bands)

    sigma_move: SeverityBands = field(default_factory=_sigma_bands)
    #: Calendar days of history the z-score's sample is drawn from. Thirty days
    #: is about twenty-one trading days: long enough for a usable estimate, short
    #: enough that it describes the instrument's *current* regime rather than last
    #: quarter's.
    sigma_window_days: int = 30
    #: Returns required in that window before a z-score is computed at all. Below
    #: ten, the standard deviation is an opinion rather than an estimate, and the
    #: rule emits nothing instead of a confident-looking number.
    sigma_min_observations: int = 10
    #: A z-score is only reported for a move at least this large. Without it, a
    #: near-flat instrument generates "4σ" findings from a 0.3% wiggle: true
    #: arithmetic, worthless observation.
    sigma_min_move: float = 0.01
    #: Floor on the daily-return standard deviation used as the denominator. A
    #: quarter of a percent a day is quiet even for a money-market-like holding,
    #: and dividing by anything smaller turns rounding into a z-score.
    sigma_stdev_floor: float = 0.0025

    drawdown: SeverityBands = field(default_factory=_drawdown_bands)
    #: Lookback for "the trailing high". Thirty days makes this a local-high
    #: measure, matching FR-6's "drawdown from local high", not an all-time high.
    drawdown_window_days: int = 30
    #: Points required inside that window. With fewer, the "high" is likely just
    #: the first price we happen to hold.
    drawdown_min_observations: int = 5

    allocation_drift: SeverityBands = field(default_factory=_drift_bands)

    #: Widest calendar gap a step may span and still be called a daily move.
    max_gap_days: float = DEFAULT_MAX_GAP_DAYS

    def __post_init__(self) -> None:
        if self.sigma_window_days <= 0 or self.drawdown_window_days <= 0:
            raise ValueError("analysis windows must be positive")
        if self.sigma_min_observations < 2:
            raise ValueError("a standard deviation needs at least two observations")
        if self.drawdown_min_observations < 2:
            raise ValueError("a drawdown needs at least two observations")
        if self.sigma_stdev_floor <= 0:
            raise ValueError("the standard deviation floor must be positive")
        if self.sigma_min_move < 0:
            raise ValueError("the minimum sigma move must not be negative")
        if self.max_gap_days <= 0:
            raise ValueError("max_gap_days must be positive")

    @classmethod
    def from_settings(cls, settings: object) -> AnalysisThresholds:
        """Build from a `Settings` instance.

        Typed as `object` on purpose: the rule layer must not import the FastAPI
        settings module, or a unit test of a pure function would start depending
        on configuration loading. Attribute access is enough of a contract, and a
        renamed setting fails loudly here.
        """

        def get(name: str) -> float | int:
            return getattr(settings, name)

        return cls(
            price_move=SeverityBands(
                info=get("analysis_price_move_pct"),
                notable=get("analysis_price_move_notable_pct"),
                high=get("analysis_price_move_high_pct"),
            ),
            sigma_move=SeverityBands(
                info=get("analysis_sigma_z"),
                notable=get("analysis_sigma_notable_z"),
                high=get("analysis_sigma_high_z"),
            ),
            sigma_window_days=get("analysis_sigma_window_days"),
            sigma_min_observations=get("analysis_sigma_min_observations"),
            sigma_min_move=get("analysis_sigma_min_move_pct"),
            sigma_stdev_floor=get("analysis_sigma_stdev_floor"),
            drawdown=SeverityBands(
                info=get("analysis_drawdown_pct"),
                notable=get("analysis_drawdown_notable_pct"),
                high=get("analysis_drawdown_high_pct"),
            ),
            drawdown_window_days=get("analysis_drawdown_window_days"),
            drawdown_min_observations=get("analysis_drawdown_min_observations"),
            allocation_drift=SeverityBands(
                info=get("analysis_drift_pct"),
                notable=get("analysis_drift_notable_pct"),
                high=get("analysis_drift_high_pct"),
            ),
            max_gap_days=get("analysis_max_gap_days"),
        )
