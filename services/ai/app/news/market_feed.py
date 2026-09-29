"""Which of GDELT's articles are market news, for the feed nothing followed selects.

**Why this feed exists.** Until it, news was collected only for the instruments
the user holds or follows (decision 51), and discovery could only find themes
*next to* those: on 2026-09-29 NVDA, AAPL, BTC-USD and MSFT were 95% of the
headlines, and after one company's news was dropped (decision 59) nothing left
was a theme. The market feed keeps the articles about markets in general, so a
theme like "data center" reads as spread across companies. It feeds discovery
only: an article kept here and linked to nothing followed never reaches topic
news, sentiment or a holding's evidence, because each of those joins through
`article_entities` (decision 60).

**The filter, measured before it was written** (2026-09-29, raw GKG files, three
24-hour samples and then every slot of 2026-09-22..29). An article is market
news when GDELT tagged it with a market theme (`MARKET_TAGS`, from column 8)
**and** its headline uses market vocabulary (`MARKET_WORDS`, `MARKET_PHRASES`).
Either alone was too wide: the tags let through law-firm press releases and
general economics, the words let through "MasterChef star shares". Together
they keep about 4,000 articles a day of GDELT's ~112,000, the same within 1% on
two held-out days, and discovery over a week of them resolves "data center",
"bond yields", "mortgage rates" and "crude oil" to confident instrument sets.
The lists are frozen as measured: a change to either is a change to the feed,
and is measured the same way before it is made.

**What is not news, whatever its tags** (`EXCLUDED_OUTLETS`). Two kinds of
outlet, named rather than detected:

* *Generated ticker networks* publish a templated headline per ticker per event
  ("Bloom Energy's (BE) Outperform Rating Reiterated at ..."): over the measured
  week 88-95% of their headlines carried a ticker in parentheses, and they put
  "short interest" and "etf nysearca" at the top of every day's phrases. The
  next outlet down, seekingalpha at 0.63-0.77, is real reporting, so the gap is
  too thin to draw automatically.
* *Press-release wires* carry what a company wrote about itself. Once the
  networks were out, their law-firm "class action" and "lead plaintiff"
  releases filled the top of the list.

A network that appears under a new domain is found by `suspected_networks`,
which each collection run reports; adding it here is a reviewed change, like a
word in `GENERIC_WORDS`.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import timedelta

#: GDELT V2Themes that mark an article as being about markets, rates, prices or
#: capital. Column 8 of the GKG file; an article carries many themes.
MARKET_TAGS = frozenset(
    {
        "ECON_STOCKMARKET", "ECON_INTEREST_RATES", "ECON_INFLATION", "ECON_CENTRALBANK",
        "ECON_OILPRICE", "ECON_IPO", "ECON_GOLDPRICE", "ECON_BITCOIN", "ECON_TRADE_DISPUTE",
        "ECON_FREETRADE", "ECON_CURRENCY_EXCHANGE_RATE", "ECON_SOVEREIGN_DEBT",
        "ECON_BANKRUPTCY", "ECON_MONOPOLY", "ECON_FOREIGNINVEST", "ECON_HOUSING_PRICES",
        "ECON_ELECTRICALDEMAND", "ECON_ELECTRICALGRID", "ECON_GASOLINEPRICE", "ECON_DEBT",
        "EPU_POLICY_INTEREST_RATES", "EPU_POLICY_CENTRAL_BANK", "WB_1235_CENTRAL_BANKS",
        "TAX_FNCACT_INVESTOR", "WB_341_INVESTMENT_FUNDS", "WB_1079_COMMODITIES_AND_RESOURCES",
        "SOC_TECHNOLOGYSECTOR",
    }
)  # fmt: skip

#: Headline words that say the article is about a market. Whole words, lower case.
MARKET_WORDS = frozenset(
    {
        "stock", "stocks", "share", "shares", "shareholder", "shareholders", "investor",
        "investors", "market", "markets", "equity", "equities", "earnings", "revenue",
        "revenues", "profit", "profits", "sales", "guidance", "forecast", "outlook",
        "dividend", "dividends", "buyback", "ipo", "listing", "merger", "mergers",
        "acquisition", "acquisitions", "acquire", "acquires", "acquired", "takeover",
        "buyout", "stake", "bond", "bonds", "yield", "yields", "treasury", "treasuries",
        "fed", "rate", "rates", "inflation", "cpi", "gdp", "recession", "tariff", "tariffs",
        "oil", "crude", "brent", "opec", "gas", "lng", "gold", "silver", "copper", "lithium",
        "uranium", "bitcoin", "crypto", "dollar", "currency", "nasdaq", "dow", "s&p", "index",
        "indices", "futures", "valuation", "valuations", "billion", "trillion", "funding",
        "investment", "invest", "invests", "chip", "chips", "chipmaker", "semiconductor",
        "semiconductors", "startup", "startups", "ai", "datacenter", "analyst", "analysts",
        "upgrade", "downgrade", "sensex", "nifty",
    }
)  # fmt: skip

#: Market vocabulary that is only market vocabulary as a phrase ("street" alone
#: is not). Matched at the start of a word, so plurals count.
MARKET_PHRASES = (
    "data center", "data centre", "wall street", "price target", "interest rate",
    "rate cut", "rate hike", "central bank",
)  # fmt: skip

#: Generated ticker networks: a templated headline per ticker per event. Each
#: measured at 0.88-0.95 of its headlines with a ticker in parentheses over
#: 2026-09-22..29, except americanbankingnews.com (the same network, seen in the
#: first sample) and financialcontent.com, whose "Why X (TICK) Stock Is Trading
#: Lower Today" pages reached 0.85 on 2026-09-25 - the first outlet the
#: suspected-network check found.
TICKER_NETWORKS = frozenset(
    {
        "themarketsdaily.com", "tickerreport.com", "dailypolitical.com",
        "americanbankingnews.com", "insidermonkey.com", "foreignpolicyjournal.com",
        "financialcontent.com",
    }
)  # fmt: skip

#: Press-release wires: a company's own words, not a report about it.
PRESS_RELEASE_WIRES = frozenset(
    {
        "prnewswire.com", "pr-inside.com", "globenewswire.com", "businesswire.com",
        "accesswire.com", "einpresswire.com", "openpr.com", "newsfilecorp.com",
    }
)  # fmt: skip

EXCLUDED_OUTLETS = TICKER_NETWORKS | PRESS_RELEASE_WIRES

#: A ticker in parentheses, with or without its exchange: "(BE)", "(NASDAQ:NVDA)".
TICKER_TEMPLATE = re.compile(r"\((?:[A-Z]{2,12}\s*:\s*)?[A-Z][A-Z0-9.\-]{0,9}\)")

#: How far back `suspected_networks` looks. A day holds ~200 headlines from each
#: known network, and a week of real outlets did not reach the share in any day
#: once financialcontent.com was listed (seekingalpha's highest day: 0.77).
SUSPECT_WINDOW = timedelta(days=1)

#: Headlines an outlet needs in the window before its share means anything.
SUSPECT_MIN_HEADLINES = 20

#: The share of an outlet's headlines carrying a ticker in parentheses at which
#: it is reported as a likely network.
SUSPECT_SHARE = 0.85

_WORD = re.compile(r"[a-z0-9&]+")
_PHRASE = re.compile("|".join(rf"(?<![a-z0-9]){re.escape(phrase)}" for phrase in MARKET_PHRASES))


def is_market_headline(title: str, themes: Iterable[str]) -> bool:
    """Tagged as market news by GDELT, and worded as market news by the outlet."""
    if MARKET_TAGS.isdisjoint(themes):
        return False
    lowered = title.lower()
    return not MARKET_WORDS.isdisjoint(_WORD.findall(lowered)) or bool(_PHRASE.search(lowered))


def outlet(source: str) -> str:
    """An outlet's name as the lists spell it: lower case, no leading `www.`."""
    name = source.strip().lower()
    return name[4:] if name.startswith("www.") else name


