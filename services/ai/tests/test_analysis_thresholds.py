"""Thresholds are configuration, and the bridge from Settings has to hold.

Every Settings built here passes `_env_file=None`. A test that reads the
developer's `.env` passes on one machine and fails on another, and the green run
is the misleading one.
"""

import pytest

from app.analysis.thresholds import AnalysisThresholds
from app.config import Settings


def settings(**overrides) -> Settings:
    return Settings(_env_file=None, app_env="test", **overrides)


# -- the defaults agree with the shipped configuration ------------------------


def test_the_settings_defaults_reproduce_the_dataclass_defaults():
    # Two sets of defaults exist - the dataclass's, for a caller that constructs
    # thresholds directly, and Settings', for the wired service. They must be the
    # same numbers, or a rule would behave differently in a test than in a run.
    assert AnalysisThresholds.from_settings(settings()) == AnalysisThresholds()


def test_every_rule_reads_its_bands_from_settings():
    tuned = AnalysisThresholds.from_settings(
        settings(
            analysis_price_move_pct=0.02,
            analysis_price_move_notable_pct=0.04,
            analysis_price_move_high_pct=0.06,
            analysis_sigma_z=1.5,
            analysis_sigma_notable_z=2.5,
            analysis_sigma_high_z=3.5,
            analysis_drawdown_pct=0.08,
            analysis_drawdown_notable_pct=0.12,
            analysis_drawdown_high_pct=0.20,
            analysis_drift_pct=0.03,
            analysis_drift_notable_pct=0.06,
            analysis_drift_high_pct=0.09,
        )
    )
    assert (tuned.price_move.info, tuned.price_move.high) == (0.02, 0.06)
    assert (tuned.sigma_move.info, tuned.sigma_move.high) == (1.5, 3.5)
    assert (tuned.drawdown.info, tuned.drawdown.high) == (0.08, 0.20)
    assert (tuned.allocation_drift.info, tuned.allocation_drift.high) == (0.03, 0.09)


def test_windows_and_guards_come_from_settings_too():
    tuned = AnalysisThresholds.from_settings(
        settings(
            analysis_sigma_window_days=45,
            analysis_sigma_min_observations=15,
            analysis_sigma_min_move_pct=0.02,
            analysis_sigma_stdev_floor=0.005,
            analysis_drawdown_window_days=90,
            analysis_drawdown_min_observations=8,
            analysis_max_gap_days=4,
        )
    )
    assert tuned.sigma_window_days == 45
    assert tuned.sigma_min_observations == 15
    assert tuned.sigma_min_move == 0.02
    assert tuned.sigma_stdev_floor == 0.005
    assert tuned.drawdown_window_days == 90
    assert tuned.drawdown_min_observations == 8
    assert tuned.max_gap_days == 4


# -- bad configuration fails at construction ----------------------------------


def test_mis_ordered_bands_are_rejected_when_the_thresholds_are_built():
    # Boot time is the right place to find this. Emitted findings are not.
    with pytest.raises(ValueError, match="ascending"):
        AnalysisThresholds.from_settings(
            settings(analysis_price_move_pct=0.09, analysis_price_move_high_pct=0.08)
        )


@pytest.mark.parametrize(
    "overrides",
    [
        {"sigma_window_days": 0},
        {"drawdown_window_days": -1},
        {"sigma_min_observations": 1},
        {"drawdown_min_observations": 1},
        {"sigma_stdev_floor": 0.0},
        {"sigma_min_move": -0.01},
        {"max_gap_days": 0},
    ],
)
def test_impossible_windows_and_guards_are_rejected(overrides):
    with pytest.raises(ValueError):
        AnalysisThresholds(**overrides)


def test_thresholds_are_immutable():
    # A rule must not be able to retune the configuration it was handed.
    thresholds = AnalysisThresholds()
    with pytest.raises(AttributeError):
        thresholds.max_gap_days = 30
