"""An auto-proposal says how strong the resolver's match was: confident or weak.

Until now only a `confident` resolution with at least two confident instruments
became a proposal. On the market feed (decision 60) sensible themes also land
just below that bar - "interest rates" and "ai agents" resolve `weak`, "treasury
yields" `confident` with one confident instrument - and the user chose to see
those too, as long as they can never crowd out a confident one (2026-09-29):

- `proposal_band` is `confident` or `weak`, set on every auto-proposal and on
  no user-created topic (`topics_auto_has_band`);
- weak proposals are counted against their own cap in the orchestrator, never
  against the confident one - a shared cap would let three weak proposals
  block every confident one, which is the failure decision 57 fixed;
- the band stays on the row after the proposal is accepted, rejected or expires:
  it is part of the record of what was proposed. Rejection memory and expiry
  ignore it, so both bands are remembered the same way.

Every existing auto-proposal was confident, so they are backfilled as such. The
downgrade cannot keep the distinction, so a weak proposal still open expires
rather than turning into a confident-looking one; answered rows keep their
status.

Revision ID: 0024_topic_proposal_band
Revises: 0023_article_feed
"""

from alembic import op

revision = "0024_topic_proposal_band"
down_revision = "0023_article_feed"
branch_labels = None
depends_on = None

BANDS = ("confident", "weak")


def upgrade() -> None:
    bands = ", ".join(repr(band) for band in BANDS)
    op.execute(
        f"""
        ALTER TABLE topics
            ADD COLUMN proposal_band text
                CONSTRAINT topics_proposal_band_check CHECK (proposal_band IN ({bands}))
        """
    )
    op.execute("UPDATE topics SET proposal_band = 'confident' WHERE created_by = 'auto'")
    op.execute(
        """
        ALTER TABLE topics ADD CONSTRAINT topics_auto_has_band
            CHECK ((created_by = 'auto') = (proposal_band IS NOT NULL))
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE topics
           SET status = 'expired', expired_at = now(), updated_at = now()
         WHERE proposal_band = 'weak' AND status = 'proposed'
        """
    )
    op.execute("ALTER TABLE topics DROP CONSTRAINT topics_auto_has_band")
    op.execute("ALTER TABLE topics DROP COLUMN proposal_band")
