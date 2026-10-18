"""An agent's mandate: the settings the template creator writes, and `rule_rejected` (D165-D173).

**Columns on `agents`, not a table of their own.** A mandate is one per agent,
read with the agent by every scan and every page that shows one; a second table
would be a join on every read and a row that could be missing.

What the scan's code enforces (`app/agents/mandate.py`, D165), all null or empty
meaning "no limit", so every agent that exists today behaves exactly as before
until the user edits it:

- `max_position_bps`, `cash_buffer_bps`: basis points of the agent's capital,
  **cash plus holdings at cost** (D171) - figures the ledger holds exactly, so no
  unpriced holding can make the rule unanswerable. Integers, never a float
  (guideline 3).
- `max_holdings`: distinct instruments held after a buy.
- `allow_etfs`: false refuses buying an ETF.
- `market_caps`: equities by stored market cap (D172); empty means any size.
- `sectors`, `industries`, `etf_categories`: the "Sectors & industries"
  selection, names as `universe_taxonomy` holds them; all empty means anywhere.
- `blocked_symbols`: never bought. There is no allow-list (D173).

What only the prompt carries: `risk_level` (1-10, read as a five-word band,
D169), `horizon` (D166) and `thesis_style` (D170).

**The primary has no mandate** (`agents_primary_has_no_mandate`), as it has no
persona or budget (D1): it is the real portfolio, and nothing scans it.

**`rule_rejected`**, a scan outcome: the model's trade broke the mandate, and
broke it again after being told which rule (D170's one retry). Distinct from
`invalid_answer`, which is a malformed or unsourced answer; the Decisions tab
says which. The downgrade refuses while such a scan exists, rather than
relabelling what happened.

Revision ID: 0057_agent_mandate
Revises: 0056_universe_taxonomy
"""

from alembic import op

revision = "0057_agent_mandate"
down_revision = "0056_universe_taxonomy"
branch_labels = None
depends_on = None

#: 0043's outcomes; code Literals are tested against `OUTCOMES`.
PREVIOUS_OUTCOMES = (
    "trade",
    "no_trade",
    "invalid_answer",
    "budget_reached",
    "step_limit",
    "failed",
)
OUTCOMES = (*PREVIOUS_OUTCOMES, "rule_rejected")

HORIZONS = ("short", "medium", "long")
THESIS_STYLES = ("academic", "growth", "contrarian")
MARKET_CAPS = ("mega", "large", "mid", "small")


def _sql_list(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def upgrade() -> None:
    op.execute(
        f"""
        ALTER TABLE agents
            ADD COLUMN risk_level smallint CHECK (risk_level BETWEEN 1 AND 10),
            ADD COLUMN horizon text CHECK (horizon IN ({_sql_list(HORIZONS)})),
            ADD COLUMN thesis_style text CHECK (thesis_style IN ({_sql_list(THESIS_STYLES)})),
            ADD COLUMN max_position_bps integer
                CHECK (max_position_bps BETWEEN 1 AND 10000),
            ADD COLUMN cash_buffer_bps integer CHECK (cash_buffer_bps BETWEEN 0 AND 9999),
            ADD COLUMN max_holdings smallint CHECK (max_holdings BETWEEN 1 AND 100),
            ADD COLUMN allow_etfs boolean NOT NULL DEFAULT true,
            ADD COLUMN market_caps text[] NOT NULL DEFAULT '{{}}'
                CHECK (market_caps <@ ARRAY[{_sql_list(MARKET_CAPS)}]::text[]),
            ADD COLUMN sectors text[] NOT NULL DEFAULT '{{}}',
            ADD COLUMN industries text[] NOT NULL DEFAULT '{{}}',
            ADD COLUMN etf_categories text[] NOT NULL DEFAULT '{{}}',
            ADD COLUMN blocked_symbols text[] NOT NULL DEFAULT '{{}}',
            ADD CONSTRAINT agents_primary_has_no_mandate CHECK (
                NOT is_primary OR (
                    risk_level IS NULL AND horizon IS NULL AND thesis_style IS NULL
                    AND max_position_bps IS NULL AND cash_buffer_bps IS NULL
                    AND max_holdings IS NULL AND allow_etfs
                    AND market_caps = '{{}}' AND sectors = '{{}}' AND industries = '{{}}'
                    AND etf_categories = '{{}}' AND blocked_symbols = '{{}}'
                )
            )
        """
    )
    _outcomes(OUTCOMES)


def downgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM agent_scans WHERE outcome = 'rule_rejected') THEN
                RAISE EXCEPTION 'agent_scans holds rule_rejected scans; 0056 cannot describe them';
            END IF;
        END
        $$
        """
    )
    _outcomes(PREVIOUS_OUTCOMES)
    op.execute(
        """
        ALTER TABLE agents
            DROP CONSTRAINT agents_primary_has_no_mandate,
            DROP COLUMN risk_level,
            DROP COLUMN horizon,
            DROP COLUMN thesis_style,
            DROP COLUMN max_position_bps,
            DROP COLUMN cash_buffer_bps,
            DROP COLUMN max_holdings,
            DROP COLUMN allow_etfs,
            DROP COLUMN market_caps,
            DROP COLUMN sectors,
            DROP COLUMN industries,
            DROP COLUMN etf_categories,
            DROP COLUMN blocked_symbols
        """
    )


def _outcomes(values: tuple[str, ...]) -> None:
    op.execute("ALTER TABLE agent_scans DROP CONSTRAINT agent_scans_outcome_check")
    op.execute(
        "ALTER TABLE agent_scans ADD CONSTRAINT agent_scans_outcome_check "
        f"CHECK (outcome IN ({_sql_list(values)}))"
    )
