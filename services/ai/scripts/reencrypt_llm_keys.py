"""Re-encrypt every saved user OpenRouter key with the first LLM_KEY_ENCRYPTION_KEYS key.

    python scripts/reencrypt_llm_keys.py

The rotation (D208): put a new Fernet key first in `LLM_KEY_ENCRYPTION_KEYS`,
keeping the old one after it, restart the AI service, run this, then remove the
old key. Until this has run, the old key is still needed - removing it first
leaves the keys it encrypted unreadable, and their owners back on the cap.

Safe to run repeatedly: a key already under the first key is rewritten to the
same secret. It prints counts, never a key. Exits 1 when a saved key could not
be decrypted with any configured key.
"""

from __future__ import annotations

from app.config import get_settings
from app.db import get_engine
from app.llm.key_vault import build_vault
from app.llm.own_key import DatabaseOwnKeyStore


def main() -> int:
    vault = build_vault(get_settings().llm_key_encryption_keys)
    if vault is None:
        print("LLM_KEY_ENCRYPTION_KEYS is not set; nothing to re-encrypt with")
        return 1
    rewritten, unreadable = DatabaseOwnKeyStore(get_engine(), vault).reencrypt_all()
    print(f"re-encrypted {rewritten} key(s); {unreadable} could not be decrypted")
    return 1 if unreadable else 0


if __name__ == "__main__":
    raise SystemExit(main())
