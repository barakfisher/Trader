"""What the model's last turn means: parsed, checked, and given its sources.

The model ends a turn with JSON - what kind of reply it is, the text, and a few
questions the user might ask next (`instructions.py`). This module turns that
into a reply the user may see, or says why it may not:

- **Shape**: JSON with a known `outcome`, and a `reason` exactly when it
  declines. Fenced JSON is accepted; anything else is `malformed`.
- **Figures** (guideline 7): every number in the text and the suggestions must
  appear in a tool result of this conversation or in the user's own words. The
  user's words count because correcting "my portfolio is up 50%" has to repeat
  the 50; a figure the model brought itself is what the check exists to stop.
  The checker is narration's (`evidence_validator.unsourced_figures`), so the
  two read numbers the same way.
- **Degenerate text**: a model stuck repeating itself passed the figure check
  once (#101); the same check runs here first.

**Sources are the server's, never the model's.** They are built from the tools
that actually ran this turn - a news article's own URL, the page a figure came
from - so a model cannot cite a page it never read, and a reply that used no
tool has no sources rather than invented ones.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from app.llm.degenerate_text import is_degenerate
from app.narration.evidence_validator import unsourced_figures

Outcome = Literal["answer", "decline", "clarify"]
OUTCOMES: tuple[Outcome, ...] = ("answer", "decline", "clarify")
DECLINE_REASONS = ("off_domain", "advice", "action", "prompt")
#: Suggested next questions kept: the screen shows them as buttons.
MAX_SUGGESTIONS = 3
MAX_SUGGESTION_CHARS = 120

_FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.DOTALL)
#: Dashes a model writes for "-": hyphen, non-breaking hyphen, figure dash, en
#: dash, minus. Read as "-" for the check only, so "7\u2011day" names the window
#: "7-day" does and "\u22129.03%" is the figure "-9.03%" is; the text shown is
#: the model's. Measured 2026-10-11: a real reply wrote every hyphen as U+2011.
_DASHES = str.maketrans(dict.fromkeys("\u2010\u2011\u2012\u2013\u2212", "-"))


@dataclass(frozen=True)
class Reply:
    outcome: Outcome
    text: str
    reason: str | None = None
    suggestions: tuple[str, ...] = ()


@dataclass(frozen=True)
class Checked:
    reply: Reply | None
    #: Why the reply may not be shown; empty when it may.
    problems: tuple[str, ...] = ()
    unsourced: tuple[str, ...] = field(default_factory=tuple)

    @property
    def valid(self) -> bool:
        return self.reply is not None and not self.problems


def parse(raw: str) -> Reply | None:
    """The reply the model wrote, or None when it is not the JSON asked for."""
    body = raw.strip()
    fenced = _FENCE.match(body)
    if fenced:
        body = fenced.group(1)
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    outcome = data.get("outcome")
    text_ = data.get("text")
    if outcome not in OUTCOMES or not isinstance(text_, str) or not text_.strip():
        return None
    reason = data.get("reason") if outcome == "decline" else None
    if outcome == "decline" and reason not in DECLINE_REASONS:
        return None
    raw_suggestions = data.get("suggestions", [])
    suggestions = tuple(
        s.strip()[:MAX_SUGGESTION_CHARS]
        for s in (raw_suggestions if isinstance(raw_suggestions, list) else [])
        if isinstance(s, str) and s.strip()
    )[:MAX_SUGGESTIONS]
    return Reply(outcome=outcome, text=text_.strip(), reason=reason, suggestions=suggestions)


def check(raw: str, *, tool_results: Sequence[Any], user_messages: Sequence[str]) -> Checked:
    """Parse `raw` and check it against the conversation's evidence."""
    if is_degenerate(raw):
        return Checked(reply=None, problems=("degenerate",))
    reply = parse(raw)
    if reply is None:
        return Checked(reply=None, problems=("malformed",))
    evidence = {"tool_results": list(tool_results), "user": list(user_messages)}
    unsourced = tuple(
        figure
        for written in (reply.text, *reply.suggestions)
        for figure in unsourced_figures(written.translate(_DASHES), evidence)
    )
    if unsourced:
        return Checked(
            reply=reply,
            problems=(f"figures not in the evidence: {', '.join(unsourced)}",),
            unsourced=unsourced,
        )
    return Checked(reply=reply)


# -- sources -------------------------------------------------------------------

#: A tool's result, as the page it came from.
_PAGES = {
    "get_portfolio": "Portfolio",
    "get_agents": "Agents",
    "get_observations": "Insights",
    "get_topics": "Topics",
}
_DATA = {
    "get_quote": "Delayed quotes",
    "get_price_history": "Daily closes",
    "get_findings": "Rule findings",
    "search_universe": "Universe search",
    "get_product_guide": "How Traders works",
}


def sources(calls: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Where this turn's facts came from, from the tool calls that ran, deduplicated.

    `calls` are the transcript's tool entries: `{"name": ..., "result": ...}`.
    Each source is `{"kind", "label"}` plus a `url` (outside) or a `link` (a
    page of this app).
    """
    found: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    def add(source: dict[str, Any]) -> None:
        key = (source["label"], source.get("url") or source.get("link") or "")
        if key not in seen:
            seen.add(key)
            found.append(source)

    for call in calls:
        name, result = call.get("name"), call.get("result")
        if not isinstance(result, Mapping) or "error" in result:
            continue
        if name == "get_news":
            for article in result.get("articles", []):
                add(
                    {
                        "kind": "news",
                        "label": f"{article.get('source')}: {article.get('title')}",
                        **({"url": article["url"]} if article.get("url") else {}),
                        "published": article.get("published"),
                    }
                )
        elif name == "explain_concept":
            for excerpt in result.get("excerpts", []):
                add({"kind": "concept", "label": excerpt.get("title") or excerpt.get("concept")})
        elif name == "get_proposals":
            for proposal in result.get("proposals", []):
                add({"kind": "page", "label": proposal["headline"], "link": proposal["link"]})
        elif name in _PAGES:
            link = result.get("link") or {
                "get_agents": "/agents",
                "get_observations": "/insights",
            }.get(str(name), "/")
            add({"kind": "page", "label": _PAGES[str(name)], "link": link})
        elif name in _DATA:
            subject = result.get("symbol") or ", ".join(result.get("quotes", {}) or [])
            add({"kind": "data", "label": f"{_DATA[str(name)]}{': ' + subject if subject else ''}"})
    return found
