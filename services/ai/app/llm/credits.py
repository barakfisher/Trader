"""What is left on the LLM account, for the Admin page's "how much should I add" (D44).

Only OpenRouter reports a balance through its API (`GET /credits`: what was
bought and what was used, in USD). Other providers have no such endpoint, and
the page then says nothing rather than a zero - a zero would read as "empty".

Read with the key the provider already uses, on request only; never cached, so
a top-up shows on the next reload. A failure is reported as unavailable, never
raised: the balance is a convenience beside the choice, not a precondition.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Protocol

import httpx

from app.config import Settings
from app.core.logging import get_logger

log = get_logger("llm.credits")

_TIMEOUT_SECONDS = 5.0


@dataclass(frozen=True)
class Credits:
    purchased_usd: Decimal
    used_usd: Decimal

    @property
    def remaining_usd(self) -> Decimal:
        return self.purchased_usd - self.used_usd


class CreditSource(Protocol):
    async def credits(self) -> Credits | None:
        """The account's balance, or None when it could not be read."""
        ...


class OpenRouterCredits:
    def __init__(
        self, base_url: str, api_key: str, *, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self._url = f"{base_url.rstrip('/')}/credits"
        self._api_key = api_key
        self._transport = transport

    async def credits(self) -> Credits | None:
        try:
            async with httpx.AsyncClient(
                timeout=_TIMEOUT_SECONDS, transport=self._transport
            ) as client:
                # The key is sent to the provider it belongs to and logged nowhere (guideline 9).
                response = await client.get(
                    self._url, headers={"authorization": f"Bearer {self._api_key}"}
                )
            response.raise_for_status()
            data = response.json()["data"]
            return Credits(
                purchased_usd=Decimal(str(data["total_credits"])),
                used_usd=Decimal(str(data["total_usage"])),
            )
        except (httpx.HTTPError, KeyError, TypeError, ValueError, InvalidOperation) as error:
            log.warning("llm.credits_unreadable", error=type(error).__name__)
            return None


def build_credit_source(settings: Settings) -> CreditSource | None:
    """The configured provider's balance, when it has one to report."""
    if settings.llm_provider.strip().lower() != "openrouter" or not settings.openrouter_api_key:
        return None
    return OpenRouterCredits(settings.openrouter_base_url, settings.openrouter_api_key)
