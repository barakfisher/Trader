"""Users' own keys against the real `user_llm_keys` and `llm_calls` (D206-D209)."""

from __future__ import annotations

from datetime import UTC, datetime

from cryptography.fernet import Fernet
from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.llm.call_log import CallEntry, DatabaseCallLog
from app.llm.key_vault import KeyVault
from app.llm.monthly_cap import MIN_RETENTION_DAYS, DatabaseCapLedger
from app.llm.own_key import DatabaseOwnKeyStore

KEY = "sk-or-v1-" + "b" * 56 + "9f3e"
NEWER = "sk-or-v1-" + "c" * 56 + "77aa"


def _user(engine: Engine) -> str:
    with engine.begin() as connection:
        return connection.execute(
            text(
                "INSERT INTO users (role, status, llm_cap_micro_usd, timezone) "
                "VALUES ('user', 'active', 5000000, 'Asia/Jerusalem') RETURNING id::text"
            )
        ).scalar_one()


def _vault() -> KeyVault:
    return KeyVault([Fernet.generate_key().decode()])


def test_a_saved_key_is_stored_encrypted_and_described_by_its_last_four(migrated: Engine) -> None:
    user = _user(migrated)
    store = DatabaseOwnKeyStore(migrated, _vault())

    saved = store.save(user, KEY)

    assert (saved.last_four, saved.status, saved.failure) == ("9f3e", "valid", None)
    with migrated.connect() as connection:
        stored = connection.execute(text("SELECT ciphertext FROM user_llm_keys")).scalar_one()
    assert KEY not in stored
    usable = store.usable_key(user)
    assert usable is not None and usable.api_key == KEY


def test_a_failed_key_is_not_used_and_a_new_one_replaces_it(migrated: Engine) -> None:
    user = _user(migrated)
    store = DatabaseOwnKeyStore(migrated, _vault())
    store.save(user, KEY)
    usable = store.usable_key(user)
    assert usable is not None

    store.mark_failed(user, usable.token, "no_credit")

    assert store.usable_key(user) is None
    failed = store.saved(user)
    assert failed is not None
    assert (failed.status, failed.failure, failed.failed_at is not None) == (
        "failed",
        "no_credit",
        True,
    )
    replaced = store.save(user, NEWER)
    assert (replaced.status, replaced.failure, replaced.failed_at) == ("valid", None, None)


def test_marking_an_old_key_failed_leaves_one_saved_since_alone(migrated: Engine) -> None:
    user = _user(migrated)
    store = DatabaseOwnKeyStore(migrated, _vault())
    store.save(user, KEY)
    old = store.usable_key(user)
    assert old is not None
    store.save(user, NEWER)

    store.mark_failed(user, old.token, "rejected")

    current = store.usable_key(user)
    assert current is not None and current.api_key == NEWER


def test_a_key_no_configured_key_decrypts_is_not_used(migrated: Engine) -> None:
    user = _user(migrated)
    DatabaseOwnKeyStore(migrated, _vault()).save(user, KEY)
    assert DatabaseOwnKeyStore(migrated, _vault()).usable_key(user) is None
    assert DatabaseOwnKeyStore(migrated, None).usable_key(user) is None


def test_reencrypting_moves_every_key_to_the_first_vault_key(migrated: Engine) -> None:
    with migrated.begin() as connection:
        # Keys other tests saved under vaults of their own would count as unreadable.
        connection.execute(text("DELETE FROM user_llm_keys"))
    user = _user(migrated)
    old, new = Fernet.generate_key().decode(), Fernet.generate_key().decode()
    DatabaseOwnKeyStore(migrated, KeyVault([old])).save(user, KEY)

    assert DatabaseOwnKeyStore(migrated, KeyVault([new, old])).reencrypt_all() == (1, 0)

    usable = DatabaseOwnKeyStore(migrated, KeyVault([new])).usable_key(user)
    assert usable is not None and usable.api_key == KEY


def test_removing_a_key_and_removing_the_user(migrated: Engine) -> None:
    user = _user(migrated)
    store = DatabaseOwnKeyStore(migrated, _vault())
    store.save(user, KEY)
    assert store.remove(user) is True
    assert store.saved(user) is None and store.remove(user) is False

    store.save(user, KEY)
    with migrated.begin() as connection:
        connection.execute(text("DELETE FROM users WHERE id = CAST(:u AS uuid)"), {"u": user})
    assert store.saved(user) is None


def test_the_cap_sums_only_what_the_installation_paid_for(migrated: Engine) -> None:
    user = _user(migrated)
    log = DatabaseCallLog(migrated, MIN_RETENTION_DAYS)
    for paid_by, cost in (("installation", 300), ("own_key", 9_000_000)):
        log.record(
            CallEntry(
                purpose="ask",
                user_id=user,
                agent_id=None,
                provider="openrouter",
                model="m",
                outcome="ok",
                error=None,
                latency_ms=1,
                prompt_tokens=1,
                completion_tokens=1,
                cost_micro_usd=cost,
                prompt="p",
                completion="c",
                paid_by=paid_by,  # type: ignore[arg-type]
            )
        )

    month = DatabaseCapLedger(migrated).month(user, datetime.now(UTC))

    assert month is not None and month.spent_micro_usd == 300
