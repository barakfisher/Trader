"""What the app is and how it is used: the assistant's `get_product_guide` tool.

Written here rather than retrieved from the concept corpus because it describes
this product, not investing, and changes with the screens - a page renamed in
the web router is a page renamed here, in the same pull request. Each section
is short prose the model quotes or paraphrases; links are the router's paths,
which `test_assistant_eval_set_contract.py` checks against `router.tsx`.

English, like every server-written text the assistant reads (guideline 1).
"""

from __future__ import annotations

from types import MappingProxyType

#: The app's pages a reply may link to: the web router's paths, with `/<id>` for a
#: parameter. `test_assistant_tools_contract.py` holds them equal to `router.tsx`.
PAGES = (
    "/",
    "/insights",
    "/holdings/<id>",
    "/ask",
    "/proposals",
    "/proposals/<id>",
    "/targets",
    "/agents",
    "/agents/<id>",
    "/topics",
    "/settings",
    "/admin",
)

#: Section name -> text. Order is the order a tour takes.
SECTIONS = MappingProxyType(
    {
        "overview": (
            "Traders watches a portfolio, explains what moves in it, and lets simulated "
            "agents propose paper trades. It never places a real order and never contacts a "
            "broker: approving a proposal records it in the app's own virtual ledger only. "
            "It explains and observes; it does not give personal investment advice."
        ),
        "pages": (
            "Portfolio (/): the real portfolio - total value, today's change, the equity "
            "chart, allocation, holdings, and the agents' positions beside it (real and "
            "simulated money are never added together). "
            "Insights (/insights): what the rules found - Alerts, Proposals waiting for a "
            "decision, the daily Digest, and All findings. "
            "Agents (/agents): the real portfolio and the simulated agents; each agent's page "
            "(/agents/<id>) shows its holdings, its decisions and its scans, and is where its "
            "scan schedule and model budget are set. "
            "Topics (/topics): themes the user follows and the instruments chosen for each. "
            "Proposals (/proposals): proposals to decide and their history; each has its own "
            "page (/proposals/<id>). "
            "Targets (/targets): the share of the portfolio the user means to hold in each "
            "instrument, which the drift rule compares against. "
            "Ask (/ask): this assistant. "
            "Settings (/settings): which findings need a decision, which may interrupt, quiet "
            "hours, mute, language, and connecting Telegram."
        ),
        "workflow": (
            "A typical day: open the Portfolio page for today's value and change; open "
            "Insights to read new findings (a dot marks unread ones); decide the proposals "
            "waiting there - approve, reject or snooze - before they expire; look at what the "
            "agents decided on their pages; and follow a new theme on Topics when one comes "
            "up. Telegram can bring alerts and proposals to the phone, with the same buttons."
        ),
        "topics": (
            "A topic is a theme the user follows in their own words, such as 'uranium'. The "
            "app matches it against the business descriptions of the instruments in its "
            "universe (by meaning, using embeddings, with the company's own name removed so "
            "names do not cause false matches), and adds the top holdings of ETFs that are "
            "themselves about the theme. The user confirms which instruments to follow; each "
            "keeps the reason it matched - a quoted sentence of its description, or the ETF "
            "that holds it. The app then watches how the topic's instruments move together, "
            "and may suggest new topics from themes that recur in the news. "
            "Agents use topics too: every scan's briefing lists the user's followed topics "
            "and their instruments (up to five topics, eight symbols each), and an agent can "
            "search the universe by theme with its search_universe tool."
        ),
        "agents": (
            "An agent is a simulated investor with a paper budget and a persona the user "
            "writes. On its schedule (for example once a day before the market opens) it "
            "scans: it reads a briefing - its cash, its holdings and what the rules found in "
            "them, the day's movers it may trade, the user's followed topics - then calls "
            "read-only tools, and decides to buy, sell or do nothing. Doing nothing is the "
            "most common answer. Every agent has the same tools: search_universe (find "
            "instruments by what they do), get_quote (delayed quotes), get_price_history "
            "(daily closes and returns), get_findings (what the rules find in a symbol), "
            "get_news (stored news with sources), its own cash and holdings, and "
            "explain_concept (the reference notes). A scan has at most 12 tool calls and "
            "a daily model budget. Every scan is recorded step by step. "
            "The user creates an agent on the Agents page (/agents) with New agent: a name, "
            "a paper budget in dollars (simulated money, not taken from the portfolio), its "
            "settings - risk, sectors, limits - or a template that fills them, and optional "
            "instructions in the user's own words. This assistant cannot create one."
        ),
        "evidence_check": (
            "Every figure in an agent's thesis must appear in its briefing or in a tool "
            "result; the server checks this before anything is proposed, and rejects the "
            "answer otherwise (the scan then ends as an invalid answer and nothing is "
            "proposed). The same check applies to this assistant's answers."
        ),
        "proposals": (
            "A proposal asks the user to decide. Rules raise them from findings above the "
            "severity chosen in Settings, and agents raise trade proposals from their scans. "
            "A proposal can be approved, rejected or snoozed, and expires after the time set "
            "in Settings. Approving a trade previews it at the live price first; confirming "
            "records it in the agent's virtual ledger. Nothing reaches a broker."
        ),
        "telegram": (
            "Settings has a Telegram section: it creates a one-time link that connects the "
            "user's Telegram chat to the account. Alerts above the interrupt severity and "
            "proposals then arrive there, with Approve, Reject and Snooze buttons that act "
            "exactly as the app's. Quiet hours and mute apply. Sending /stop to the bot "
            "disconnects it."
        ),
        "settings": (
            "Settings (/settings) holds: which findings become proposals, how long a proposal "
            "stays answerable, which findings may interrupt, quiet hours, a one-off mute, the "
            "interface language, and Telegram. An agent's scan schedule and model budget are "
            "set on that agent's page (/agents/<id>). The assistant cannot change any setting; "
            "it can say where each one is."
        ),
        "universe": (
            "The universe is the set of instruments the app knows: US primary-exchange "
            "stocks with a market cap of at least $1B and ETFs with net assets of at least "
            "$100M, screened from Yahoo Finance, with each ETF's top holdings. It is "
            "rescreened about once a quarter, automatically; an admin can also start a "
            "rescreen. A ticker outside it that a user names is profiled on demand."
        ),
        "assistant": (
            "This assistant answers questions about the user's portfolio, agents, proposals, "
            "findings and topics; about tickers, prices and market news; about investing "
            "concepts; and about how this app works. It reads, it never changes anything: it "
            "cannot trade, approve, or change a setting. It does not say whether to buy or "
            "sell. It declines questions outside markets, investing, the account and the app. "
            "It can replay any recorded agent scan step by step - what the agent read, each "
            "tool it called, and what it decided - and report when the universe was last "
            "screened and whether a symbol is in it. "
            "It remembers the current conversation, not earlier ones."
        ),
    }
)
