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
    CatalogueModel("google/gemini-3.7-flash", "Gemini 3.7 Flash", supports_tools=True),
    CatalogueModel(
        "nvidia/nemotron-3.5-lightning:free", "Nemotron 3.5 Lightning (free)", supports_tools=True
    ),
)


#: The models each use was measured on, marked "tested" wherever a user chooses
#: for that use (D285). The scans' evidence validator and tool calls were tuned on
#: Flash-Lite (D75, D227); Ask was measured on 43 stored questions, where Gemini
#: 3.7 Flash answered 42, every one in the question's language, and Flash-Lite 40
#: (D379). A constant, because the claim changes only after a measurement, and a
#: measurement ends in a code change and a decision anyway.
#:
#: The first of a use is its default: the model of a user who has chosen none for
#: it (D283), and where a chosen model OpenRouter no longer lists falls back to;
#: when the first is not listed either, the next is (D284).
TESTED_MODELS: dict[Scope, tuple[str, ...]] = {
    "explain": ("google/gemini-3.5-flash-lite",),
    "agent": ("google/gemini-3.5-flash-lite",),
    "assistant": ("google/gemini-3.7-flash", "google/gemini-3.5-flash-lite"),
}
#: The model a user who has chosen nothing runs on, per use.
DEFAULT_MODELS: dict[Scope, str] = {scope: models[0] for scope, models in TESTED_MODELS.items()}
#: The scans' and explanations' default, which the figure check was tuned on.
FALLBACK_MODEL = DEFAULT_MODELS["agent"]