def is_excluded_outlet(source: str) -> bool:
    return outlet(source) in EXCLUDED_OUTLETS


@dataclass(frozen=True, slots=True)
class SuspectedNetwork:
    """An outlet whose headlines look generated, reported for a person to judge."""

    source: str
    headlines: int
    templated: int

    @property
    def share(self) -> float:
        return self.templated / self.headlines


def suspected_networks(headlines: Iterable[tuple[str, str]]) -> list[SuspectedNetwork]:
    """Outlets among `(source, title)` pairs that look like a ticker network, most templated first.

    Only outlets not already excluded, with at least `SUSPECT_MIN_HEADLINES`,
    and at least `SUSPECT_SHARE` of them carrying a ticker in parentheses.
    """
    total: Counter[str] = Counter()
    templated: Counter[str] = Counter()
    for source, title in headlines:
        name = outlet(source)
        if name in EXCLUDED_OUTLETS:
            continue
        total[name] += 1
        if TICKER_TEMPLATE.search(title):
            templated[name] += 1
    found = [
        SuspectedNetwork(source=name, headlines=count, templated=templated[name])
        for name, count in total.items()
        if count >= SUSPECT_MIN_HEADLINES and templated[name] / count >= SUSPECT_SHARE
    ]
    return sorted(found, key=lambda s: (-s.share, s.source))
