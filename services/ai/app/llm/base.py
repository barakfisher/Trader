"""LLM provider contract and the error types callers are expected to handle.

Everything that sends a prompt to a model sits behind this Protocol, for the
same reason `MarketDataProvider` exists: switching OpenRouter for a local Ollama
or for a future direct Anthropic adapter must be a config change, not an edit to
the narration step. See DESIGN.md section 2, "LLM access".

The surface is intentionally one method. This layer exists to narrate findings
that the rule layer has already computed - one system prompt, one user prompt,
one block of text back. It is not a chat client: no conversation history, no
tool calling, no streaming. Those are real features with real designs, and
inventing an interface for them before anything needs one produces an
abstraction shaped by guesses.

Errors are typed because the caller's response differs per failure:

  * `LLMBudgetExceededError` - stop asking for today; the run degrades to
    rule-based observations without narration.
  * `LLMUnavailableError` - no model is configured at all; the same degraded
    path, but permanently rather than until midnight.
  * `LLMTimeoutError` / `LLMRequestError` - this call failed; the run may retry
    later or skip narration for this finding.

All of them derive from `LLMError`, so a caller that only wants "narration did
not happen" catches one type.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Protocol, runtime_checkable

#: Accounting unit for LLM spend. Money in this system is integer minor units
#: (cents for USD), but a single narration call costs a small fraction of a
#: cent: at Sonnet prices, a 600-token completion is roughly 0.9 cents and a
#: Haiku one is under a tenth of that. Rounding each call to whole cents would
#: either round every cheap call to zero - a budget that never fills - or round
#: it up to a cent and over-report spend by an order of magnitude. So spend is
#: counted in integer micro-USD (1e-6 USD) and converted to a displayable
#: amount exactly once, at the boundary. Still integers, still no floats.
MICRO_USD_PER_USD = 1_000_000


def micro_usd_to_usd(micro_usd: int) -> Decimal:
    """Convert the internal accounting unit to a Decimal USD amount."""
    return Decimal(micro_usd) / Decimal(MICRO_USD_PER_USD)


@dataclass(frozen=True)
class TokenUsage:
    """What the provider says the call consumed.

    Providers that report no usage give zeros rather than None: a missing count
    is indistinguishable from a free call downstream, and `estimated` on the
    completion already carries the caveat.
    """

    prompt_tokens: int = 0
    completion_tokens: int = 0

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens


@dataclass(frozen=True)
class LLMCompletion:
    """One model response, plus what it cost us as far as we can tell.

    `estimated_cost_micro_usd` is an ESTIMATE and is named in the code as one.
    It is computed locally from a configured price table (see pricing.py), not
    read back from the provider, because none of the OpenAI-compatible
    endpoints return a billed amount on the completion. Published prices drift,
    OpenRouter routes a model to whichever upstream is cheapest at the time, and
    prompt caching or a free tier can make the real charge lower. Treat the
    number as spend telemetry and as the input to the daily guard, never as an
    invoice.
    """

    text: str
    model: str
    usage: TokenUsage
    estimated_cost_micro_usd: int
    #: Which adapter produced this, for logs and for observability parity with
    #: `Quote.source`.
    provider: str

    @property
    def estimated_cost_usd(self) -> Decimal:
        return micro_usd_to_usd(self.estimated_cost_micro_usd)


#: The `reasoning_effort` value meaning "do not think, just answer".
#:
#: It lives on the interface rather than in one adapter because it is part of
#: the contract every provider honours, and a call site that had to import it
#: from a concrete provider would be naming the vendor it is supposed not to
#: know about (guideline 6).
#:
#: Spelled out rather than expressed as an empty string, because unset must keep
#: meaning "say nothing and let the model decide" - a different request from
#: "thinking off", and on a reasoning model a very different bill.
NO_REASONING = "none"


@runtime_checkable
class LLMProvider(Protocol):
    #: Stable identifier, recorded on every completion and in every log line.
    name: str

    #: Does a call to this provider cost money per token? False for Ollama,
    #: which runs on hardware we already pay for. The budget guard charges
    #: nothing for such a provider, and pricing.py treats a missing price as
    #: free only here - never for a keyed cloud endpoint. This mirrors
    #: `MarketDataProvider.makes_external_requests`, which exists so the rate
    #: limiter does not charge quota for reading a local fixture file.
    charges_per_token: bool

    async def complete(
        self,
        *,
        system: str | None,
        user: str,
        max_output_tokens: int | None = None,
        temperature: float | None = None,
        reasoning_effort: str | None = None,
    ) -> LLMCompletion:
        """Produce one completion, or raise an `LLMError` subclass.

        `reasoning_effort` is per call, and None means "no opinion - use whatever
        this deployment configured". It is on the call rather than only on the
        provider because how much a model should think is a property of the
        *task*, not of the installation: narration restates figures it may not
        alter and wants no thinking at all, while answering a question about a
        portfolio may genuinely need some. A single process-wide setting forces
        one answer on both, and the caller that did not think about it inherits
        the choice made by the one that did.

        Never returns a partial or placeholder answer. Narration is optional in
        this product; a fabricated one is not an acceptable substitute for its
        absence (guideline 7).
        """
        ...


class LLMError(RuntimeError):
    """Base class for every failure of this layer.

    `metered_micro_usd` is spend the provider believes already happened despite
    the failure - an answer that arrived and could not be parsed still burned
    tokens. The budget guard records it before re-raising, so a failed call
    cannot become an unrecorded charge. Zero on failures that provably consumed
    nothing.
    """

    metered_micro_usd: int = 0


class LLMUnavailableError(LLMError):
    """No usable model is configured, so no call was attempted.

    Raised by NullProvider. This is a normal state, not a bug: the system is
    required to run with no LLM credentials at all.
    """


class LLMBudgetExceededError(LLMError):
    """The configured daily spend ceiling is reached; no call was attempted."""

    def __init__(self, spent_micro_usd: int, cap_micro_usd: int, day: str) -> None:
        super().__init__(
            f"LLM daily budget exhausted for {day}: "
            f"estimated spend {micro_usd_to_usd(spent_micro_usd)} USD "
            f"against a cap of {micro_usd_to_usd(cap_micro_usd)} USD"
        )
        self.spent_micro_usd = spent_micro_usd
        self.cap_micro_usd = cap_micro_usd
        self.day = day


class LLMRequestError(LLMError):
    """The provider was reached and refused, or answered unusably."""

    def __init__(
        self,
        provider: str,
        message: str,
        *,
        status_code: int | None = None,
        metered_micro_usd: int = 0,
    ) -> None:
        super().__init__(f"{provider}: {message}")
        self.provider = provider
        self.status_code = status_code
        self.metered_micro_usd = metered_micro_usd


class LLMTimeoutError(LLMError):
    """The provider did not answer within the configured timeout."""

    def __init__(self, provider: str, timeout_seconds: float) -> None:
        super().__init__(f"{provider}: no response within {timeout_seconds}s")
        self.provider = provider
        self.timeout_seconds = timeout_seconds
