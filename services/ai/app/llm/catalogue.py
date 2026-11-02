"""The short list of models that stands in for OpenRouter's list until it is read (D283).

Every model here was read from OpenRouter's model list (2026-10-06,
docs/PROPOSAL-MULTI-AGENT.md §14.1) for its price and whether it accepts tools,
and each must also have a price in `pricing.py` or `LLM_MODEL_PRICES` to stand in
at all: a model without one would be charged the pessimistic unknown-model rate.
It was the Admin page's offer (D43) until the admin chose like every user (D360).

Ids are OpenRouter's. The list applies only when `LLM_PROVIDER=openrouter`; with
another provider the configured model is used and nothing can be chosen.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

#: What a choice is for: `explain` is narration and `/ask`, `agent` an agent's scan,
#: `assistant` the assistant's conversations (migration 0052).
Scope = Literal["explain", "agent", "assistant"]


@dataclass(frozen=True)
class CatalogueModel:
    id: str
    label: str
    supports_tools: bool


CATALOGUE: tuple[CatalogueModel, ...] = (
    CatalogueModel("anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5", supports_tools=True),
    CatalogueModel("anthropic/claude-opus-5.5", "Claude Opus 5.5", supports_tools=True),
    CatalogueModel("anthropic/claude-haiku-4.5", "Claude Haiku 4.5", supports_tools=True),
    CatalogueModel("google/gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite", supports_tools=True),
    CatalogueModel(
        "nvidia/nemotron-3.5-lightning:free", "Nemotron 3.5 Lightning (free)", supports_tools=True
    ),
)


#: The models the scans' evidence validator and tool calls were tuned on (D75,
#: D227), marked "tested" wherever a user chooses (D285). A constant, because the
#: claim changes only after a measurement, and a measurement ends in a code change
#: and a decision anyway. The first is the fallback for a chosen model OpenRouter
#: no longer lists, and the model of a user who has chosen none (D283, D284).
TESTED_MODELS: tuple[str, ...] = ("google/gemini-3.5-flash-lite",)
#: Where a user's model falls back to (D284).
FALLBACK_MODEL = TESTED_MODELS[0]
