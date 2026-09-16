"""Assembles the configured LLM provider. The only place that names one.

`build_llm` is to the LLM layer what `build_providers` is to market data: the one
function that reads configuration, decides which adapter to instantiate and
wraps it in the guard rails. Callers receive an `LLMProvider` and never learn
which one - that is guideline 6, and the reason DESIGN.md calls this a single
gateway module.

Choosing a provider that cannot work degrades to `NullProvider` rather than
failing at boot. This is a departure from `app/config.py`, which refuses to start
on a bad setting, and it is chosen for one reason: narration is optional by
design, so an LLM misconfiguration must not take down the quotes API, the
portfolio view or the rule-based pipeline with it. The refusal is not silent -
the reason is logged at startup and again on every attempted call. If this
project later decides that a configured-but-broken LLM should be a boot failure,
this function is the single place to change.
"""

from __future__ import annotations

from redis.asyncio import Redis

from app.config import Settings
from app.core.logging import get_logger
from app.llm.base import LLMProvider
from app.llm.budget import BudgetedProvider, DailySpendGuard
from app.llm.null_provider import NullProvider
from app.llm.openai_compatible import OpenAICompatibleProvider

log = get_logger("llm.factory")

#: Names that explicitly mean "run without narration".
_DISABLED_NAMES = frozenset({"", "null", "none", "off", "disabled"})


class LLMConfigurationError(RuntimeError):
    """A production deployment asked for an LLM it cannot actually use."""


def build_llm(
    settings: Settings,
    redis: Redis | None = None,
    *,
    transport: object | None = None,
) -> LLMProvider:
    """Build the provider named by LLM_PROVIDER, wrapped in the spend guard.

    Misconfiguration degrades to NullProvider in development and raises in
    production. The distinction that matters is between an LLM that is
    deliberately off (LLM_PROVIDER=null, always honoured) and one that is
    broken - a typo in the provider name, or a missing key. Degrading on the
    second is right while developing, where narration is optional and a typo
    must not take down the quotes API. In production it is the silent-failure
    pattern this project exists to avoid: the product quietly loses a core
    feature and nothing says so. Settings already refuses to boot in production
    with a default internal key; this is the same rule applied to the same class
    of mistake.

    `transport` is an httpx transport injected by tests; production passes none.
    """
    name = settings.llm_provider.strip().lower()

    if name in _DISABLED_NAMES:
        return NullProvider("LLM_PROVIDER is set to null; narration is disabled")

    if name == "anthropic":
        # See openai_compatible.py: /v1/messages is a different wire format and
        # nothing needs it while Anthropic models are served through OpenRouter.
        # Failing over to Null keeps the rest of the service running, and says
        # exactly what to do instead.
        log.warning(
            "llm.provider_not_implemented",
            provider=name,
            hint="use LLM_PROVIDER=openrouter with LLM_MODEL=anthropic/... until a "
            "native Anthropic adapter exists",
        )
        return _misconfigured(
            settings,
            "the native Anthropic adapter is not implemented",
            provider=name,
        )

    if name == "openrouter":
        if not settings.openrouter_api_key:
            return _missing_key(settings, name, "OPENROUTER_API_KEY")
        provider = OpenAICompatibleProvider(
            name=name,
            base_url=settings.openrouter_base_url,
            model=settings.llm_model,
            api_key=settings.openrouter_api_key,
            # OpenRouter attributes requests to an application by these headers.
            # Harmless elsewhere, and it makes our traffic identifiable in their
            # dashboard, which is where a spend question gets answered.
            extra_headers={"x-title": "Traders"},
            **_shared_options(settings),
            transport=transport,
        )
    elif name == "openai":
        if not settings.openai_api_key:
            return _missing_key(settings, name, "OPENAI_API_KEY")
        provider = OpenAICompatibleProvider(
            name=name,
            base_url=settings.openai_base_url,
            model=settings.llm_model,
            api_key=settings.openai_api_key,
            **_shared_options(settings),
            transport=transport,
        )
    elif name == "ollama":
        provider = OpenAICompatibleProvider(
            name=name,
            base_url=_ollama_openai_base_url(settings.ollama_base_url),
            # A local runtime serves the models it has pulled, which are not the
            # cloud model ids. OLLAMA_MODEL exists so switching to local does not
            # also mean editing LLM_MODEL.
            model=settings.ollama_model,
            api_key=None,  # Ollama has no auth by default.
            # Local inference consumes electricity, not API credit. The budget
            # guard therefore does not apply, and pricing.py returns zero by
            # declaration rather than because a price is missing.
            charges_per_token=False,
            **_shared_options(settings),
            transport=transport,
        )
    else:
        # An unknown name is a typo, and the safe reading of a typo is "no
        # narration", never "pick something for the user".
        log.error(
            "llm.unknown_provider",
            provider=name,
            known=["openrouter", "openai", "ollama", "anthropic", "null"],
        )
        return _misconfigured(
            settings,
            f"LLM_PROVIDER={name!r} is not a known provider",
            provider=name,
        )

    if not provider.charges_per_token:
        log.info("llm.provider_selected", provider=provider.name, model=provider.model, budget=None)
        return provider

    if redis is None:
        # Fail closed. A metered provider with no way to count what it spends is
        # exactly the situation LLM_DAILY_BUDGET_USD exists to prevent, so the
        # absence of the counter disables the provider rather than the guard.
        log.error("llm.budget_unavailable", provider=provider.name)
        return NullProvider(
            "no Redis connection, so LLM spend cannot be tracked; refusing to call a "
            "metered provider without its budget guard"
        )

    log.info(
        "llm.provider_selected",
        provider=provider.name,
        model=provider.model,
        daily_budget_usd=str(settings.llm_daily_budget_usd),
    )
    return BudgetedProvider(provider, DailySpendGuard(redis, settings.llm_daily_budget_usd))


def _shared_options(settings: Settings) -> dict[str, object]:
    """Options every OpenAI-compatible adapter takes from configuration."""
    return {
        "prices": settings.llm_model_price_map,
        "unknown_price_usd_per_mtok": settings.llm_unknown_model_price_usd_per_mtok,
        "timeout_seconds": settings.llm_timeout_seconds,
        "max_output_tokens": settings.llm_max_output_tokens,
        "temperature": settings.llm_temperature,
    }


def _misconfigured(settings: Settings, reason: str, **log_fields: object) -> NullProvider:
    """Refuse loudly in production, degrade with a warning everywhere else."""
    if settings.is_production:
        log.error("llm.misconfigured", reason=reason, **log_fields)
        raise LLMConfigurationError(
            f"{reason}. Set LLM_PROVIDER=null to run deliberately without narration."
        )
    log.warning("llm.misconfigured", reason=reason, **log_fields)
    return NullProvider(reason)


def _missing_key(settings: Settings, provider: str, env_var: str) -> NullProvider:
    return _misconfigured(
        settings,
        f"{env_var} is not set, so {provider} cannot be used",
        provider=provider,
        setting=env_var,
    )


def _ollama_openai_base_url(base_url: str) -> str:
    """Point at Ollama's OpenAI-compatible surface.

    Ollama serves its native API at the root and the compatible one under /v1,
    and OLLAMA_BASE_URL in .env.example is the root (that is also what the
    Ollama documentation prints). Appending the suffix here means a user who
    copies either spelling into .env gets a working client, instead of a 404 that
    looks like a broken adapter.
    """
    trimmed = base_url.rstrip("/")
    return trimmed if trimmed.endswith("/v1") else f"{trimmed}/v1"
