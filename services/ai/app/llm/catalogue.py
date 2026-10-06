"""The models the Admin page offers (D43).

A short list, not OpenRouter's whole catalogue: every model here was read from
OpenRouter's model list (2026-10-06, docs/PROPOSAL-MULTI-AGENT.md §14.1) for its
price and whether it accepts tools, and each must also have a price in
`pricing.py` or `LLM_MODEL_PRICES` to be offered at all. A model without one
would be charged the pessimistic unknown-model rate, and the daily budget would
empty for a reason nobody could see - the failure D43 rejected free text for.

An agent's scan calls tools (D15), so the agents' list holds only models that
accept them, and never a free route: §11 measured the free route's rationale
rejected 70% of the time, which is an agent that almost never proposes.

Ids are OpenRouter's. The list applies only when `LLM_PROVIDER=openrouter`; with
another provider the configured model is used and nothing can be chosen.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from app.llm.pricing import ModelPrice, is_declared_free, price_for

#: What a choice is for: `explain` is narration and `/ask`, `agent` an agent's scan.
Scope = Literal["explain", "agent"]
SCOPES: tuple[Scope, ...] = ("explain", "agent")


@dataclass(frozen=True)
class CatalogueModel:
    id: str
    label: str
    supports_tools: bool


#: Ordered as the picker shows them: the recommended default first (D43).
CATALOGUE: tuple[CatalogueModel, ...] = (
    CatalogueModel("anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5", supports_tools=True),
    CatalogueModel("anthropic/claude-opus-5.5", "Claude Opus 5.5", supports_tools=True),
    CatalogueModel("anthropic/claude-haiku-4.5", "Claude Haiku 4.5", supports_tools=True),
    CatalogueModel("google/gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite", supports_tools=True),
    CatalogueModel(
        "nvidia/nemotron-3.5-lightning:free", "Nemotron 3.5 Lightning (free)", supports_tools=True
    ),
)


@dataclass(frozen=True)
class OfferedModel:
    model: CatalogueModel
    price: ModelPrice
    scopes: tuple[Scope, ...]

    @property
    def free(self) -> bool:
        return is_declared_free(self.model.id)


def offered_for(model: CatalogueModel) -> tuple[Scope, ...]:
    """The scopes a model may be chosen for."""
    if model.supports_tools and not is_declared_free(model.id):
        return SCOPES
    return ("explain",)


def offered_models(prices: dict[str, ModelPrice]) -> list[OfferedModel]:
    """The catalogue's models that have a price, in the catalogue's order."""
    offered = []
    for model in CATALOGUE:
        price = price_for(model.id, prices)
        if price is not None:
            offered.append(OfferedModel(model=model, price=price, scopes=offered_for(model)))
    return offered
