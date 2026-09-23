"""One adapter for every endpoint that speaks OpenAI's `/chat/completions`.

OpenRouter, OpenAI and a local Ollama all accept the same request body and
return the same response shape. The only differences are the base URL, the
credential and the model id, so they are constructor arguments rather than three
near-identical classes: a fourth compatible gateway (Together, Groq, vLLM, LM
Studio) is a line in factory.py, and every one of them inherits this module's
timeout, retry and spend-logging behaviour for free. Three subclasses would have
meant three places to forget the retry policy.

**Anthropic's native API is a deliberate extension point, not an oversight.**
`/v1/messages` differs in more than a URL: the system prompt is a top-level
field rather than a message, `max_tokens` is required, usage is reported as
`input_tokens`/`output_tokens`, and the content is a list of typed blocks. That
is a real adapter, and it buys nothing today - Anthropic models are reachable
through OpenRouter (`anthropic/claude-sonnet-4.5`), which is how LLM_PROVIDER is
configured out of the box. Write `AnthropicProvider` when someone needs direct
access (a billing relationship, prompt caching, or the beta endpoints); it
implements the same Protocol and nothing outside this package changes.

**Reasoning tokens are spent out of the same `max_tokens` as the answer.** On
every gateway that serves reasoning models, the thinking a model does before it
writes counts against the output cap, so a 700-token cap sized for "a headline
plus a short explanation" can be consumed entirely by deliberation and return an
empty or truncated narration - which the evidence validator then rejects, so the
symptom is a template fallback rather than an error. `reasoning_effort` caps the
thinking instead of the answer: measured against OpenRouter's free Nemotron
route, the default effort spent ~400-570 tokens on reasoning where "low" spends
~120. It is sent only when set, because a model that does not reason has no such
parameter and gateways differ on whether an unknown field is ignored or refused.

Retry policy: exactly one retry, on 429 and on 5xx. A 4xx will not fix itself -
a malformed request, a revoked key or a model that does not exist returns the
same answer however many times we ask, so retrying it only spends time and, for
a paid gateway, possibly money. Narration is optional in this product; one retry
is the point where persistence stops being worth the latency it adds to a
scheduled run.
"""

from __future__ import annotations

import asyncio
from decimal import Decimal
from typing import Any

import httpx

from app.core.logging import get_logger
from app.llm.base import (
    LLMCompletion,
    LLMRequestError,
    LLMTimeoutError,
    TokenUsage,
)
from app.llm.pricing import (
    DEFAULT_UNKNOWN_MODEL_PRICE_USD_PER_MTOK,
    ModelPrice,
    estimate_cost_micro_usd,
)

log = get_logger("llm.openai_compatible")

#: Statuses worth one more attempt: rate limiting and a server-side fault are
#: both plausibly transient. Everything else in 4xx is our own request.
_RETRYABLE_STATUS = frozenset({429, 500, 502, 503, 504, 529})

#: Ceiling on a server-supplied Retry-After. A gateway asking us to wait two
#: minutes is asking us to hold a scheduled run open; we would rather skip
#: narration for this finding and let the next run try.
_MAX_RETRY_AFTER_SECONDS = 10.0


