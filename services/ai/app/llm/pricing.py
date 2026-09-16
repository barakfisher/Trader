"""What a completion is estimated to have cost.

Token prices are neither stable nor discoverable at runtime: vendors reprice,
OpenRouter charges its own rate per upstream route, and none of the
OpenAI-compatible `/chat/completions` responses carry a billed amount. So the
price table is configuration (`LLM_MODEL_PRICES`) with the defaults below as a
starting point, and every number this module produces is an estimate - which is
why the field it fills is called `estimated_cost_micro_usd` rather than `cost`.

All arithmetic is Decimal and the result is integer micro-USD, rounded up
exactly once. Rounding up is deliberate: the estimate feeds the daily spend
guard, and the safe direction to be wrong in is "we think we spent slightly more
than we did".

A model with no configured price is NOT treated as free. Free is the one answer
that cannot be recovered from: an unpriced model would run all day against a cap
that never moves, which is precisely the failure LLM_DAILY_BUDGET_USD exists to
prevent. Instead an unpriced model is charged `LLM_UNKNOWN_MODEL_PRICE_USD_PER_MTOK`
on both prompt and completion tokens - a deliberately pessimistic rate, near the
top of the frontier range - and each unpriced model is logged once. Refusing the
call outright was the alternative; it was rejected because it turns "try a
different model for an afternoon" into a required config edit, and because the
consequence of the pessimistic rate is a budget that empties early and visibly
rather than a bill that arrives quietly. The exception is a provider that does
not charge per token at all (Ollama, running on hardware we already own):
`charges_per_token=False` prices at zero by declaration, not by omission.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_CEILING, Decimal, InvalidOperation

from app.core.logging import get_logger
from app.llm.base import MICRO_USD_PER_USD, TokenUsage

log = get_logger("llm.pricing")

_TOKENS_PER_MILLION = Decimal(1_000_000)


@dataclass(frozen=True)
class ModelPrice:
    """USD per million tokens, priced separately for input and output."""

    prompt_usd_per_mtok: Decimal
    completion_usd_per_mtok: Decimal


#: Published list prices in USD per million tokens, read in September 2026.
#: These are defaults, not facts: override them in LLM_MODEL_PRICES when a
#: vendor reprices, rather than editing this table and redeploying. Keys are
#: spelled the way the configured provider spells them - OpenRouter prefixes a
#: vendor ("anthropic/claude-sonnet-4.5"), the vendors' own APIs do not - and
#: lookup falls back across that prefix, so one entry usually covers both.
DEFAULT_MODEL_PRICES: dict[str, ModelPrice] = {
    "anthropic/claude-opus-4.1": ModelPrice(Decimal("15"), Decimal("75")),
    "anthropic/claude-sonnet-4.5": ModelPrice(Decimal("3"), Decimal("15")),
    "anthropic/claude-haiku-4.5": ModelPrice(Decimal("1"), Decimal("5")),
    "openai/gpt-4o": ModelPrice(Decimal("2.5"), Decimal("10")),
    "openai/gpt-4o-mini": ModelPrice(Decimal("0.15"), Decimal("0.6")),
}

#: Charged for a model absent from the table, on both prompt and completion
#: tokens. Roughly the top of the frontier completion range, so an unpriced
#: model exhausts the daily budget sooner than the real bill would - see the
#: module docstring for why that is the direction we choose.
DEFAULT_UNKNOWN_MODEL_PRICE_USD_PER_MTOK = Decimal("20")

#: Models already reported as unpriced. One warning per model per process: this
#: is a configuration gap, and repeating it on every call would bury the rest of
#: the run's logs.
_reported_unpriced: set[str] = set()


def parse_model_prices(raw: str) -> dict[str, ModelPrice]:
    """Parse LLM_MODEL_PRICES ("model=prompt/completion, ...") over the defaults.

    Prices are USD per million tokens, e.g.
    "anthropic/claude-sonnet-4.5=3/15, openai/gpt-4o-mini=0.15/0.60".

    A malformed entry raises rather than being skipped, and `app.config` calls
    this at boot so it raises there. Dropping a bad entry silently would read as
    "this model has no price", which downgrades it to the pessimistic rate and
    makes a typo look like a budget that empties for no reason.
    """
    prices = dict(DEFAULT_MODEL_PRICES)
    for item in raw.split(","):
        entry = item.strip()
        if not entry:
            continue
        model, separator, price_pair = entry.partition("=")
        if not separator or not model.strip():
            raise ValueError(
                f"LLM_MODEL_PRICES entry {entry!r} is not in the form "
                "model=prompt_per_mtok/completion_per_mtok"
            )
        prompt_raw, slash, completion_raw = price_pair.partition("/")
        if not slash:
            raise ValueError(
                f"LLM_MODEL_PRICES entry {entry!r} needs both an input and an output "
                "price, separated by '/'"
            )
        try:
            prompt_price = Decimal(prompt_raw.strip())
            completion_price = Decimal(completion_raw.strip())
        except InvalidOperation as exc:
            raise ValueError(f"LLM_MODEL_PRICES entry {entry!r} has a non-numeric price") from exc
        if prompt_price < 0 or completion_price < 0:
            raise ValueError(f"LLM_MODEL_PRICES entry {entry!r} has a negative price")
        prices[model.strip().lower()] = ModelPrice(prompt_price, completion_price)
    return prices


def price_for(model: str, prices: dict[str, ModelPrice]) -> ModelPrice | None:
    """Look up `model`, tolerating the vendor prefix OpenRouter adds.

    "anthropic/claude-sonnet-4.5" and "claude-sonnet-4.5" are the same model
    billed at the same rate, and requiring both spellings in the table would
    make a provider switch silently unprice the model it had just been using.
    """
    key = model.strip().lower()
    if key in prices:
        return prices[key]
    bare = key.rpartition("/")[2]
    if bare in prices:
        return prices[bare]
    for candidate, price in prices.items():
        if candidate.rpartition("/")[2] == bare:
            return price
    return None


def estimate_cost_micro_usd(
    model: str,
    usage: TokenUsage,
    prices: dict[str, ModelPrice],
    *,
    unknown_price_usd_per_mtok: Decimal = DEFAULT_UNKNOWN_MODEL_PRICE_USD_PER_MTOK,
    charges_per_token: bool = True,
) -> int:
    """Estimate what this call cost, in integer micro-USD, rounded up.

    `charges_per_token=False` (a local Ollama) returns 0, because the call
    genuinely consumes no metered credit. Everything else is priced from the
    table, falling back to the pessimistic unknown-model rate.
    """
    if not charges_per_token:
        return 0

    price = price_for(model, prices)
    if price is None:
        if model not in _reported_unpriced:
            _reported_unpriced.add(model)
            log.warning(
                "llm.model_price_missing",
                model=model,
                assumed_usd_per_mtok=str(unknown_price_usd_per_mtok),
                hint="add the model to LLM_MODEL_PRICES so spend is tracked at its real rate",
            )
        price = ModelPrice(unknown_price_usd_per_mtok, unknown_price_usd_per_mtok)

    usd = (
        Decimal(usage.prompt_tokens) * price.prompt_usd_per_mtok
        + Decimal(usage.completion_tokens) * price.completion_usd_per_mtok
    ) / _TOKENS_PER_MILLION
    micro = (usd * Decimal(MICRO_USD_PER_USD)).to_integral_value(rounding=ROUND_CEILING)
    return int(micro)
