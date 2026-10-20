"""An agent's schedule in three parts: every N hours, before the open, after the close (D195).

`agents.scan_schedule` named one of four fixed schedules (0042, D46). The user
asked for "once every ___ hours" during market hours, combinable with the
pre-open and post-close scans, and for all of it off - the agent then scans only
when asked. Three typed columns replace the name:

- **`scan_every_hours`** - hours between market-hours scans from 10:00 New
  York, 1 to 6; null for none. 1 runs six (10:00-15:00), 6 runs one.
- **`scan_pre_open`**, **`scan_post_close`** - the two edges, on their own.

The four old schedules map exactly - `intraday_twice` (10:00, 14:00) is every
4 hours and `intraday_once` (10:00) every 6 - so an existing agent scans at the
same times after the upgrade as before it, and its slots keep their names
(`ny_1000`, `ny_1400`), which are part of each attempt's run key.

The downgrade maps back where a schedule has an old name and refuses where it
has none, rather than silently moving an agent's scans.

Revision ID: 0060_scan_every_hours
Revises: 0059_mandate_check
"""

from alembic import op

revision = "0060_scan_every_hours"
down_revision = "0059_mandate_check"
branch_labels = None
depends_on = None

#: `MIN_SCAN_EVERY_HOURS` / `MAX_SCAN_EVERY_HOURS` in `packages/shared/src/types.ts`.
MIN_EVERY_HOURS = 1
MAX_EVERY_HOURS = 6

#: 0042's schedules, as (every hours, pre-open, post-close).
OLD_SCHEDULES = {
    "pre_open": ("NULL", "true", "false"),
    "pre_open_post_close": ("NULL", "true", "true"),
    "intraday_twice": ("4", "false", "false"),
    "intraday_once": ("6", "false", "false"),
}
SCAN_SCHEDULES = tuple(OLD_SCHEDULES)


def _sql_list(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def upgrade() -> None:
    op.execute(
        "ALTER TABLE agents ADD COLUMN scan_every_hours smallint "
        f"CHECK (scan_every_hours BETWEEN {MIN_EVERY_HOURS} AND {MAX_EVERY_HOURS})"
    )
    op.execute("ALTER TABLE agents ADD COLUMN scan_pre_open boolean NOT NULL DEFAULT true")
    op.execute("ALTER TABLE agents ADD COLUMN scan_post_close boolean NOT NULL DEFAULT false")
    for name, (every, pre_open, post_close) in OLD_SCHEDULES.items():
        op.execute(
            f"UPDATE agents SET scan_every_hours = {every}, scan_pre_open = {pre_open}, "
            f"scan_post_close = {post_close} WHERE scan_schedule = '{name}'"
        )
    op.execute("ALTER TABLE agents DROP COLUMN scan_schedule")


def downgrade() -> None:
    cases = " ".join(
        f"WHEN scan_every_hours IS NOT DISTINCT FROM {every} AND scan_pre_open = {pre_open} "
        f"AND scan_post_close = {post_close} THEN '{name}'"
        for name, (every, pre_open, post_close) in OLD_SCHEDULES.items()
    )
    op.execute(
        f"""
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM agents WHERE NOT is_primary
                         AND (CASE {cases} END) IS NULL) THEN
                RAISE EXCEPTION 'an agent has a schedule 0042 cannot name (every N hours other '
                    'than 4 or 6, combined with an edge, or none at all); set it to one of '
                    'pre_open, pre_open_post_close, every 4 or every 6 hours first';
            END IF;
        END;
        $$
        """
    )
    op.execute(
        "ALTER TABLE agents ADD COLUMN scan_schedule text NOT NULL DEFAULT 'pre_open' "
        f"CHECK (scan_schedule IN ({_sql_list(SCAN_SCHEDULES)}))"
    )
    op.execute(f"UPDATE agents SET scan_schedule = CASE {cases} ELSE 'pre_open' END")
    op.execute("ALTER TABLE agents DROP COLUMN scan_post_close")
    op.execute("ALTER TABLE agents DROP COLUMN scan_pre_open")
    op.execute("ALTER TABLE agents DROP COLUMN scan_every_hours")
