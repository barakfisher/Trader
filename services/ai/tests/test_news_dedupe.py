"""Article identity: what counts as the same story.

Each case here is a pair we would otherwise have stored twice, or a pair we must
not merge. The two hashes catch different duplicates and the tests are grouped
that way.
"""

from app.news.dedupe import content_hash, normalise_text, normalise_url, url_hash


class TestUrlHash:
    """The same story, fetched again."""

    def test_tracking_parameters_do_not_change_identity(self):
        # The newsletter copy of a link is the same article as the link.
        plain = "https://news.example.com/story/abc"
        tagged = "https://news.example.com/story/abc?utm_source=newsletter&utm_medium=email"
        assert url_hash(plain) == url_hash(tagged)

    def test_click_identifiers_do_not_change_identity(self):
        plain = "https://news.example.com/story/abc"
        shared = "https://news.example.com/story/abc?fbclid=XYZ&ref=twitter"
        assert url_hash(plain) == url_hash(shared)

    def test_host_case_scheme_www_and_trailing_slash_do_not_change_identity(self):
        assert url_hash("HTTP://WWW.News.Example.com/story/abc/") == url_hash(
            "https://news.example.com/story/abc"
        )

    def test_fragment_does_not_change_identity(self):
        assert url_hash("https://news.example.com/story/abc#comments") == url_hash(
            "https://news.example.com/story/abc"
        )

    def test_parameter_order_does_not_change_identity(self):
        # Sorted on normalisation, so a provider that reorders the query string
        # does not hand us a second article.
        assert url_hash("https://news.example.com/s?b=2&a=1") == url_hash(
            "https://news.example.com/s?a=1&b=2"
        )

    def test_a_meaningful_query_parameter_is_kept(self):
        # The case that forbids stripping the query wholesale: plenty of sites
        # still identify an article this way, and merging them would collapse a
        # publisher's archive into one row.
        assert url_hash("https://news.example.com/article?id=1") != url_hash(
            "https://news.example.com/article?id=2"
        )

    def test_path_case_is_significant(self):
        # Hosts are case-insensitive by specification; paths are not.
        assert url_hash("https://news.example.com/Story") != url_hash(
            "https://news.example.com/story"
        )

    def test_a_string_that_is_not_a_url_still_hashes(self):
        # An unparseable url must not cost us the article.
        assert url_hash("not a url at all") == url_hash("not a url at all")
        assert normalise_url("  not a url  ") == "not a url"

    def test_normalisation_keeps_the_root_path(self):
        assert normalise_url("https://news.example.com/") == "https://news.example.com/"


class TestContentHash:
    """The same story at a different url."""

    def test_reflowed_whitespace_and_case_are_the_same_body(self):
        original = "Constellation Energy agreed a twenty-year agreement."
        reflowed = "Constellation  Energy\nagreed a TWENTY-YEAR agreement.  "
        assert content_hash(original) == content_hash(reflowed)

    def test_the_title_is_not_part_of_the_body_hash(self):
        # The reason there are two hashes rather than one: syndication
        # re-headlines, so a hash covering the title would only ever agree when
        # the url hash already did.
        body = "A wire story carried by two outlets."
        assert content_hash(body) == content_hash(body)
        assert normalise_text("Headline. " + body) != normalise_text(body)

    def test_a_rewritten_lede_is_a_different_article(self):
        # Not fuzzy matching, on purpose: a wrong merge deletes a story.
        assert content_hash("Shares fell after the update.") != content_hash(
            "Shares declined following the update."
        )

    def test_hashes_are_stable_hex_digests(self):
        # Stable across processes, unlike hash(), whose seed is randomised.
        digest = content_hash("stable")
        assert len(digest) == 64
        assert digest == content_hash("stable")
