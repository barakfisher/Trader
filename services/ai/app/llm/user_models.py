"""The model a user who is not the admin runs on, per agent, for Ask and for explanations (D244).

A user on their own key (D245) chooses from OpenRouter's list
(`openrouter_models.py`, D283): `agents.model` for an agent's scans and its
instructions check, `user_settings.llm_assistant_model` for Ask, and
`user_settings.llm_explain_model` for narration (migration 0069). Nothing chosen
runs on the tested model (`catalogue.FALLBACK_MODEL`, D285) - never the admin's
choice, which governs the admin alone.

**A saved model OpenRouter no longer lists falls back** (D284): to the tested
model, or, when that is not listed either, to the listed model with the highest
output price at or below the tested model's, so a fallback never costs more. The
saved value is kept, and the model returns by itself once listed again. While
the list has never been read (`ModelList.live` is False) nothing is known to be
gone, and a saved model is used as it is.

The first call that falls back records a row in `model_fallbacks`, once per
user, scope, agent and saved model; the orchestrator announces it on Telegram
(D286).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.core.logging import get_logger
from app.llm.catalogue import FALLBACK_MODEL, Scope
from app.llm.openrouter_models import ModelList, OpenRouterModels
from app.llm.pricing import DEFAULT_MODEL_PRICES, ModelPrice, price_for

log = get_logger("llm.user_models")


@dataclass(frozen=True)
class ModelResolution:
    """What a user saved, what a call runs on, and whether that is a fallback."""

    saved: str | None
    effective: str
    fallback: bool


def default_model(listed: ModelList) -> str:
    """The tested model, or the dearest listed model no dearer than it (D284)."""
    if not listed.live or listed.get(FALLBACK_MODEL) is not None:
        return FALLBACK_MODEL
    # The tested model is not listed, so its own price is the table's.
    ceiling = DEFAULT_MODEL_PRICES[FALLBACK_MODEL].completion_usd_per_mtok
    cheaper = [m for m in listed.models if m.price.completion_usd_per_mtok <= ceiling]
    if not cheaper:
        return FALLBACK_MODEL
    best = max(
        cheaper,
        key=lambda m: (m.price.completion_usd_per_mtok, m.price.prompt_usd_per_mtok, m.id),
    )
    return best.id


def resolve(
    saved: str | None, listed: ModelList, prices: dict[str, ModelPrice] | None = None
) -> ModelResolution:
    """The model a call runs on, given what the user saved and what is listed.

    While the list has never been read, a saved model is used as it is only if
    `prices` knows its price: one priced at the unknown-model rate would be counted
    low against the safety limit when it costs more than that rate. Otherwise it
    runs on the tested model, without a fallback recorded - nothing is known to be
    gone.
    """
    if saved is not None and listed.get(saved) is not None:
        return ModelResolution(saved=saved, effective=saved, fallback=False)
    if saved is not None and not listed.live:
        if prices is None or price_for(saved, prices) is not None:
            return ModelResolution(saved=saved, effective=saved, fallback=False)
        return ModelResolution(saved=saved, effective=FALLBACK_MODEL, fallback=False)
    return ModelResolution(saved=saved, effective=default_model(listed), fallback=saved is not None)


@dataclass(frozen=True)
class UserModelChoice:
    """Whether the user is the admin, and what they saved for one scope."""

    admin: bool
    saved: str | None


@dataclass(frozen=True)
class AgentModel:
    agent_id: str
    name: str
    saved: str | None


@dataclass(frozen=True)
class UserModels:
    """Everything a user saved: the two scopes and each agent that scans."""

    admin: bool
    explain: str | None
    assistant: str | None
    agents: tuple[AgentModel, ...]


class UserModelStore(Protocol):
    def choice(self, user_id: str, scope: Scope, agent_id: str | None) -> UserModelChoice | None:
        """The user's saved model for `scope` (None: no such user). May raise."""
        ...

    def record_fallback(
        self, user_id: str, scope: Scope, agent_id: str | None, resolution: ModelResolution
    ) -> None:
        """Record the first fallback for this user, scope, agent and saved model. May raise."""
        ...


