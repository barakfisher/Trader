"""The safety limit's ledger against real `users`, `user_settings` and `llm_calls` (D250)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.llm.monthly_cap import DatabaseSafetyLimitLedger, month_bounds

ZONE = "Asia/Jerusalem"
NOW = datetime(2026, 11, 10, 12, tzinfo=UTC)
LIMIT = 5_000_000
#: Any active non-admin needs a cap while the retired column's CHECK stands (D274).
RETIRED_CAP = 0


def _user(engine: Engine, limit: int | None, role: str = "user") -> str:
    with engine.begin() as connection:
        user = connection.execute(
            text(
                "INSERT INTO users (role, status, llm_cap_micro_usd, timezone) "
                "VALUES (:role, 'active', :cap, :zone) RETURNING id::text"
            ),
            {"role": role, "cap": None if role == "admin" else RETIRED_CAP, "zone": ZONE},
        ).scalar_one()
        connection.execute(
            text(
                "INSERT INTO user_settings (user_id, llm_safety_limit_micro_usd) "
                "VALUES (CAST(:u AS uuid), :limit)"
            ),
            {"u": user, "limit": limit},
        )
    return user


def _call(engine: Engine, user: str, at: datetime, cost: int, paid_by: str = "own_key") -> None:
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO llm_calls (user_id, purpose, provider, outcome, latency_ms, prompt, "
                "cost_micro_usd, started_at, paid_by) VALUES (CAST(:u AS uuid), 'ask', "
                "'openrouter', 'ok', 1, 'p', :cost, :at, :paid_by)"
            ),
            {"u": user, "cost": cost, "at": at, "paid_by": paid_by},
        )


def test_spent_is_the_users_own_key_calls_since_their_month_began(migrated: Engine) -> None:
    user = _user(migrated, LIMIT)
    other = _user(migrated, LIMIT)
    start, following = month_bounds(NOW, ZONE)
    _call(migrated, user, start - timedelta(seconds=1), 700)  # last month, in their zone
    _call(migrated, user, start, 11)
    _call(migrated, user, NOW, 22)
    _call(migrated, user, NOW, 900, paid_by="installation")  # before D245: not their key
    _call(migrated, other, NOW, 4000)  # someone else's

    month = DatabaseSafetyLimitLedger(migrated).month(user, NOW)

    assert month is not None
    assert (month.cap_micro_usd, month.spent_micro_usd, month.resets_at) == (LIMIT, 33, following)


def test_a_user_without_a_limit_has_no_month(migrated: Engine) -> None:
    user = _user(migrated, None)
    _call(migrated, user, NOW, LIMIT)
    assert DatabaseSafetyLimitLedger(migrated).month(user, NOW) is None
