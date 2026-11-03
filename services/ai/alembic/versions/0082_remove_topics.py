"""Topics are removed: the page, the proposals, the scans and their tables (D371-D375).

FR-10/FR-11 built a theme the user follows (`topics`, `topic_instruments`, 0017)
and proposals discovered from the news (0019, 0021, 0024). Measured 2026-11-02:
no topic was ever confirmed on either installation; production holds none and
compose holds 31 unanswered auto-proposals. The agents' theme search
(`resolve_topic`) reads the universe, not these tables, and stays.

- **Dropped**: `topics` and `topic_instruments` (the user: "Drop them").
- **Deleted**: runs of kind `topic_scan` and `topic_discovery` - history of a
  feature that no longer exists (compose ~2,260, production ~270). Their kinds
  stay in `runs_kind_check`: kinds are only ever appended
  (`test_run_kinds_contract.py`), and a kind nothing writes costs nothing.
  `observations.run_id` and `narration_transitions.run_id` are `ON DELETE SET
  NULL`, so no row elsewhere is lost with them.
- **Narrowed**: `observations.subject_kind` loses `topic` and `ops_events.kind`
  loses `universe_gap_low_confidence` (raised only by `/topics/resolve`); their
  rows are deleted first (0 and 2 on compose, 0 on production).
  `article_entities` loses the never-written topic half 0004 reserved:
  `topic_ref`, its index, and `entity_kind = 'topic'` (0 rows everywhere).
- **Redefined**: `reset_account` (0072's, as 0078 amended it) without the
  `followed_topics` group. The
  `account_resets.groups` CHECK keeps the old list on purpose: two backups on
  compose name the group, and a backup is history.

Downgrade recreates every table, column and constraint empty, as 0081 left
them, and 0078's `reset_account`. Deleted rows do not come back; the
pre-migration backup (`db-backup.sh`) holds them.

Revision ID: 0082_remove_topics
Revises: 0081_drop_admin_model_choices
"""

import importlib.util
from pathlib import Path

from alembic import op

revision = "0082_remove_topics"
down_revision = "0081_drop_admin_model_choices"
branch_labels = None
depends_on = None

APP_ROLE = "traders_app"

#: The groups a reset may erase; `ACCOUNT_RESET_GROUPS` in TypeScript is tested against it.
RESET_GROUPS = ("main_portfolio", "agents_trading")

#: 0045's groups, which the downgrade restores.
PREVIOUS_RESET_GROUPS = ("main_portfolio", "agents_trading", "followed_topics")

#: 0027's event kinds, and what is left of them.
PREVIOUS_EVENT_KINDS = ("universe_gap_missing_ticker", "universe_gap_low_confidence")
EVENT_KINDS = ("universe_gap_missing_ticker",)

#: 0003's subjects, and what is left of them.
PREVIOUS_SUBJECT_KINDS = ("instrument", "portfolio", "topic")
SUBJECT_KINDS = ("instrument", "portfolio")


