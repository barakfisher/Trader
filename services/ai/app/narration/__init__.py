"""Narration: turning deterministic findings into sentences, safely.

The evidence validator is the point of this package. Everything else exists to
make its verdict cheap to act on: templates so a rejection costs nothing, and
correlation so the model has real context rather than a reason to invent some.
"""

from app.narration.correlation import CandidateArticle, as_evidence, correlate
from app.narration.evidence_validator import is_supported, sourced_values, unsourced_figures
from app.narration.narrator import Narration, build_evidence, narrate
from app.narration.templates import concepts_for, explanation_for, headline_for

__all__ = [
    "CandidateArticle",
    "Narration",
    "as_evidence",
    "build_evidence",
    "concepts_for",
    "correlate",
    "explanation_for",
    "headline_for",
    "is_supported",
    "narrate",
    "sourced_values",
    "unsourced_figures",
]
