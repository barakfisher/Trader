"""What an article is about, and - more importantly - what it is not about.

The false-positive cases come first, because they are the ones that matter: a
missing link costs an explanation, a wrong link produces a confident explanation
that is false.
"""

from app.news.entities import (
    SALIENCE_CASHTAG,
    SALIENCE_COMPANY_NAME,
    SALIENCE_EXCHANGE_PREFIX,
    TITLE_SALIENCE_BONUS,
    EntityMatcher,
    InstrumentRef,
)


def symbols(links) -> set[str]:
    return {link.symbol for link in links}


class TestFalsePositives:
    def test_a_ticker_shaped_word_in_prose_does_not_link(self, matcher: EntityMatcher):
        # SMR is NuScale Power's ticker and the industry's acronym for a small
        # modular reactor. This notice is about the second one and names no
        # company, so it must produce no link at all.
        title = "Regulator sets a 2027 review window for SMR designs"
        body = (
            "The licensing body published the timetable for its next round of SMR "
            "reviews. Each SMR submission filed before the cut-off will be assigned "
            "a review slot. The notice names no applicant."
        )
        assert matcher.match(title, body) == []

    def test_the_same_ticker_links_once_a_company_confirms_it(self, matcher: EntityMatcher):
        # The corroboration rule, from the other side: the identical ticker now
        # links, because the article says whose it is.
        links = matcher.match(
            "NuScale Power wins a first commercial order",
            "NuScale Power Corporation (NYSE: SMR) said it has won its first order.",
        )
        assert symbols(links) == {"SMR"}
        assert links[0].match_method == "exchange_prefix"

    def test_a_short_alias_is_matched_case_sensitively(self, matcher: EntityMatcher):
        # "SAP" the company is three letters; "sap" is also an English verb. A
        # case-insensitive short alias links the wrong article.
        assert matcher.match("Cost inflation will sap margins", "Analysts said it will sap.") == []
        assert symbols(matcher.match("SAP SE raises its target", "SAP SE said so.")) == {"SAP.DE"}

    def test_an_alias_inside_a_longer_word_does_not_link(self, matcher: EntityMatcher):
        assert matcher.match("Pineapple harvest", "A pineapple grower reported.") == []

    def test_a_generic_issuer_name_does_not_link_a_fund(self, matcher: EntityMatcher):
        # "Vanguard" is thirty funds, so the first word of a fund's name is not an
        # alias for one of them.
        assert matcher.match("Vanguard hires a chief risk officer", "Vanguard said.") == []

    def test_an_article_about_nothing_we_hold_produces_no_links(self, matcher: EntityMatcher):
        links = matcher.match(
            "Ten-year yields ease after an inflation print lands in line",
            "Ten-year yields eased two basis points after the monthly print.",
        )
        assert links == []


class TestMatching:
    def test_a_cashtag_links(self, matcher: EntityMatcher):
        links = matcher.match("Bitcoin rallies", "Bitcoin ($BTC) rallied for a third day.")
        assert symbols(links) == {"BTC-USD"}

    def test_a_suffixed_symbol_is_matched_by_its_traded_ticker(self, matcher: EntityMatcher):
        # The press writes "XETRA: SAP", not "SAP.DE" - the suffix is our
        # provider's notation.
        links = matcher.match("SAP lifts its target", "SAP SE (XETRA: SAP) raised its target.")
        assert links[0].symbol == "SAP.DE"
        assert links[0].match_method == "exchange_prefix"

    def test_a_company_name_alone_links(self, matcher: EntityMatcher):
        links = matcher.match(
            "Apple faces a second review",
            "Regulators opened an investigation into how Apple Inc. charges developers.",
        )
        assert symbols(links) == {"AAPL"}
        assert links[0].match_method == "company_name"

    def test_an_article_about_several_holdings_links_all_of_them(self, matcher: EntityMatcher):
        links = matcher.match(
            "AI capex race widens as three hyperscalers lift spending plans",
            "Nvidia, Microsoft and Alphabet each pointed to higher spending, and "
            "the Nasdaq-100 tracker $QQQ closed near a record.",
        )
        assert symbols(links) == {"NVDA", "MSFT", "GOOGL", "QQQ"}
        # Every link names the rule that made it, because a link is evidence.
        assert {link.match_method for link in links} == {"cashtag", "company_name"}
        assert all(link.instrument_id is not None for link in links)

    def test_instrument_id_is_carried_through(self, matcher: EntityMatcher):
        links = matcher.match("Teva wins approval", "Teva Pharmaceutical Industries Ltd said so.")
        assert links[0].instrument_id == "instrument-TEVA"


class TestSalience:
    def test_an_explicit_ticker_outranks_a_name_mention(self, matcher: EntityMatcher):
        # Both rules fire on this article; the stronger one decides the link.
        explicit = matcher.match("A deal", "Constellation Energy Corporation ($CEG) agreed a deal.")
        assert explicit[0].match_method == "cashtag"
        assert explicit[0].salience >= SALIENCE_CASHTAG
        assert explicit[0].salience > SALIENCE_COMPANY_NAME

    def test_a_title_mention_scores_above_a_body_only_mention(self, matcher: EntityMatcher):
        in_title = matcher.match("Apple posts record revenue", "The company reported.")
        in_body = matcher.match("A company posts record revenue", "Apple Inc. reported.")
        assert in_title[0].in_title is True
        assert in_body[0].in_title is False
        assert in_title[0].salience == round(SALIENCE_COMPANY_NAME + TITLE_SALIENCE_BONUS, 4)

    def test_salience_never_exceeds_one(self, matcher: EntityMatcher):
        # The column is numeric(5, 4) with a CHECK between 0 and 1, so a bonus
        # stack that overflowed would fail on INSERT rather than in a test.
        links = matcher.match(
            "MSFT MSFT MSFT",
            "(NASDAQ: MSFT) (NASDAQ: MSFT) (NASDAQ: MSFT) (NASDAQ: MSFT) (NASDAQ: MSFT)",
        )
        assert links[0].salience <= 1.0
        assert links[0].salience >= SALIENCE_EXCHANGE_PREFIX

    def test_links_are_returned_strongest_first(self, matcher: EntityMatcher):
        links = matcher.match(
            "Nvidia slumps",
            "NVIDIA Corporation ($NVDA) fell. Microsoft Corporation was steady.",
        )
        assert [link.symbol for link in links] == ["NVDA", "MSFT"]


class TestUniverse:
    def test_an_instrument_without_a_name_is_still_matchable_by_ticker(self):
        matcher = EntityMatcher([InstrumentRef(symbol="ZZZZ")])
        assert matcher.match("A note", "Shares of $ZZZZ rose.")[0].symbol == "ZZZZ"
        # And a bare mention of it still does not link.
        assert matcher.match("A note", "The ZZZZ programme was extended.") == []

    def test_an_empty_universe_matches_nothing(self):
        assert EntityMatcher([]).match("Apple posts record revenue", "$AAPL rose.") == []
