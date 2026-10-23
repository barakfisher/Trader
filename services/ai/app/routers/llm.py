"""The models the Admin page offers, what each would cost, and the account's balance -
and the models a user on their own key may choose, with what each user chose (D244, D283).

Read-only: the orchestrator's admin route writes the choice (`llm_model_choices`)
and audits it (decision 84); this service owns the catalogue, the prices and the
estimate, and reads the choice on every call (`app/llm/model_choice.py`).
"""

from __future__ import annotations

from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.engine import Engine

from app.config import get_settings
from app.db import get_engine
from app.deps import require_internal_key
from app.llm.catalogue import FALLBACK_MODEL, SCOPES, TESTED_MODELS, offered_models
from app.llm.credits import build_credit_source
from app.llm.factory import configured_model, models_are_choosable
from app.llm.model_choice import DatabaseModelChoices
from app.llm.openrouter_models import ModelList, OpenRouterModels, stand_in
from app.llm.spend_estimate import (
    agent_basis,
    agent_estimate,
    explain_basis,
    explain_estimate,
    scan_estimate_micro_usd,
)
from app.llm.user_models import DatabaseUserModels, ModelResolution, resolve
from app.models import (
    AgentLlmModel,
    LlmAgentBasis,
    LlmCostEstimate,
    LlmCredits,
    LlmExplainBasis,
    LlmListedModel,
    LlmListedModelsResponse,
    LlmModelResolution,
    LlmModelsResponse,
    LlmOfferedModel,
    LlmScopeChoice,
    UserLlmModelsResponse,
    UserLlmScopeModel,
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


def decimal_text(value: Decimal) -> str:
    """A price as a plain decimal string, never in exponent form: OpenRouter's
    per-token "0.00001" times a million is Decimal("10.00000"), which
    `normalize()` alone prints as "1E+1" - and no client parses that as money."""
    return format(value.normalize(), "f")


async def _listed(request: Request) -> ModelList:
    """OpenRouter's list as the provider chain sees it; the stand-in without one."""
    listed: OpenRouterModels | None = getattr(request.app.state, "listed_models", None)
    if listed is None:
        return stand_in(get_settings().llm_model_price_map)
    return await listed.current()


@router.get("/listed", response_model=LlmListedModelsResponse)
async def llm_listed(
    request: Request, engine: Engine = Depends(get_engine)
) -> LlmListedModelsResponse:
    listed = await _listed(request)
    agents = agent_basis(engine)
    return LlmListedModelsResponse(
        choosable=models_are_choosable(get_settings()),
        live=listed.live,
        fallback_model=FALLBACK_MODEL,
        models=[
            LlmListedModel(
                id=model.id,
                name=model.name,
                prompt_usd_per_mtok=decimal_text(model.price.prompt_usd_per_mtok),
                completion_usd_per_mtok=decimal_text(model.price.completion_usd_per_mtok),
                tested=model.id in TESTED_MODELS,
                scan_estimate_micro_usd=scan_estimate_micro_usd(agents, model.price),
            )
            for model in listed.models
        ],
    )


@router.get("/users/{user_id}/models", response_model=UserLlmModelsResponse)
async def user_llm_models(
    user_id: UUID, request: Request, engine: Engine = Depends(get_engine)
) -> UserLlmModelsResponse:
    settings = get_settings()
    saved = DatabaseUserModels(engine).all_for(str(user_id))
    if saved is None:
        raise HTTPException(status_code=404, detail="no such user")
    choosable = models_are_choosable(settings)
    listed = await _listed(request)
    book: OpenRouterModels | None = getattr(request.app.state, "listed_models", None)
    prices = book.prices if book is not None else settings.llm_model_price_map

    def resolved(model: str | None) -> LlmModelResolution:
        if not choosable:
            # Nothing can be chosen here: every call runs on the configured model.
            return LlmModelResolution(
                saved=model, effective=configured_model(settings), fallback=False
            )
        resolution: ModelResolution = resolve(model, listed, prices)
        return LlmModelResolution(**vars(resolution))

    return UserLlmModelsResponse(
        admin=saved.admin,
        choosable=choosable,
        live=listed.live,
        choices=[
            UserLlmScopeModel(scope="explain", **resolved(saved.explain).model_dump()),
            UserLlmScopeModel(scope="assistant", **resolved(saved.assistant).model_dump()),
        ],
        agents=[
            AgentLlmModel(
                agent_id=UUID(agent.agent_id), name=agent.name, **resolved(agent.saved).model_dump()
            )
            for agent in saved.agents
        ],
    )
