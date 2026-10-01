"""Provider chain: caching, rate limiting and fallback in one place.

Resolution order comes from MARKET_DATA_PROVIDERS. For each request we take what
the first provider can answer and pass the remainder down the chain, so a
partial answer from a cheap provider still saves quota on an expensive one.

Two cache layers per symbol:
  * `quote:{symbol}` - the normal hot path. Its TTL is decided per quote by
    core/cache_policy.py from the serving provider's delay and whether the
    market is open, with CACHE_TTL_QUOTE as the floor.
  * `quote:last:{symbol}` - 7 days, the "last known good" value used only when
    every provider in the chain has failed. Served with stale=True so the UI can
    label it rather than silently showing an old price as current.

Rate limiting is charged in upstream requests, not in calls: a provider that
fetches one symbol at a time (`batches_requests = False`) costs `len(symbols)`,
and a provider that makes no external request at all costs nothing. Both a
per-minute and a per-UTC-day budget are checked; either one being exhausted
skips the provider and the chain continues.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime

from app.config import Settings
from app.core.cache import Cache
from app.core.cache_policy import quote_ttl
from app.core.logging import get_logger
from app.core.observation_time import at_last_close
from app.core.ratelimit import RateLimiter
from app.models import DailyClose, FxRate, InstrumentResolution, Quote, QuoteMarket
from app.providers.base import MarketDataProvider, ProviderError
from app.providers.fixture import FixtureProvider
from app.providers.price_provenance import admissible_chain
from app.providers.yfinance_provider import YFinanceProvider

log = get_logger("providers")

_LAST_KNOWN_TTL_SECONDS = 7 * 24 * 3600


def build_providers(settings: Settings) -> list[MarketDataProvider]:
    """Instantiate the configured chain, skipping providers that lack credentials."""
    providers: list[MarketDataProvider] = []
    chain = admissible_chain(settings.market_data_chain)
    if len(chain) < len(settings.market_data_chain):
        # Said at startup, once: a fixture behind a real provider would invent
        # a price whenever the real one failed. See price_provenance.py.
        log.warning(
            "providers.fixture_fallback_dropped",
            configured=settings.market_data_chain,
            chain=chain,
        )
    for name in chain:
        key = name.strip().lower()
        if key == "fixture":
            providers.append(FixtureProvider(settings.fixtures_dir))
        elif key == "yfinance":
            providers.append(YFinanceProvider())
        else:
            # Premium adapters (polygon, alphavantage, finnhub, coingecko) plug in
            # here as they are implemented; an unknown name is a config mistake
            # worth surfacing, not silently ignoring.
            log.warning("providers.unknown_provider", provider=key)
    if not providers:
        raise ValueError("MARKET_DATA_PROVIDERS resolved to an empty chain")
    log.info("providers.chain", chain=[p.name for p in providers])
    return providers


class MarketDataService:
    """The only thing the rest of the app talks to for market data."""

    def __init__(
        self,
        providers: list[MarketDataProvider],
        cache: Cache,
        limiter: RateLimiter,
        settings: Settings,
    ) -> None:
        self._providers = providers
        self._cache = cache
        self._limiter = limiter
        self._settings = settings

    @property
    def chain(self) -> list[str]:
        return [p.name for p in self._providers]

    async def quotes(
        self, symbols: list[str], markets: Mapping[str, QuoteMarket] | None = None
    ) -> tuple[list[Quote], list[str]]:
        """Return (quotes, symbols_nobody_could_price).

        `markets` is optional context by symbol; it changes only how long each
        quote is cached, never what is fetched.
        """
        wanted = _dedupe_upper(symbols)
        market_of = {symbol.strip().upper(): market for symbol, market in (markets or {}).items()}
        found: dict[str, Quote] = {}

        # 1. Cache first.
        for symbol in wanted:
            cached = await self._cache.get(f"quote:{symbol}")
            if cached:
                found[symbol] = Quote.model_validate(cached)

        # 2. Walk the chain for whatever is left.
        for provider in self._providers:
            missing = [s for s in wanted if s not in found]
            if not missing:
                break
            if not await self._within_budget(provider, len(missing)):
                continue
            try:
                quotes = await provider.quotes(missing)
            except ProviderError as exc:
                log.warning("providers.failed", provider=provider.name, error=str(exc))
                continue
            for quote in quotes:
                market = market_of.get(quote.symbol.upper())
                # A Sunday read of a stock is Friday's close, and is dated so.
                quote.as_of = at_last_close(
                    quote.as_of,
                    datetime.now(UTC),
                    symbol=quote.symbol,
                    asset_class=market.asset_class if market else None,
                    exchange=market.exchange if market else None,
                )
                found[quote.symbol] = quote
                payload = quote.model_dump(mode="json")
                # The TTL is per quote, not per config: a 15-minute-delayed
                # equity and a 24/7 crypto pair from the same provider have
                # different notions of "fresh". See core/cache_policy.py.
                ttl = quote_ttl(
                    quote.symbol,
                    provider.delay_seconds,
                    minimum_ttl_seconds=self._settings.cache_ttl_quote,
                    asset_class=market.asset_class if market else None,
                    exchange=market.exchange if market else None,
                )
                await self._cache.set(f"quote:{quote.symbol}", payload, ttl)
                await self._cache.set(
                    f"quote:last:{quote.symbol}", payload, _LAST_KNOWN_TTL_SECONDS
                )

        # 3. Last-known-good for anything still unpriced, clearly flagged.
        still_missing: list[str] = []
        for symbol in wanted:
            if symbol in found:
                continue
            last_known = await self._cache.get(f"quote:last:{symbol}")
            if last_known:
                quote = Quote.model_validate(last_known)
                quote.stale = True
                found[symbol] = quote
                log.info("providers.served_stale", symbol=symbol, as_of=str(quote.as_of))
            else:
                still_missing.append(symbol)

        if still_missing:
            log.warning("providers.unpriced", symbols=still_missing)
        return [found[s] for s in wanted if s in found], still_missing

    async def _within_budget(self, provider: MarketDataProvider, symbol_count: int) -> bool:
        """Charge this call to the provider's budgets; False means skip it.

        The cost is the number of upstream requests the call will actually make,
        which is `symbol_count` for a provider that fetches one symbol at a time
        and 1 for one with a real multi-symbol endpoint. Charging 1 either way
        under-reported usage by the batch size, so the mechanism protecting our
        API credits was blind to exactly the requests that consume them.
        """
        if not provider.makes_external_requests:
            return True  # local provider: no quota to spend
        cost = 1 if provider.batches_requests else max(symbol_count, 1)

        daily_limit = self._settings.provider_daily_limit_map.get(provider.name, 0)
        if not await self._limiter.allow_daily(provider.name, daily_limit, cost):
            # Worth its own line: a per-minute denial recovers in under a minute,
            # an exhausted daily budget means this provider is gone until UTC
            # midnight and the chain is running on its fallbacks.
            log.warning(
                "providers.skipped_daily_budget",
                provider=provider.name,
                limit_per_day=daily_limit,
                cost=cost,
            )
            return False

        if not await self._limiter.allow(
            provider.name, self._settings.provider_rate_limit_per_minute, cost
        ):
            log.warning("providers.skipped_rate_limited", provider=provider.name, cost=cost)
            return False
        return True

    async def history(self, symbol: str, days: int) -> list[DailyClose]:
        """Daily closes from the first provider that has any.

        Unlike quotes, the chain does not merge partial answers: a series
        stitched from two providers would mix their conventions for what a close
        is, and a rule computing a daily return across the seam would be
        measuring the difference between two definitions rather than a move.

        Cached for the history TTL. A backfill re-run within that window is the
        normal case - it happens whenever a holding is added - and it should cost
        nothing.
        """
        symbol = symbol.strip().upper()
        cache_key = f"history:{symbol}:{days}"
        cached = await self._cache.get(cache_key)
        if cached is not None:
            return [DailyClose.model_validate(item) for item in cached]

        for provider in self._providers:
            if not await self._limiter.allow(
                provider.name, self._settings.provider_rate_limit_per_minute
            ):
                log.warning("providers.skipped_rate_limited", provider=provider.name)
                continue
            try:
                closes = await provider.history(symbol, days)
            except ProviderError as exc:
                log.warning("providers.history_failed", provider=provider.name, error=str(exc))
                continue
            if closes:
                await self._cache.set(
                    cache_key,
                    [close.model_dump(mode="json") for close in closes],
                    self._settings.cache_ttl_history,
                )
                return closes

        log.info("providers.no_history", symbol=symbol)
        return []

    async def resolve(self, query: str) -> InstrumentResolution:
        cache_key = f"resolve:{query.strip().lower()}"
        cached = await self._cache.get(cache_key)
        if cached:
            return InstrumentResolution.model_validate(cached)

        best = InstrumentResolution(
            query=query, confidence=0.0, reason="no provider could resolve this symbol"
        )
        for provider in self._providers:
            try:
                result = await provider.resolve(query)
            except ProviderError as exc:
                log.warning("providers.resolve_failed", provider=provider.name, error=str(exc))
                continue
            if result.resolved is not None:
                await self._cache.set(
                    cache_key, result.model_dump(mode="json"), self._settings.cache_ttl_history
                )
                return result
            # Keep the richest unresolved answer so the UI can still offer candidates.
            if result.candidates and not best.candidates:
                best = result
        return best

    async def fx_rate(self, base: str, quote: str) -> FxRate | None:
        base, quote = base.upper(), quote.upper()
        if base == quote:
            provider = self._providers[0]
            return await provider.fx_rate(base, quote)
        cache_key = f"fx:{base}:{quote}"
        cached = await self._cache.get(cache_key)
        if cached:
            return FxRate.model_validate(cached)
        for provider in self._providers:
            try:
                rate = await provider.fx_rate(base, quote)
            except Exception as exc:  # noqa: BLE001
                log.warning("providers.fx_failed", provider=provider.name, error=str(exc))
                continue
            if rate is not None:
                await self._cache.set(
                    cache_key, rate.model_dump(mode="json"), self._settings.cache_ttl_quote * 10
                )
                return rate
        log.warning("providers.fx_unavailable", base=base, quote=quote)
        return None


def _dedupe_upper(symbols: list[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for symbol in symbols:
        key = symbol.strip().upper()
        if key and key not in seen:
            seen.add(key)
            ordered.append(key)
    return ordered
