"""A user's own OpenRouter key: checked on save, stored encrypted, used for their calls.

**While a user has a working key of their own, their model calls are made with
it and nothing of the installation's applies to them** (D206): not their
monthly cap (D157) and not the installation's daily guard (`LLM_DAILY_BUDGET_USD`,
D210) - both bound the installation's bill, and these calls are not on it. The
smaller daily limits underneath, each agent's allowance and the assistant's,
still apply: they stop a runaway loop, whoever pays.

`OwnKeyProvider` sits inside the recorder and outside the cap (`factory.py`):

    ChoosingProvider(RecordingProvider(OwnKeyProvider(
        MonthlyCapProvider(BudgetedProvider(installation adapter)),
        own key -> OpenAICompatibleProvider(with that key))))

For each call with a user it looks up a key marked `valid`; with one, the call
goes to an adapter built with that key (cheap: the adapter builds a client per
call anyway), and the completion - or the error - is marked `paid_by="own_key"`
so the recorder writes it and the cap leaves it out of the month's sum (D209).

**A key OpenRouter refuses** (401: revoked or wrong; 402: out of credit) is
marked failed and that one call fails with `OwnKeyFailedError` (D207): a scan
or an `/ask` reply ends as `own_key_failed`, narration falls back to its
template. From the next call on the user has no valid key, so they run on the
installation's key under their cap until they save one that works. The call is
not retried on the installation's key: the user is told, not quietly moved.

A key that cannot be read (database down, or no configured key decrypts it)
is treated as no key: the call takes the cap's path, which fails closed on its
own when the database is down.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, replace
from datetime import datetime
from typing import Literal, Protocol

import httpx
from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.core.logging import get_logger
from app.llm.base import (
    Caller,
    LLMCompletion,
    LLMError,
    LLMProvider,
    LLMRequestError,
    Message,
    OwnKeyFailedError,
    ToolSpec,
    Verdict,
)
from app.llm.key_vault import KeyVault, KeyVaultError

log = get_logger("llm.own_key")

#: How OpenRouter says a key is unusable: 401 a key it does not accept, 402 an
#: account with no credit left. Anything else (a timeout, a 5xx, a 429) is about
#: this call, not the key, and is an ordinary provider error.
KeyFailure = Literal["rejected", "no_credit"]
KEY_FAILURES: dict[int, KeyFailure] = {401: "rejected", 402: "no_credit"}

KeyStatus = Literal["valid", "failed"]

#: Shown in place of the key: its last four characters, and nothing else ever leaves.
LAST_CHARACTERS = 4

_CHECK_TIMEOUT_SECONDS = 10.0


@dataclass(frozen=True)
class SavedKey:
    """What may be said about a saved key. Never the key itself."""

    last_four: str
    status: KeyStatus
    saved_at: datetime
    failed_at: datetime | None
    failure: KeyFailure | None


@dataclass(frozen=True)
class UsableKey:
    api_key: str
    #: The stored ciphertext, so marking it failed cannot hit a key saved since.
    token: str


class OwnKeyStore(Protocol):
    def usable_key(self, user_id: str) -> UsableKey | None:
        """The user's key when it is marked valid and decrypts. May raise."""
        ...

    def mark_failed(self, user_id: str, token: str, failure: KeyFailure) -> None:
        """Mark this stored key failed, unless another has replaced it. May raise."""
        ...


