"""What the narrator is configured to do, as a fact the AI service owns.

The orchestrator needs to tell a reader whether explanations are being written
by a model or by templates, and *why* when they are not. Half of that answer
lives in the feed - every observation now records its own provenance - and half
lives here: whether a provider is selected at all.

It is served from this service rather than duplicated into the orchestrator's
configuration because the LLM belongs to this service (CLAUDE.md: external
dependencies sit behind interfaces here).

It used to name `LLM_MODEL` and a "free" or "paid" tier read from its `:free`
suffix. Both were removed: the model a call uses is chosen per user and per
scope (`model_choice.py`), so the environment's model was a confident answer
about calls it no longer described, and the header said "Free tier" over
explanations written by a paid model.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.config import Settings, get_settings
from app.deps import require_internal_key
from app.models import NarrationConfigResponse

router = APIRouter(tags=["narration"], dependencies=[Depends(require_internal_key)])


@router.get("/narration/config", response_model=NarrationConfigResponse)
async def narration_config(
    settings: Settings = Depends(get_settings),
) -> NarrationConfigResponse:
    provider = settings.llm_provider.strip().lower()
    # Deliberately off is not the same as broken, and this endpoint must not
    # make them look alike: `enabled: false` says nobody is being billed because
    # nobody was asked, which is a configuration, not a failure.
    enabled = provider not in {"", "null"} and settings.llm_model.strip() != ""

    return NarrationConfigResponse(
        provider=provider or "null",
        enabled=enabled,
        # A string, because it is money and money never crosses a wire as a
        # float (guideline 3). The caller displays it; nothing arithmetics on it.
        daily_budget_usd=str(settings.llm_daily_budget_usd),
    )
