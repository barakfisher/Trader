"""The monthly cap's ledger against real `users` and `llm_calls` (D157, D203)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.llm.monthly_cap import DatabaseCapLedger, month_bounds

ZONE = "Asia/Jerusalem"
NOW = datetime(2026, 11, 10, 12, tzinfo=UTC)
CAP = 5_000_000


def _user(engine: Engine, cap: int | None, role: str = "user") -> str:
    with engine.begin() as connection:
        return connection.execute(
            text(
                "INSERT INTO users (role, status, llm_cap_micro_usd, timezone) "
                "VALUES (:role, 'active', :cap, :zone) RETURNING id::text"
            ),
            {"role": role, "cap": cap, "zone": ZONE},
        ).scalar_one()


def _call(engine: Engine, user: str, at: datetime, cost: int) -> None:
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO llm_calls (user_id, purpose, provider, outcome, latency_ms, prompt, "
                "cost_micro_usd, started_at) VALUES (CAST(:u AS uuid), 'ask', 'openrouter', 'ok', "
                "1, 'p', :cost, :at)"
            ),
            {"u": user, "cost": cost, "at": at},
        )


def test_spent_is_the_users_calls_since_their_month_began(migrated: Engine) -> None:
    user = _user(migrated, CAP)
    other = _user(migrated, CAP)
    start, following = month_bounds(NOW, ZONE)
    _call(migrated, user, start - timedelta(seconds=1), 700)  # last month, in their zone
    _call(migrated, user, start, 11)
    _call(migrated, user, NOW, 22)
    _call(migrated, other, NOW, 4000)  # someone else's

    month = DatabaseCapLedger(migrated).month(user, NOW)

    assert month is not None
    assert (month.cap_micro_usd, month.spent_micro_usd, month.resets_at) == (CAP, 33, following)


def test_a_user_without_a_cap_has_no_month(migrated: Engine) -> None:
    admin = _user(migrated, None, role="admin")
    _call(migrated, admin, NOW, CAP)
    assert DatabaseCapLedger(migrated).month(admin, NOW) is None
