"""The installation's provider keys, as the Admin page's Keys tab describes them (D251, D288).

**Status, never values** (guideline 9). For each provider key this service
reads from its configuration: whether it is set, what it would serve, whether
anything here uses it now, the last error a real call met, and - where a free
check exists - a *Test*. The value itself never leaves this module: not in a
response, not in a log, not in an error message.

**Only provider keys are listed.** The app's own secrets (`INTERNAL_API_KEY`,
`LLM_KEY_ENCRYPTION_KEYS`, the session and Telegram secrets) have nothing to
test, and a list of them only maps them for an intruder (D251).

**Measured 2026-10-23:** `POLYGON_API_KEY`, `ALPHAVANTAGE_API_KEY`,
`FINNHUB_API_KEY`, `COINGECKO_API_KEY`, `NEWSAPI_KEY` and `ANTHROPIC_API_KEY` are
read by `config.py`, but no adapter in this service uses them (the market data
chain is fixture and yfinance, news is GDELT and Yahoo, and the native Anthropic
adapter is not implemented). They are listed as "no adapter uses it", so a set
one is not mistaken for a working provider and an unset one for a fault.

**A Test makes one free call:** OpenRouter's `GET /key` and OpenAI's
`GET /models` cost nothing and change nothing. Keys with no adapter have no test.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

import httpx
from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.config import Settings
from app.core.logging import get_logger

log = get_logger("installation_keys")

#: What a key would serve here.
Serves = Literal["llm", "embeddings", "market_data", "news"]
#: Why a set key does nothing now: no adapter for it, or its provider is not the one chosen.
Unused = Literal["no_adapter", "not_chosen"]

_TEST_TIMEOUT_SECONDS = 10.0
#: The longest last error shown; the full text stays in `llm_calls` for the LLM panel.
LAST_ERROR_MAX_CHARS = 300

#: Anything shaped like a credential is masked before an error is shown: an
#: upstream message may echo a header or a URL, and a key must never reach the page.
_SECRET_SHAPES = re.compile(
    r"(sk-[A-Za-z0-9_*.-]{4,}"  # OpenAI and OpenRouter, including their own masked echo
    r"|Bearer\s+\S+"
    r"|bot\d+:[A-Za-z0-9_-]+|\d{6,}:[A-Za-z0-9_-]{30,}"  # a Telegram token, in a URL or bare
    r"|(?:api_?key|apikey|token|key)=[^&\s]+"  # a key in a query string
    r"|[A-Fa-f0-9]{32,}|[A-Za-z0-9_-]{40,})",
    re.IGNORECASE,
)


def redact(message: str, *values: str | None) -> str:
    """The message with anything credential-shaped replaced, shortened for a table.

    `values` are the configured keys themselves, replaced word for word first: exact,
    whatever a provider's key looks like. The shapes catch the rest. Shortened only
    after both, so a cut can never leave a fragment too short to recognise.
    """
    for value in values:
        if value and value.strip():
            message = message.replace(value.strip(), "[redacted]")
    cleaned = _SECRET_SHAPES.sub("[redacted]", message)
    return (
        cleaned
        if len(cleaned) <= LAST_ERROR_MAX_CHARS
        else cleaned[: LAST_ERROR_MAX_CHARS - 1] + "…"
    )


@dataclass(frozen=True)
class LastError:
    at: datetime
    message: str


@dataclass(frozen=True)
class KeyStatus:
    name: str
    provider: str
    is_set: bool
    #: What it serves now; empty when nothing here uses it.
    serves: tuple[Serves, ...]
    unused: Unused | None
    testable: bool
    last_error: LastError | None


@dataclass(frozen=True)
class TestResult:
    ok: bool
    #: For a failure, what the provider said, redacted; None on success.
    detail: str | None
    checked_at: datetime


@dataclass(frozen=True)
class _Spec:
    name: str
    provider: str
    #: The configured value, or None.
    value: Callable[[Settings], str | None]
    #: What it serves under this configuration; None when no adapter exists at all.
    serves: Callable[[Settings], tuple[Serves, ...]] | None
    #: The `llm_calls.provider` a real call through it is recorded under, for its last error.
    call_provider: str | None = None


def _chosen(settings: Settings, provider: str) -> tuple[Serves, ...]:
    served: list[Serves] = []
    if settings.llm_provider.strip().lower() == provider:
        served.append("llm")
    if settings.embeddings_provider.strip().lower() == provider:
        served.append("embeddings")
    return tuple(served)


#: Every provider key, in the order the tab shows them.
SPECS: tuple[_Spec, ...] = (
    _Spec(
        "OPENROUTER_API_KEY",
        "OpenRouter",
        lambda s: s.openrouter_api_key,
        lambda s: _chosen(s, "openrouter"),
        call_provider="openrouter",
    ),
    _Spec(
        "OPENAI_API_KEY",
        "OpenAI",
        lambda s: s.openai_api_key,
        lambda s: _chosen(s, "openai"),
        call_provider="openai",
    ),
    _Spec("ANTHROPIC_API_KEY", "Anthropic", lambda s: s.anthropic_api_key, None),
    _Spec("POLYGON_API_KEY", "Polygon", lambda s: s.polygon_api_key, None),
    _Spec("ALPHAVANTAGE_API_KEY", "Alpha Vantage", lambda s: s.alphavantage_api_key, None),
    _Spec("FINNHUB_API_KEY", "Finnhub", lambda s: s.finnhub_api_key, None),
    _Spec("COINGECKO_API_KEY", "CoinGecko", lambda s: s.coingecko_api_key, None),
    _Spec("NEWSAPI_KEY", "NewsAPI", lambda s: s.newsapi_key, None),
)
KEY_NAMES: tuple[str, ...] = tuple(spec.name for spec in SPECS)
#: Keys with a free check call (`check_key`).
TESTABLE: frozenset[str] = frozenset({"OPENROUTER_API_KEY", "OPENAI_API_KEY"})


def _last_error(engine: Engine, provider: str, *secrets: str | None) -> LastError | None:
    """The last installation-paid call to `provider` that failed at the provider."""
    with engine.connect() as connection:
        row = connection.execute(
            text(
                """
                SELECT started_at, error FROM llm_calls
                 WHERE provider = :provider AND paid_by = 'installation'
                   AND outcome = 'provider_error'
                 ORDER BY started_at DESC LIMIT 1
                """
            ),
            {"provider": provider},
        ).one_or_none()
    if row is None:
        return None
    return LastError(at=row.started_at, message=redact(row.error or "", *secrets))


def key_statuses(settings: Settings, engine: Engine | None) -> list[KeyStatus]:
    statuses = []
    for spec in SPECS:
        is_set = bool((spec.value(settings) or "").strip())
        serves = spec.serves(settings) if spec.serves is not None else ()
        unused: Unused | None = (
            "no_adapter" if spec.serves is None else ("not_chosen" if not serves else None)
        )
        last_error = None
        if spec.call_provider is not None and engine is not None:
            try:
                last_error = _last_error(engine, spec.call_provider, spec.value(settings))
            except Exception as error:  # noqa: BLE001 - the tab still shows what it can
                log.warning("installation_keys.last_error_unreadable", error=type(error).__name__)
        statuses.append(
            KeyStatus(
                name=spec.name,
                provider=spec.provider,
                is_set=is_set,
                serves=serves,
                unused=unused,
                testable=spec.name in TESTABLE and is_set,
                last_error=last_error,
            )
        )
    return statuses


async def check_key(
    name: str, settings: Settings, *, transport: httpx.AsyncBaseTransport | None = None
) -> TestResult | None:
    """One free call with the key; None when the key has no test or is not set."""
    spec = next((candidate for candidate in SPECS if candidate.name == name), None)
    value = (spec.value(settings) or "").strip() if spec is not None else ""
    if spec is None or name not in TESTABLE or not value:
        return None
    if name == "OPENROUTER_API_KEY":
        url = f"{settings.openrouter_base_url.rstrip('/')}/key"
    else:
        url = f"{settings.openai_base_url.rstrip('/')}/models"
    now = datetime.now(UTC)
    try:
        async with httpx.AsyncClient(timeout=_TEST_TIMEOUT_SECONDS, transport=transport) as client:
            # The key goes only to the provider it belongs to, and is logged nowhere (guideline 9).
            response = await client.get(url, headers={"authorization": f"Bearer {value}"})
    except httpx.HTTPError as error:
        return TestResult(
            ok=False, detail=redact(f"{type(error).__name__}: {error}"), checked_at=now
        )
    if response.is_success:
        return TestResult(ok=True, detail=None, checked_at=now)
    return TestResult(
        ok=False,
        detail=redact(f"HTTP {response.status_code}: {response.text[:200]}"),
        checked_at=now,
    )
