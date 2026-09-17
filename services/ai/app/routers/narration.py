"""What the narrator is configured to do, as a fact the AI service owns.

The orchestrator needs to tell a reader whether explanations are being written
by a model or by templates, and *why* when they are not. Half of that answer
lives in the feed - every observation now records its own provenance - and half
lives here: which provider is selected, which model, and whether that model
costs anything.

It is served from this service rather than duplicated into the orchestrator's
configuration because the LLM belongs to this service (CLAUDE.md: external
dependencies sit behind interfaces here). A second copy of `LLM_MODEL` in
another process is a copy that will one day disagree with the process actually
making the calls, and the disagreement would surface as a UI confidently naming
the wrong model.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.config import Settings, get_settings
from app.deps import require_internal_key
from app.models import NarrationConfigResponse

router = APIRouter(tags=["narration"], dependencies=[Depends(require_internal_key)])

#: OpenRouter's suffix for a route that bills nothing. It is a naming
#: convention rather than a field, so this is a heuristic and is named as one -
#: but it is the only signal the model id carries, and the alternative is
#: another network call to a pricing endpoint to answer a question the operator
#: already answered by choosing the model.
FREE_ROUTE_SUFFIX = ":free"


@router.get("/narration/config", response_model=NarrationConfigResponse)
async def narration_config(
    settings: Settings = Depends(get_settings),
) -> NarrationConfigResponse:
    provider = settings.llm_provider.strip().lower()
    model = settings.llm_model.strip() or None

    if provider in {"", "null"} or model is None:
        # Deliberately off is not the same as broken, and this endpoint must not
        # make them look alike: `tier: none` says nobody is being billed because
        # nobody was asked, which is a configuration, not a failure.
        tier = "none"
    elif model.endswith(FREE_ROUTE_SUFFIX):
        tier = "free"
    else:
        tier = "paid"

    return NarrationConfigResponse(
        provider=provider or "null",
        model=model,
        tier=tier,
        # A string, because it is money and money never crosses a wire as a
        # float (guideline 3). The caller displays it; nothing arithmetics on it.
        daily_budget_usd=str(settings.llm_daily_budget_usd),
    )
