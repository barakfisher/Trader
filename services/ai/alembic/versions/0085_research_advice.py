"""Research gives a view, and a view that asks for action is an acknowledge-only proposal (D390).

D387 case 1, as D390 builds it:

- **`research_ratings.rating`** widens from Bullish / Bearish / Neutral to the
  advisor's words: Buy more / Hold / Trim / Sell for a stock the real portfolio
  holds, Buy / Wait / Avoid for one researched on its own (D369). The three old
  words stay valid: the ratings stored before this are kept and shown until a
  newer one replaces them (the user, 2026-11-05), so nothing is deleted and
  nothing is translated into a word the model never wrote.
- **The `0038` trigger** (the primary agent is passive, D1) admits one more
  kind, `research`: the real portfolio is asked to *acknowledge* a research
  view, never to trade. Approving it writes an intent and changes no holding;
  the holdings change only when the user records the trade they made at the
  broker (D387). It stays an allowlist, so `buy` and `sell` - a fill - are
  still refused on the primary whatever wrote them, and `research` is refused
  on every agent but the primary: a simulated agent's view is a trade.
  A `research` payload carrying a quantity or a price is refused too, so the
  kind cannot become a fill by its payload.

The downgrade refuses while either is in use: a new rating word or a
`research` proposal would break the restored constraints.

Revision ID: 0085_research_advice
Revises: 0084_index_article_duplicates
"""

from alembic import op

revision = "0085_research_advice"
down_revision = "0084_index_article_duplicates"
branch_labels = None
depends_on = None

#: 0070's ratings, kept: stored before D390 and shown until replaced.
PREVIOUS_RATINGS = ("bullish", "bearish", "neutral")
#: `app/research/rating.py` RATINGS; the web's `RESEARCH_RATINGS` says the same.
RATINGS = ("buy_more", "hold", "trim", "sell", "buy", "wait", "avoid", *PREVIOUS_RATINGS)
#: The proposal kinds the primary may receive: 0038's, and the research view.
PREVIOUS_PRIMARY_KINDS = ("rebalance",)
PRIMARY_KINDS = (*PREVIOUS_PRIMARY_KINDS, "research")


def _sql_list(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def _ratings(values: tuple[str, ...]) -> None:
    op.execute("ALTER TABLE research_ratings DROP CONSTRAINT research_ratings_rating_check")
    op.execute(
        "ALTER TABLE research_ratings ADD CONSTRAINT research_ratings_rating_check "
        f"CHECK (rating IN ({_sql_list(values)}))"
    )


def upgrade() -> None:
    _ratings(RATINGS)
    # The trigger keeps its name (0038's), so every reader of "why was this
    # refused" finds the same function; only its allowlist and rules grow.
    op.execute(
        f"""
        CREATE OR REPLACE FUNCTION proposals_primary_rebalance_only() RETURNS trigger
        LANGUAGE plpgsql AS $$
        DECLARE
            primary_agent boolean;
        BEGIN
            SELECT is_primary INTO primary_agent FROM agents WHERE id = NEW.agent_id;
            IF coalesce(primary_agent, false) AND NEW.kind NOT IN ({_sql_list(PRIMARY_KINDS)}) THEN
                RAISE EXCEPTION 'the primary agent is passive: a % proposal cannot be raised '
                    'against the real portfolio', NEW.kind
                    USING ERRCODE = 'check_violation';
            END IF;
            IF NEW.kind = 'research' AND NOT coalesce(primary_agent, false) THEN
                RAISE EXCEPTION 'a research proposal is raised on the real portfolio only'
                    USING ERRCODE = 'check_violation';
            END IF;
            IF NEW.kind = 'research'
               AND (NEW.payload ? 'quantity' OR NEW.payload ? 'priceMinor') THEN
                RAISE EXCEPTION 'a research proposal is acknowledged, never filled: '
                    'it carries no quantity or price'
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute("DROP TRIGGER proposals_primary_rebalance_only ON proposals")
    op.execute(
        """
        CREATE TRIGGER proposals_primary_rebalance_only
            BEFORE INSERT OR UPDATE OF kind, agent_id, payload ON proposals
            FOR EACH ROW EXECUTE FUNCTION proposals_primary_rebalance_only()
        """
    )


def downgrade() -> None:
    op.execute(
        f"""
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM research_ratings
                        WHERE rating NOT IN ({_sql_list(PREVIOUS_RATINGS)})) THEN
                RAISE EXCEPTION 'research ratings use D390''s words; 0084 cannot hold them';
            END IF;
            IF EXISTS (SELECT 1 FROM proposals WHERE kind = 'research') THEN
                RAISE EXCEPTION 'research proposals exist; 0084''s trigger would refuse them';
            END IF;
        END;
        $$
        """
    )
    _ratings(PREVIOUS_RATINGS)
    op.execute(
        f"""
        CREATE OR REPLACE FUNCTION proposals_primary_rebalance_only() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            IF NEW.kind NOT IN ({_sql_list(PREVIOUS_PRIMARY_KINDS)})
               AND EXISTS (SELECT 1 FROM agents WHERE id = NEW.agent_id AND is_primary) THEN
                RAISE EXCEPTION 'the primary agent is passive: a % proposal cannot be raised '
                    'against the real portfolio', NEW.kind
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute("DROP TRIGGER proposals_primary_rebalance_only ON proposals")
    op.execute(
        """
        CREATE TRIGGER proposals_primary_rebalance_only
            BEFORE INSERT OR UPDATE OF kind, agent_id ON proposals
            FOR EACH ROW EXECUTE FUNCTION proposals_primary_rebalance_only()
        """
    )
