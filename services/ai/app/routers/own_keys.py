"""`/llm/own-keys/{user_id}`: a user's own OpenRouter key - read, saved, removed (D206).

The orchestrator owns the session and calls this for the user it authenticated,
and refuses the admin, who runs on the installation's key. This service owns
the table because it alone holds the encryption key (D208): the orchestrator
never sees a saved key, and nothing here ever answers with one - only its last
four characters, whether it works, and since when it does not.

A key is checked against OpenRouter before it is stored: a key OpenRouter
refuses is never saved, and one that cannot be checked is not saved either.
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.config import Settings
from app.deps import SettingsDep, require_internal_key
from app.llm.factory import models_are_choosable
from app.llm.own_key import DatabaseOwnKeyStore, KeyChecker, OpenRouterKeyChecker, SavedKey
from app.models import OwnLlmKey, OwnLlmKeySave, OwnLlmKeyState

router = APIRouter(
    prefix="/llm/own-keys", tags=["llm"], dependencies=[Depends(require_internal_key)]
)

#: The shape of anything worth sending to OpenRouter: OpenRouter's keys are
#: `sk-or-v1-` and 64 hex characters, but the check that decides is theirs.
MIN_KEY_LENGTH = 16
MAX_KEY_LENGTH = 256


def get_own_keys(request: Request) -> DatabaseOwnKeyStore:
    return request.app.state.own_keys


def get_key_checker(settings: SettingsDep) -> KeyChecker:
    return OpenRouterKeyChecker(settings.openrouter_base_url)


OwnKeys = Annotated[DatabaseOwnKeyStore, Depends(get_own_keys)]
Checker = Annotated[KeyChecker, Depends(get_key_checker)]


def _available(settings: Settings, store: DatabaseOwnKeyStore) -> bool:
    return store.can_save and models_are_choosable(settings)


def _state(
    settings: Settings, store: DatabaseOwnKeyStore, saved: SavedKey | None
) -> OwnLlmKeyState:
    return OwnLlmKeyState(
        available=_available(settings, store),
        key=saved
        and OwnLlmKey(
            last_four=saved.last_four,
            status=saved.status,
            saved_at=saved.saved_at,
            failed_at=saved.failed_at,
            failure=saved.failure,
        ),
    )


def _refuse(code: int, reason: str, message: str) -> HTTPException:
    return HTTPException(code, {"code": reason, "message": message})


@router.get("/{user_id}", response_model=OwnLlmKeyState)
async def own_key(user_id: UUID, settings: SettingsDep, store: OwnKeys) -> OwnLlmKeyState:
    return _state(settings, store, store.saved(str(user_id)))


@router.put("/{user_id}", response_model=OwnLlmKeyState)
async def save_own_key(
    user_id: UUID,
    payload: OwnLlmKeySave,
    settings: SettingsDep,
    store: OwnKeys,
    checker: Checker,
) -> OwnLlmKeyState:
    if not _available(settings, store):
        raise _refuse(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "own_keys_unavailable",
            "this installation does not use users' own keys",
        )
    api_key = payload.api_key.get_secret_value().strip()
    if not MIN_KEY_LENGTH <= len(api_key) <= MAX_KEY_LENGTH or any(c.isspace() for c in api_key):
        raise _refuse(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "key_malformed", "that is not an API key"
        )
    checked = await checker.check(api_key)
    if checked == "rejected":
        raise _refuse(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "key_rejected", "OpenRouter refused this key"
        )
    if checked == "unreachable":
        raise _refuse(
            status.HTTP_502_BAD_GATEWAY,
            "key_check_unreachable",
            "OpenRouter could not be asked about this key",
        )
    return _state(settings, store, store.save(str(user_id), api_key))


@router.delete("/{user_id}", response_model=OwnLlmKeyState)
async def remove_own_key(user_id: UUID, settings: SettingsDep, store: OwnKeys) -> OwnLlmKeyState:
    store.remove(str(user_id))
    return _state(settings, store, None)
