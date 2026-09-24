"""What each ETF in the topic universe holds (M5 slice 2).

A company's own description does not always say what the market files it
under. Measured on the M5 eval: Palantir scores 0.32 against "Defense &
Aerospace Technology", below a nonsense question about Mount Everest, and
Amazon, Microsoft and Alphabet rank below 100th for their themes - they describe
a dozen businesses each. The defense ETFs that match that topic, though, hold
Palantir; the semiconductor ETFs hold NVIDIA. A fund's composition is the
market's own label, so topic resolution reads it as a second signal.

**The holding is stored as Yahoo reports it, and matched separately.** Yahoo
writes many holdings as foreign listings: Cameco as `CCO.TO` (URA's largest
position), TSMC as `2330.TW`. `symbol` and `name` are kept verbatim;
`holding_instrument_id` is the US instrument it was matched to, and `matched_by`
says how - by symbol, or by company name when the symbol is a foreign listing.
Null when nothing in the universe matched: an unmatched holding is recorded,
never guessed.

**Only the top ten.** Yahoo exposes nothing deeper, so for an equal-weighted
fund the ten are close to arbitrary (QTUM's omit IonQ). That is a limit of the
source, stated here so a missing holding is not read as a fund's opinion.

No `user_id`: reference data, like `instruments` and `instrument_profiles`.

Revision ID: 0016_etf_holdings
Revises: 0015_instrument_profiles
"""

from alembic import op

revision = "0016_etf_holdings"
down_revision = "0015_instrument_profiles"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE etf_holdings (
            etf_instrument_id      uuid NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
            position               integer NOT NULL CHECK (position > 0),
            symbol                 text NOT NULL,
            name                   text,
            -- Fraction of the fund, 0 < weight <= 1.
            weight                 numeric(9, 6) NOT NULL CHECK (weight > 0 AND weight <= 1),
            holding_instrument_id  uuid REFERENCES instruments(id) ON DELETE SET NULL,
            matched_by             text CHECK (matched_by IN ('symbol', 'name')),
            CONSTRAINT etf_holdings_match_pair
                CHECK ((holding_instrument_id IS NULL) = (matched_by IS NULL)),
            as_of                  timestamptz NOT NULL,
            PRIMARY KEY (etf_instrument_id, position)
        )
        """
    )
    op.execute("CREATE INDEX etf_holdings_holding_idx ON etf_holdings (holding_instrument_id)")


def downgrade() -> None:
    op.execute("DROP TABLE etf_holdings")