def _ledger_module():
    """0078's module, whose `reset_account` (0072's, amended) this migration amends."""
    path = Path(__file__).with_name("0078_primary_ledger.py")
    spec = importlib.util.spec_from_file_location("primary_ledger_0078", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _sql_array(values: tuple[str, ...]) -> str:
    return "ARRAY[" + ", ".join(f"'{value}'" for value in values) + "]::text[]"


def _sql_list(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


_TOPICS_DECLARE = "            v_topics boolean;\n"
_TOPICS_SET = "            v_topics := 'followed_topics' = ANY (v_groups);\n"
_TOPIC_OBSERVATIONS = (
    "               AND ((v_main AND agent_id = v_primary AND subject_kind <> 'topic')\n"
    "                 OR (v_trading AND agent_id = ANY (v_simulated))\n"
    "                 OR (v_topics AND subject_kind = 'topic'));"
)
_OBSERVATIONS = (
    "               AND ((v_main AND agent_id = v_primary)\n"
    "                 OR (v_trading AND agent_id = ANY (v_simulated)));"
)
_TOPICS = """            WITH gone AS (
                DELETE FROM topic_instruments WHERE v_topics AND user_id = p_user_id RETURNING *)
            SELECT coalesce(jsonb_agg(to_jsonb(gone)), '[]') INTO v_rows FROM gone;
            v_backup := v_backup || jsonb_build_object('topic_instruments', v_rows);

            WITH gone AS (
                DELETE FROM topics WHERE v_topics AND user_id = p_user_id RETURNING *)
            SELECT coalesce(jsonb_agg(to_jsonb(gone)), '[]') INTO v_rows FROM gone;
            v_backup := v_backup || jsonb_build_object('topics', v_rows);

"""


def _reset_account(groups: tuple[str, ...]) -> str:
    """0078's `reset_account`, or - over `RESET_GROUPS` - the same without topics."""
    sql = _ledger_module()._reset_account(with_primary=True)
    if groups == PREVIOUS_RESET_GROUPS:
        return sql
    for old, new, count in (
        (_sql_array(PREVIOUS_RESET_GROUPS), _sql_array(groups), 2),
        (_TOPICS_DECLARE, "", 1),
        (_TOPICS_SET, "", 1),
        (_TOPIC_OBSERVATIONS, _OBSERVATIONS, 1),
        (_TOPICS, "", 1),
    ):
        assert sql.count(old) == count, f"0078's reset_account no longer contains {old!r}"
        sql = sql.replace(old, new)
    return sql


def upgrade() -> None:
    op.execute("DROP TABLE topic_instruments")
    op.execute("DROP TABLE topics")

    op.execute("DELETE FROM runs WHERE kind IN ('topic_scan', 'topic_discovery')")

    op.execute("DELETE FROM observations WHERE subject_kind = 'topic'")
    op.execute("ALTER TABLE observations DROP CONSTRAINT observations_subject_kind_check")
    op.execute(
        "ALTER TABLE observations ADD CONSTRAINT observations_subject_kind_check "
        f"CHECK (subject_kind IN ({_sql_list(SUBJECT_KINDS)}))"
    )

    op.execute("DELETE FROM ops_events WHERE kind = 'universe_gap_low_confidence'")
    op.execute("ALTER TABLE ops_events DROP CONSTRAINT ops_events_kind_check")
    op.execute(
        "ALTER TABLE ops_events ADD CONSTRAINT ops_events_kind_check "
        f"CHECK (kind IN ({_sql_list(EVENT_KINDS)}))"
    )

    op.execute("DELETE FROM article_entities WHERE entity_kind = 'topic'")
    op.execute("ALTER TABLE article_entities DROP CONSTRAINT article_entities_check")
    op.execute("ALTER TABLE article_entities DROP CONSTRAINT article_entities_entity_kind_check")
    op.execute("DROP INDEX article_entities_topic_uniq")
    op.execute("ALTER TABLE article_entities DROP COLUMN topic_ref")
    op.execute(
        "ALTER TABLE article_entities ADD CONSTRAINT article_entities_entity_kind_check "
        "CHECK (entity_kind = 'instrument')"
    )
    op.execute(
        "ALTER TABLE article_entities ADD CONSTRAINT article_entities_check "
        "CHECK (instrument_id IS NOT NULL)"
    )

    op.execute(_reset_account(RESET_GROUPS))


def downgrade() -> None:
    op.execute(_reset_account(PREVIOUS_RESET_GROUPS))

    op.execute("ALTER TABLE article_entities DROP CONSTRAINT article_entities_check")
    op.execute("ALTER TABLE article_entities DROP CONSTRAINT article_entities_entity_kind_check")
    op.execute("ALTER TABLE article_entities ADD COLUMN topic_ref text")
    op.execute(
        "CREATE UNIQUE INDEX article_entities_topic_uniq "
        "ON article_entities (article_id, topic_ref) WHERE topic_ref IS NOT NULL"
    )
    op.execute(
        "ALTER TABLE article_entities ADD CONSTRAINT article_entities_entity_kind_check "
        "CHECK (entity_kind IN ('instrument', 'topic'))"
    )
    op.execute(
        """
        ALTER TABLE article_entities ADD CONSTRAINT article_entities_check CHECK (
            (entity_kind = 'instrument' AND instrument_id IS NOT NULL AND topic_ref IS NULL)
            OR
            (entity_kind = 'topic' AND topic_ref IS NOT NULL AND instrument_id IS NULL)
        )
        """
    )

    op.execute("ALTER TABLE ops_events DROP CONSTRAINT ops_events_kind_check")
    op.execute(
        "ALTER TABLE ops_events ADD CONSTRAINT ops_events_kind_check "
        f"CHECK (kind IN ({_sql_list(PREVIOUS_EVENT_KINDS)}))"
    )
    op.execute("ALTER TABLE observations DROP CONSTRAINT observations_subject_kind_check")
    op.execute(
        "ALTER TABLE observations ADD CONSTRAINT observations_subject_kind_check "
        f"CHECK (subject_kind IN ({_sql_list(PREVIOUS_SUBJECT_KINDS)}))"
    )

    # 0017's tables with 0019's, 0021's and 0024's columns, as 0081 left them.
    op.execute(
        """
        CREATE TABLE topics (
            id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            label                text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 200),
            status               text NOT NULL
                CHECK (status IN ('active', 'proposed', 'rejected', 'expired')),
            created_by           text NOT NULL CHECK (created_by IN ('user', 'auto')),
            created_at           timestamptz NOT NULL DEFAULT now(),
            updated_at           timestamptz NOT NULL DEFAULT now(),
            confirmed_at         timestamptz,
            rejected_at          timestamptz,
            match_words          text[],
            proposed_instruments uuid[],
            evidence             jsonb,
            expired_at           timestamptz,
            proposal_band        text CHECK (proposal_band IN ('confident', 'weak')),
            CONSTRAINT topics_active_is_confirmed
                CHECK (status <> 'active' OR confirmed_at IS NOT NULL),
            CONSTRAINT topics_auto_has_band
                CHECK ((created_by = 'auto') = (proposal_band IS NOT NULL)),
            CONSTRAINT topics_auto_has_fingerprint
                CHECK (created_by <> 'auto' OR (
                    match_words IS NOT NULL
                    AND proposed_instruments IS NOT NULL
                    AND evidence IS NOT NULL
                    AND jsonb_typeof(evidence) = 'object'
                )),
            CONSTRAINT topics_expired_has_time
                CHECK ((status = 'expired') = (expired_at IS NOT NULL)),
            CONSTRAINT topics_expired_is_auto CHECK (status <> 'expired' OR created_by = 'auto'),
            CONSTRAINT topics_rejected_has_time
                CHECK ((status = 'rejected') = (rejected_at IS NOT NULL)),
            CONSTRAINT topics_rejected_is_auto CHECK (status <> 'rejected' OR created_by = 'auto'),
            CONSTRAINT topics_id_user_uniq UNIQUE (id, user_id)
        )
        """
    )
    op.execute(
        "CREATE UNIQUE INDEX topics_live_label_per_user ON topics (user_id, lower(label)) "
        "WHERE status NOT IN ('rejected', 'expired')"
    )
    op.execute(
        "CREATE INDEX topics_rejected_recent ON topics (user_id, rejected_at) "
        "WHERE status = 'rejected'"
    )
    op.execute(
        """
        CREATE TABLE topic_instruments (
            topic_id      uuid NOT NULL,
            user_id       uuid NOT NULL,
            instrument_id uuid NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
            source        text NOT NULL CHECK (source IN ('resolver', 'user')),
            confidence    text CHECK (confidence IN ('confident', 'weak')),
            rationale     text,
            held_by       jsonb NOT NULL DEFAULT '[]'::jsonb,
            added_at      timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (topic_id, instrument_id),
            FOREIGN KEY (topic_id, user_id) REFERENCES topics (id, user_id) ON DELETE CASCADE,
            CONSTRAINT topic_instruments_provenance CHECK (
                (source = 'resolver' AND confidence IS NOT NULL AND rationale IS NOT NULL)
                OR
                (source = 'user' AND confidence IS NULL AND rationale IS NULL
                 AND held_by = '[]'::jsonb)
            ),
            CONSTRAINT topic_instruments_held_by_is_list CHECK (jsonb_typeof(held_by) = 'array')
        )
        """
    )
    op.execute("CREATE INDEX topic_instruments_instrument ON topic_instruments (instrument_id)")
    for table in ("topics", "topic_instruments"):
        op.execute(f"REVOKE ALL ON {table} FROM {APP_ROLE}")
        op.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO {APP_ROLE}")