class OpenAICompatibleProvider:
    """Chat-completions client for OpenRouter, OpenAI, Ollama and lookalikes."""

    def __init__(
        self,
        *,
        name: str,
        base_url: str,
        model: str,
        api_key: str | None = None,
        prices: dict[str, ModelPrice] | None = None,
        unknown_price_usd_per_mtok: Decimal = DEFAULT_UNKNOWN_MODEL_PRICE_USD_PER_MTOK,
        charges_per_token: bool = True,
        timeout_seconds: float = 30.0,
        max_output_tokens: int = 700,
        temperature: float = 0.1,
        reasoning_effort: str | None = None,
        retry_backoff_seconds: float = 1.0,
        extra_headers: dict[str, str] | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.name = name
        self.charges_per_token = charges_per_token
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._api_key = api_key
        self._prices = prices or {}
        self._unknown_price = unknown_price_usd_per_mtok
        self._timeout_seconds = timeout_seconds
        self._max_output_tokens = max_output_tokens
        self._temperature = temperature
        self._reasoning_effort = reasoning_effort
        self._retry_backoff_seconds = retry_backoff_seconds
        self._extra_headers = extra_headers or {}
        # Injected by tests as an httpx.MockTransport, which keeps the suite
        # offline without a mocking library or a live key.
        self._transport = transport

    @property
    def model(self) -> str:
        return self._model

    def _headers(self) -> dict[str, str]:
        headers = {"content-type": "application/json", **self._extra_headers}
        if self._api_key:
            # Never logged: the log lines in this package carry model, tokens and
            # cost, and nothing that could carry a credential (guideline 9).
            headers["authorization"] = f"Bearer {self._api_key}"
        return headers

    async def complete(
        self,
        *,
        system: str | None,
        user: str,
        max_output_tokens: int | None = None,
        temperature: float | None = None,
        reasoning_effort: str | None = None,
    ) -> LLMCompletion:
        payload = self._build_payload(
            system=system,
            user=user,
            max_output_tokens=max_output_tokens,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
        )
        response = await self._post_with_one_retry(payload)
        return self._parse(response)

    def _build_payload(
        self,
        *,
        system: str | None,
        user: str,
        max_output_tokens: int | None = None,
        temperature: float | None = None,
        reasoning_effort: str | None = None,
    ) -> dict[str, Any]:
        """The request body, built without sending it.

        Separated so the request *shape* can be asserted in a test. The
        difference between `{"effort": "low"}`, `{"exclude": true}` and
        `{"enabled": false}` is invisible in a successful response and decides
        whether a reasoning model answers at all, so it is worth pinning.
        """
        messages: list[dict[str, str]] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": user})

        payload: dict[str, Any] = {
            "model": self._model,
            "messages": messages,
            "max_tokens": max_output_tokens or self._max_output_tokens,
            "temperature": self._temperature if temperature is None else temperature,
            # No streaming: the caller wants one finished narration, and a
            # streamed response would have to be reassembled before the evidence
            # validator could see it anyway.
            "stream": False,
        }
        # The call decides, and falls back to the deployment's default only when
        # it has no opinion. `None` is "no opinion"; the string "none" is an
        # opinion, and the two must not collapse into each other.
        # The call decides, and falls back to the deployment's default only when
        # it has no opinion. `None` is "no opinion"; the string "none" is an
        # opinion, and the two must not collapse into each other.
        effort = self._reasoning_effort if reasoning_effort is None else reasoning_effort
        if effort:
            # OpenRouter's normalised spelling, which it translates to whatever
            # the upstream vendor calls the same knob. `NO_REASONING` goes
            # through as an effort like any other: measured against a free
            # reasoning model, `{"effort": "none"}` returns
            # `reasoning_tokens: 0` and clean JSON, which is the whole
            # requirement. An `{"enabled": false}` special case was written
            # first and removed - it behaves identically, so it was a second
            # spelling of something the pass-through already said.
            #
            # Why it matters at all: reasoning is billed out of
            # `max_output_tokens`, and a reply truncated mid-thought comes back
            # with the reasoning in `content` instead of the answer. Measured on
            # the narration prompt at 1707 reasoning tokens against a 700-token
            # budget - every reply unusable, and the symptom looked like a model
            # ignoring "reply with JSON only".
            payload["reasoning"] = {"effort": effort}

        return payload

    async def _post_with_one_retry(self, payload: dict[str, Any]) -> httpx.Response:
        url = f"{self._base_url}/chat/completions"
        timeout = httpx.Timeout(self._timeout_seconds)

        async with httpx.AsyncClient(
            timeout=timeout, transport=self._transport, headers=self._headers()
        ) as client:
            for attempt in (1, 2):
                try:
                    response = await client.post(url, json=payload)
                except httpx.TimeoutException as exc:
                    # Not retried. A generation that ran past the timeout was
                    # most likely long rather than unlucky, so the retry would
                    # pay the timeout a second time and fail the same way.
                    log.warning(
                        "llm.timeout",
                        provider=self.name,
                        model=self._model,
                        timeout_seconds=self._timeout_seconds,
                    )
                    raise LLMTimeoutError(self.name, self._timeout_seconds) from exc
                except httpx.HTTPError as exc:
                    raise LLMRequestError(self.name, f"transport error: {exc}") from exc

                if response.status_code < 400:
                    return response

                retryable = response.status_code in _RETRYABLE_STATUS
                log.warning(
                    "llm.http_error",
                    provider=self.name,
                    model=self._model,
                    status=response.status_code,
                    attempt=attempt,
                    will_retry=retryable and attempt == 1,
                )
                if not retryable or attempt == 2:
                    raise LLMRequestError(
                        self.name,
                        f"HTTP {response.status_code}: {_short_body(response)}",
                        status_code=response.status_code,
                    )
                await asyncio.sleep(self._retry_delay(response))

        # Unreachable: the loop either returns or raises on both attempts.
        raise LLMRequestError(self.name, "retry loop ended without a response")

    def _retry_delay(self, response: httpx.Response) -> float:
        """Honour Retry-After when the gateway sends a usable one."""
        raw = response.headers.get("retry-after")
        if raw:
            try:
                return min(float(raw), _MAX_RETRY_AFTER_SECONDS)
            except ValueError:
                # Retry-After may also be an HTTP date. Parsing that for a single
                # retry is not worth a dependency; fall back to our own backoff.
                pass
        return self._retry_backoff_seconds

    def _parse(self, response: httpx.Response) -> LLMCompletion:
        try:
            body = response.json()
        except ValueError as exc:
            raise LLMRequestError(self.name, "response body was not JSON") from exc

        usage_body = body.get("usage") or {}
        usage = TokenUsage(
            prompt_tokens=int(usage_body.get("prompt_tokens") or 0),
            completion_tokens=int(usage_body.get("completion_tokens") or 0),
        )
        # The model the gateway actually served, which OpenRouter may resolve to
        # something other than what we asked for. Priced and logged on what ran.
        model = str(body.get("model") or self._model)
        cost = estimate_cost_micro_usd(
            model,
            usage,
            self._prices,
            unknown_price_usd_per_mtok=self._unknown_price,
            charges_per_token=self.charges_per_token,
        )

        choices = body.get("choices") or []
        text = ""
        if choices:
            text = str((choices[0].get("message") or {}).get("content") or "").strip()
        if not text:
            # A 200 with no content still consumed prompt tokens, so the charge
            # travels with the error and the budget guard records it.
            raise LLMRequestError(
                self.name,
                "response carried no completion text",
                status_code=response.status_code,
                metered_micro_usd=cost,
            )

        return LLMCompletion(
            text=text,
            model=model,
            usage=usage,
            estimated_cost_micro_usd=cost,
            provider=self.name,
        )


def _short_body(response: httpx.Response) -> str:
    """First part of an error body, for the log line.

    Truncated because provider error bodies can be long, and never includes
    request headers - which is where the credential is.
    """
    try:
        return response.text[:300]
    except Exception:  # noqa: BLE001 - a diagnostic string must not raise
        return "<unreadable body>"
