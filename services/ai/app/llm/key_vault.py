"""Encryption at rest for the API keys users save (D206, D208).

A user's own OpenRouter key is the one secret this system stores in its
database, an exception to guideline 9 that the user approved on these terms:
encrypted with a key that lives only in `.env` / a Kubernetes Secret, never
sent to the browser, shown only as its last four characters.

`LLM_KEY_ENCRYPTION_KEYS` is a comma-separated list of Fernet keys (the
`cryptography` package: AES-128-CBC with an HMAC-SHA256, so a tampered or
truncated token fails to decrypt rather than decrypting to garbage). **The
first encrypts; every one decrypts** (`MultiFernet`), which is the rotation:
put a new key first, run `scripts/reencrypt_llm_keys.py`, then drop the old one.

Unset, the feature is off: saving is refused and saved keys are not used, so
their owners run under their monthly cap. Set but malformed, the service
refuses to start (`config.py`) - a typo must not read as "feature off".
"""

from __future__ import annotations

from collections.abc import Sequence

from cryptography.fernet import Fernet, InvalidToken, MultiFernet


class KeyVaultError(RuntimeError):
    """A stored token could not be decrypted with any configured key."""


class KeyVault:
    def __init__(self, keys: Sequence[str]) -> None:
        if not keys:
            raise ValueError("a key vault needs at least one key")
        # Fernet raises ValueError on a key that is not 32 url-safe base64 bytes.
        self._fernet = MultiFernet([Fernet(key.encode()) for key in keys])

    def encrypt(self, secret: str) -> str:
        return self._fernet.encrypt(secret.encode()).decode()

    def decrypt(self, token: str) -> str:
        try:
            return self._fernet.decrypt(token.encode()).decode()
        except InvalidToken as error:
            # The token is not echoed: it is ciphertext of a secret.
            raise KeyVaultError("no configured key decrypts this token") from error

    def rotate(self, token: str) -> str:
        """The same secret, encrypted with the first key."""
        try:
            return self._fernet.rotate(token.encode()).decode()
        except InvalidToken as error:
            raise KeyVaultError("no configured key decrypts this token") from error


def parse_keys(setting: str) -> list[str]:
    return [key.strip() for key in setting.split(",") if key.strip()]


def build_vault(setting: str) -> KeyVault | None:
    """The vault `LLM_KEY_ENCRYPTION_KEYS` describes; None when it is empty. Raises
    ValueError on a malformed key."""
    keys = parse_keys(setting)
    return KeyVault(keys) if keys else None
