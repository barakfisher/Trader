"""A user's own model, its fallback, and the chain that applies it (D244, D283-D286)."""

from __future__ import annotations

from decimal import Decimal

from app.llm.base import Caller
from app.llm.catalogue import FALLBACK_MODEL, TESTED_MODELS
from app.llm.model_choice import ChoosingProvider
from app.llm.openrouter_models import ListedModel, ModelList
from app.llm.pricing import DEFAULT_MODEL_PRICES, ModelPrice
from app.llm.user_models import (
    ModelResolution,
    UserModelChoice,
    default_model,
    fallback_from,
    resolve,
)
from tests.test_llm_model_choice import Inner, Listed, Users

CHOSEN = "acme/chosen"
FALLBACK_PRICE = DEFAULT_MODEL_PRICES[FALLBACK_MODEL]


def listed(*models: ListedModel, live: bool = True) -> ModelList:
    return ModelList(models=models, live=live)


def model(model_id: str, completion: Decimal, prompt: Decimal = Decimal("0.1")) -> ListedModel:
    return ListedModel(id=model_id, name=model_id, price=ModelPrice(prompt, completion))


TESTED = ListedModel(id=FALLBACK_MODEL, name="Flash-Lite", price=FALLBACK_PRICE)


def test_the_fallback_is_the_first_tested_model():
    assert TESTED_MODELS[0] == FALLBACK_MODEL


def test_a_listed_choice_is_used():
    assert resolve(CHOSEN, listed(model(CHOSEN, Decimal(9)), TESTED)) == ModelResolution(
        saved=CHOSEN, effective=CHOSEN, fallback=False
    )


def test_nothing_chosen_runs_on_the_tested_model_and_is_no_fallback():
    assert resolve(None, listed(TESTED)) == ModelResolution(
        saved=None, effective=FALLBACK_MODEL, fallback=False
    )


def test_a_choice_no_longer_listed_falls_back_to_the_tested_model():
    assert resolve(CHOSEN, listed(TESTED)) == ModelResolution(
        saved=CHOSEN, effective=FALLBACK_MODEL, fallback=True
    )


def test_without_the_tested_model_the_fallback_is_the_dearest_model_no_dearer_than_it():
    ceiling = FALLBACK_PRICE.completion_usd_per_mtok
    at_ceiling = model("acme/equal", ceiling)
    below = model("acme/cheaper", ceiling - Decimal("0.5"))
    above = model("acme/dearer", ceiling + Decimal("0.01"))
    assert default_model(listed(below, above, at_ceiling)) == "acme/equal"
    assert default_model(listed(below, above)) == "acme/cheaper"
    # Nothing at or below it: the tested model is sent anyway.
    assert default_model(listed(above)) == FALLBACK_MODEL


def test_while_the_list_was_never_read_a_saved_model_is_used_as_it_is():
    assert resolve(CHOSEN, listed(TESTED, live=False)).effective == CHOSEN


def test_while_the_list_was_never_read_an_unpriced_saved_model_runs_on_the_tested_one():
    # Priced at the unknown-model rate, a dearer model would be counted low
    # against the safety limit; nothing is known to be gone, so no fallback.
    priced = "anthropic/claude-opus-5.5"
    stand_in = listed(TESTED, live=False)
    assert resolve(priced, stand_in, DEFAULT_MODEL_PRICES).effective == priced
    assert resolve(CHOSEN, stand_in, DEFAULT_MODEL_PRICES) == ModelResolution(
        saved=CHOSEN, effective=FALLBACK_MODEL, fallback=False
    )


def chain(users: Users, models: ModelList) -> tuple[ChoosingProvider, Inner]:
    inner = Inner()
    return ChoosingProvider(inner, users=users, listed=Listed(models)), inner


SCAN = Caller("agent_scan", user_id="u1", agent_id="a1")


async def test_a_user_runs_on_their_agents_model():
    users = Users(UserModelChoice(saved=CHOSEN))
    provider, inner = chain(users, listed(model(CHOSEN, Decimal(3)), TESTED))
    await provider.complete(system=None, user="u", caller=SCAN)
    assert inner.models == [CHOSEN]
    assert users.asked == [("u1", "agent", "a1")] and users.recorded == []


async def test_a_user_who_chose_nothing_runs_on_the_tested_model():
    # D360: the admin too - there is no installation-wide choice to fall back to.
    provider, inner = chain(Users(UserModelChoice(saved=None)), listed(TESTED))
    for purpose in ("agent_scan", "assistant", "narration"):
        await provider.complete(
            system=None, user="u", caller=Caller(purpose, user_id="u1", agent_id="a1")
        )
    assert inner.models == [FALLBACK_MODEL] * 3


async def test_an_unknown_user_runs_on_the_tested_model():
    provider, inner = chain(Users(None), listed(TESTED))
    await provider.complete(system=None, user="u", caller=SCAN)
    assert inner.models == [FALLBACK_MODEL]


async def test_a_fallback_is_recorded_for_its_announcement():
    users = Users(UserModelChoice(saved=CHOSEN))
    provider, inner = chain(users, listed(TESTED))
    await provider.complete(system=None, user="u", caller=SCAN)
    assert inner.models == [FALLBACK_MODEL]
    assert users.recorded == [
        (
            "u1",
            "agent",
            "a1",
            ModelResolution(saved=CHOSEN, effective=FALLBACK_MODEL, fallback=True),
        )
    ]


async def test_an_unreadable_user_choice_runs_on_the_tested_model():
    provider, inner = chain(Users(None, error=RuntimeError("database down")), listed(TESTED))
    await provider.complete(system=None, user="u", caller=SCAN)
    assert inner.models == [FALLBACK_MODEL]


async def test_an_answer_names_the_model_it_fell_back_from():
    users = Users(UserModelChoice(saved=CHOSEN))
    assert await fallback_from(users, Listed(listed(TESTED)), "u1", "assistant") == CHOSEN
    assert users.asked == [("u1", "assistant", None)]
    on_list = Listed(listed(model(CHOSEN, Decimal(1)), TESTED))
    assert await fallback_from(users, on_list, "u1", "assistant") is None
