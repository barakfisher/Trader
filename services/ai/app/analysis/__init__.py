"""The deterministic half of the analysis pipeline (DESIGN.md section 5, step 3).

Four rules turn price history and portfolio state into `Finding` objects with
exact numbers attached. No LLM, no news, no HTTP: the narration, correlation and
persistence steps consume what this package produces, and every figure they are
allowed to state has to appear in a finding's `evidence`.

The layering is strict and worth stating once:

  * `price_series` owns the arithmetic, `findings` owns the output shape and the
    severity ladder, `thresholds` owns every tunable number;
  * the four rule modules are pure functions of (data, thresholds) - no clock, no
    database, no configuration lookup;
  * `quote_history` is the only module here that knows SQL exists.
"""

from app.analysis.allocation_drift import PositionValue, allocation_drift_findings
from app.analysis.drawdown import drawdown_findings
from app.analysis.findings import (
    SEVERITY_ORDER,
    Finding,
    FindingKind,
    Severity,
    SeverityBands,
    cap_severity,
    severity_for,
)
from app.analysis.price_move import price_move_findings
from app.analysis.price_series import PricePoint, Step
from app.analysis.sigma_move import sigma_move_findings
from app.analysis.thresholds import AnalysisThresholds

__all__ = [
    "SEVERITY_ORDER",
    "AnalysisThresholds",
    "Finding",
    "FindingKind",
    "PositionValue",
    "PricePoint",
    "Severity",
    "SeverityBands",
    "Step",
    "allocation_drift_findings",
    "cap_severity",
    "drawdown_findings",
    "price_move_findings",
    "severity_for",
    "sigma_move_findings",
]
