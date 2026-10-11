"""`pg_stat_statements` is the operator's, not the application's (migration 0050).

The extension grants its views to `PUBLIC`, and 0033's default privileges would
grant them to `traders_app` too; the migration revokes both. `has_table_privilege`
counts `PUBLIC`, which is why a revoke from the role alone was not enough.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Engine

APP_ROLE = "traders_app"


@pytest.mark.parametrize("view", ["pg_stat_statements", "pg_stat_statements_info"])
def test_the_application_role_cannot_read_query_statistics(migrated: Engine, view: str) -> None:
    with migrated.connect() as connection:
        readable = connection.execute(
            text("SELECT has_table_privilege(:role, :view, 'SELECT')"),
            {"role": APP_ROLE, "view": view},
        ).scalar_one()
    assert readable is False