class DatabaseUserModels:
    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def choice(self, user_id: str, scope: Scope, agent_id: str | None) -> UserModelChoice | None:
        with self._engine.connect() as connection:
            row = connection.execute(
                text(
                    """
                    SELECT u.role, s.llm_explain_model, s.llm_assistant_model, a.model
                      FROM users u
                      LEFT JOIN user_settings s ON s.user_id = u.id
                      LEFT JOIN agents a ON a.user_id = u.id AND a.id = CAST(:agent AS uuid)
                     WHERE u.id = CAST(:user AS uuid)
                    """
                ),
                {"user": user_id, "agent": agent_id},
            ).one_or_none()
        if row is None:
            return None
        if scope == "agent":
            saved = row.model
        elif scope == "explain":
            saved = row.llm_explain_model
        else:
            saved = row.llm_assistant_model
        return UserModelChoice(admin=row.role == "admin", saved=saved)

    def record_fallback(
        self, user_id: str, scope: Scope, agent_id: str | None, resolution: ModelResolution
    ) -> None:
        if resolution.saved is None:
            return
        with self._engine.begin() as connection:
            # The agent named for the two user-wide scopes is the main portfolio,
            # because a notification names an agent (migration 0069).
            connection.execute(
                text(
                    """
                    INSERT INTO model_fallbacks
                           (user_id, agent_id, scope, saved_model, effective_model)
                    SELECT CAST(:user AS uuid), a.id, :scope, :saved, :effective
                      FROM agents a
                     WHERE a.user_id = CAST(:user AS uuid)
                       AND CASE WHEN :scope = 'agent' THEN a.id = CAST(:agent AS uuid)
                                ELSE a.is_primary END
                    ON CONFLICT ON CONSTRAINT model_fallbacks_once DO NOTHING
                    """
                ),
                {
                    "user": user_id,
                    "agent": agent_id,
                    "scope": scope,
                    "saved": resolution.saved,
                    "effective": resolution.effective,
                },
            )

    def all_for(self, user_id: str) -> UserModels | None:
        """The user's saved models, with every agent that scans (not the main
        portfolio, nothing archived), oldest agent first."""
        with self._engine.connect() as connection:
            user = connection.execute(
                text(
                    """
                    SELECT u.role, s.llm_explain_model, s.llm_assistant_model
                      FROM users u LEFT JOIN user_settings s ON s.user_id = u.id
                     WHERE u.id = CAST(:user AS uuid)
                    """
                ),
                {"user": user_id},
            ).one_or_none()
            if user is None:
                return None
            agents = connection.execute(
                text(
                    """
                    SELECT id::text AS id, name, model FROM agents
                     WHERE user_id = CAST(:user AS uuid) AND NOT is_primary AND state <> 'archived'
                     ORDER BY created_at, id
                    """
                ),
                {"user": user_id},
            ).all()
        return UserModels(
            admin=user.role == "admin",
            explain=user.llm_explain_model,
            assistant=user.llm_assistant_model,
            agents=tuple(
                AgentModel(agent_id=row.id, name=row.name, saved=row.model) for row in agents
            ),
        )


async def fallback_from(
    store: UserModelStore | None, listed: OpenRouterModels | None, user_id: str, scope: Scope
) -> str | None:
    """The saved model a call for this user and scope fell back from, or None.

    For marking an answer that already ran (D284); never raises, because the
    mark is a courtesy beside an answer that was given.
    """
    if store is None or listed is None:
        return None
    try:
        choice = store.choice(user_id, scope, None)
    except Exception as error:  # noqa: BLE001 - the answer was given; the mark is not worth a 500
        log.warning("llm.user_model_unreadable", scope=scope, error=str(error))
        return None
    if choice is None or choice.admin:
        return None
    resolution = resolve(choice.saved, await listed.current(), listed.prices)
    return resolution.saved if resolution.fallback else None