class DatabaseOwnKeyStore:
    """`user_llm_keys`: one row a user, the key encrypted by the vault (D208).

    Without a vault (`LLM_KEY_ENCRYPTION_KEYS` unset) a saved key can still be
    described and removed, but is never used and nothing can be saved.
    """

    def __init__(self, engine: Engine, vault: KeyVault | None) -> None:
        self._engine = engine
        self._vault = vault

    @property
    def can_save(self) -> bool:
        return self._vault is not None

    def usable_key(self, user_id: str) -> UsableKey | None:
        if self._vault is None:
            return None
        with self._engine.connect() as connection:
            token = connection.execute(
                text(
                    "SELECT ciphertext FROM user_llm_keys"
                    " WHERE user_id = CAST(:user AS uuid) AND status = 'valid'"
                ),
                {"user": user_id},
            ).scalar_one_or_none()
        if token is None:
            return None
        try:
            return UsableKey(self._vault.decrypt(token), token)
        except KeyVaultError:
            # A removed encryption key: loud, and the user falls back to the cap.
            log.error("llm.own_key_undecryptable", user_id=user_id)
            return None

    def mark_failed(self, user_id: str, token: str, failure: KeyFailure) -> None:
        with self._engine.begin() as connection:
            connection.execute(
                text(
                    """
                    UPDATE user_llm_keys
                       SET status = 'failed', failed_at = now(), failure = :failure
                     WHERE user_id = CAST(:user AS uuid) AND ciphertext = :token
                       AND status = 'valid'
                    """
                ),
                {"user": user_id, "token": token, "failure": failure},
            )

    def saved(self, user_id: str) -> SavedKey | None:
        with self._engine.connect() as connection:
            row = connection.execute(
                text(
                    "SELECT last_four, status, saved_at, failed_at, failure FROM user_llm_keys"
                    " WHERE user_id = CAST(:user AS uuid)"
                ),
                {"user": user_id},
            ).one_or_none()
        if row is None:
            return None
        return SavedKey(row.last_four, row.status, row.saved_at, row.failed_at, row.failure)

    def save(self, user_id: str, api_key: str) -> SavedKey:
        """Store a key OpenRouter has just accepted, replacing any saved before."""
        if self._vault is None:
            raise KeyVaultError("LLM_KEY_ENCRYPTION_KEYS is not set")
        with self._engine.begin() as connection:
            row = connection.execute(
                text(
                    """
                    INSERT INTO user_llm_keys (user_id, ciphertext, last_four)
                    VALUES (CAST(:user AS uuid), :token, :last_four)
                    ON CONFLICT (user_id) DO UPDATE
                       SET ciphertext = EXCLUDED.ciphertext, last_four = EXCLUDED.last_four,
                           status = 'valid', saved_at = now(), failed_at = NULL, failure = NULL
                    RETURNING last_four, status, saved_at, failed_at, failure
                    """
                ),
                {
                    "user": user_id,
                    "token": self._vault.encrypt(api_key),
                    "last_four": api_key[-LAST_CHARACTERS:],
                },
            ).one()
        return SavedKey(row.last_four, row.status, row.saved_at, row.failed_at, row.failure)

    def remove(self, user_id: str) -> bool:
        with self._engine.begin() as connection:
            removed = connection.execute(
                text("DELETE FROM user_llm_keys WHERE user_id = CAST(:user AS uuid)"),
                {"user": user_id},
            ).rowcount
        return bool(removed)

    def reencrypt_all(self) -> tuple[int, int]:
        """Every stored key under the vault's first key: (rewritten, unreadable)."""
        if self._vault is None:
            raise KeyVaultError("LLM_KEY_ENCRYPTION_KEYS is not set")
        rewritten = unreadable = 0
        with self._engine.begin() as connection:
            rows = connection.execute(
                text("SELECT user_id, ciphertext FROM user_llm_keys FOR UPDATE")
            ).all()
            for row in rows:
                try:
                    token = self._vault.rotate(row.ciphertext)
                except KeyVaultError:
                    unreadable += 1
                    log.error("llm.own_key_undecryptable", user_id=str(row.user_id))
                    continue
                connection.execute(
                    text("UPDATE user_llm_keys SET ciphertext = :token WHERE user_id = :user"),
                    {"token": token, "user": row.user_id},
                )
                rewritten += 1
        return rewritten, unreadable


KeyCheck = Literal["valid", "rejected", "unreachable"]


class KeyChecker(Protocol):
    async def check(self, api_key: str) -> KeyCheck:
        """Whether OpenRouter accepts this key. Never raises."""
        ...


