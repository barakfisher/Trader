"""The models the Admin page offers, what each would cost, and the account's balance.

Read-only: the orchestrator's admin route writes the choice (`llm_model_choices`)
and audits it (decision 84); this service owns the catalogue, the prices and the
estimate, and reads the choice on every call (`app/llm/model_choice.py`).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.engine import Engine

from app.config import get_settings
from app.db import get_engine
from app.deps import require_internal_key
from app.llm.catalogue import SCOPES, offered_models
from app.llm.credits import build_credit_source
from app.llm.factory import configured_model, models_are_choosable
from app.llm.model_choice import DatabaseModelChoices
from app.llm.spend_estimate import (
    agent_basis,
    agent_estimate,
    explain_basis,
    explain_estimate,
    scan_estimate_micro_usd,
)
from app.models import (
    LlmAgentBasis,
    LlmCostEstimate,
    LlmCredits,
    LlmExplainBasis,
    LlmModelsResponse,
    LlmOfferedModel,
    LlmScopeChoice,
)

router = APIRouter(prefix="/llm", tags=["llm"], dependencies=[Depends(require_internal_key)])


@router.get("/models", response_model=LlmModelsResponse)
async def llm_models(engine: Engine = Depends(get_engine)) -> LlmModelsResponse:
    settings = get_settings()
    choosable = models_are_choosable(settings)
    configured = configured_model(settings)
    chosen = DatabaseModelChoices(engine).all() if choosable else {}
    explain = explain_basis(engine)
    agents = agent_basis(engine)

    models = []
    for offered in offered_models(settings.llm_model_price_map):
        for_agents = "agent" in offered.scopes
        explained = explain_estimate(explain, offered.price)
        scanned = agent_estimate(agents, offered.price) if for_agents else None
        models.append(
            LlmOfferedModel(
                id=offered.model.id,
                label=offered.model.label,
                prompt_usd_per_mtok=str(offered.price.prompt_usd_per_mtok),
                completion_usd_per_mtok=str(offered.price.completion_usd_per_mtok),
                supports_tools=offered.model.supports_tools,
                free=offered.free,
                scopes=list(offered.scopes),
                explain_estimate=LlmCostEstimate(**vars(explained)),
                agent_estimate=LlmCostEstimate(**vars(scanned)) if scanned else None,
                scan_estimate_micro_usd=(
                    scan_estimate_micro_usd(agents, offered.price) if for_agents else None
                ),
            )
        )

    source = build_credit_source(settings)
    credits = await source.credits() if source is not None else None

    return LlmModelsResponse(
        provider=settings.llm_provider.strip().lower(),
        choosable=choosable,
        configured_model=configured,
        choices=[
            LlmScopeChoice(
                scope=scope,
                chosen=chosen.get(scope),
                effective=chosen.get(scope) or configured,
            )
            for scope in SCOPES
        ],
        models=models,
        explain_basis=LlmExplainBasis(
            window_days=explain.window_days,
            prompt_tokens_per_day=round(explain.prompt_tokens_per_day),
            completion_tokens_per_day=round(explain.completion_tokens_per_day),
        ),
        agent_basis=LlmAgentBasis(**vars(agents)),
        credits=(
            LlmCredits(
                purchased_usd=str(credits.purchased_usd),
                used_usd=str(credits.used_usd),
                remaining_usd=str(credits.remaining_usd),
            )
            if credits is not None
            else None
        ),
    )