class OpenRouterKeyChecker:
    """`GET /key`: OpenRouter's description of the key that asks. Free, and 401
    for a key it does not accept - the check made before a key is saved."""

    def __init__(self, base_url: str, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._url = f"{base_url.rstrip('/')}/key"
        self._transport = transport

    async def check(self, api_key: str) -> KeyCheck:
        try:
            async with httpx.AsyncClient(
                timeout=_CHECK_TIMEOUT_SECONDS, transport=self._transport
            ) as client:
                # Sent to the provider it belongs to; logged nowhere (guideline 9).
                response = await client.get(
                    self._url, headers={"authorization": f"Bearer {api_key}"}
                )
        except httpx.HTTPError as error:
            log.warning("llm.own_key_check_unreachable", error=type(error).__name__)
            return "unreachable"
        if response.status_code == 200:
            return "valid"
        if response.status_code in (401, 403):
            return "rejected"
        log.warning("llm.own_key_check_unexpected", status=response.status_code)
        return "unreachable"


AdapterFactory = Callable[[str], LLMProvider]


class OwnKeyProvider:
    """Sends a user's calls to their own key while they have a valid one."""

    def __init__(self, inner: LLMProvider, store: OwnKeyStore, adapter: AdapterFactory) -> None:
        self._inner = inner
        self._store = store
        self._adapter = adapter
        self.name = inner.name
        self.charges_per_token = inner.charges_per_token

    async def complete(
        self,
        *,
        system: str | None,
        user: str,
        max_output_tokens: int | None = None,
        temperature: float | None = None,
        reasoning_effort: str | None = None,
        caller: Caller | None = None,
        model: str | None = None,
    ) -> LLMCompletion:
        return await self._routed(
            lambda provider: provider.complete(
                system=system,
                user=user,
                max_output_tokens=max_output_tokens,
                temperature=temperature,
                reasoning_effort=reasoning_effort,
                caller=caller,
                model=model,
            ),
            caller,
        )

    async def converse(
        self,
        *,
        system: str,
        messages: Sequence[Message],
        tools: Sequence[ToolSpec],
        max_output_tokens: int | None = None,
        temperature: float | None = None,
        reasoning_effort: str | None = None,
        caller: Caller | None = None,
        model: str | None = None,
    ) -> LLMCompletion:
        return await self._routed(
            lambda provider: provider.converse(
                system=system,
                messages=messages,
                tools=tools,
                max_output_tokens=max_output_tokens,
                temperature=temperature,
                reasoning_effort=reasoning_effort,
                caller=caller,
                model=model,
            ),
            caller,
        )

    async def _routed(
        self,
        call: Callable[[LLMProvider], Awaitable[LLMCompletion]],
        caller: Caller | None,
    ) -> LLMCompletion:
        user_id = caller.user_id if caller is not None else None
        key = self._key_for(user_id)
        if user_id is None or key is None:
            return await call(self._inner)
        try:
            completion = await call(self._adapter(key.api_key))
        except LLMRequestError as error:
            failure = KEY_FAILURES.get(error.status_code or 0)
            if failure is None:
                error.paid_by = "own_key"
                raise
            self._mark_failed(user_id, key, failure)
            raise OwnKeyFailedError(
                error.provider,
                f"the user's own key was refused ({failure})",
                status_code=error.status_code,
                metered_micro_usd=error.metered_micro_usd,
            ) from error
        except LLMError as error:
            error.paid_by = "own_key"
            raise
        return replace(completion, paid_by="own_key")

    def _key_for(self, user_id: str | None) -> UsableKey | None:
        if user_id is None:
            return None
        try:
            return self._store.usable_key(user_id)
        except Exception as error:  # noqa: BLE001 - the cap's path is the safe one
            log.error("llm.own_key_unreadable", user_id=user_id, error=str(error))
            return None

    def _mark_failed(self, user_id: str, key: UsableKey, failure: KeyFailure) -> None:
        log.warning("llm.own_key_failed", user_id=user_id, failure=failure)
        try:
            self._store.mark_failed(user_id, key.token, failure)
        except Exception as error:  # noqa: BLE001 - the call has failed either way
            log.error("llm.own_key_not_marked", user_id=user_id, error=str(error))

    async def record_verdict(self, call_id: int | None, verdict: Verdict) -> None:
        await self._inner.record_verdict(call_id, verdict)
