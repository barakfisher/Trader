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
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Any, Literal

from app.assistant.product_guide import PAGES
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
#: A markdown numbered-list marker ("2. " at a line's start): a position, not a
#: figure. Measured 2026-10-12: a real step-by-step reply was refused for its "2.".
_LIST_MARKER = re.compile(r"^(\s*)\d{1,2}[.)](?=\s)", re.MULTILINE)


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


#: A date, optionally with a time and zone: "2026-10-12", "2026-10-12T09:57:05.19+00:00",
#: "2026-10-12 09:57". Read as a date, never as the numbers 2026, 10 and 12.
_DATE = re.compile(
    r"\b(\d{4}-\d{2}-\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}| ?UTC)?)?"
)
#: A markdown link's target and a bare URL: where a link goes, checked by
#: `unknown_links`, never read for figures (an id's digits are not a figure).
_LINK_TARGET = re.compile(r"\]\([^)]*\)")
_URL = re.compile(r"https?://\S+")
#: A markdown link to a page of this app: "[Insights](/insights)".
_APP_LINK = re.compile(r"\]\((/[^)\s]*)\)")
_ID_SEGMENT = re.compile(r"/[0-9a-fA-F-]{8,}(?=/|$)")


def _strings(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, Mapping):
        for item in value.values():
            yield from _strings(item)
    elif isinstance(value, list | tuple):
        for item in value:
            yield from _strings(item)


def _as_checked(written: str, evidence_dates: set[str]) -> str:
    """The text as the figure check reads it: dashes as "-", list markers removed,
    and a date the evidence states removed whole. The text shown is the model's own.

    Dates are read as dates (measured 2026-10-12): a real reply quoting
    "2026-10-12T09:57:05.199619+00:00" was refused for "57", and on the 12th of
    the month an invented "12%" passed because a timestamp held a 12. A date
    whose day the evidence does not state stays in, and its digits are checked.
    """
    text_ = _LIST_MARKER.sub(r"\1", written.translate(_DASHES))
    text_ = _LINK_TARGET.sub("]()", _URL.sub(" ", text_))
    return _DATE.sub(lambda m: " " if m.group(1) in evidence_dates else m.group(0), text_)


def _without_dates(value: Any) -> Any:
    """The evidence with its dates taken out of its strings, so the digits of a
    timestamp never source a figure ("2026-10-12T..." vouched for an invented 12)."""
    if isinstance(value, str):
        return _DATE.sub(" ", value)
    if isinstance(value, Mapping):
        return {key: _without_dates(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [_without_dates(item) for item in value]
    return value


#: A whole markdown link to a path of this app: "[label](/path)".
_APP_LINK_WHOLE = re.compile(r"\[([^\]]*)\]\((/[^)\s]*)\)")


def _is_page(path: str) -> bool:
    bare = path.split("?")[0].split("#")[0].rstrip("/") or "/"
    return _ID_SEGMENT.sub("/<id>", bare) in PAGES


def unknown_links(written: str) -> list[str]:
    """Links to pages of this app that do not exist (real replies linked "/universe"
    and "/guide", 2026-10-12)."""
    return [path for path in _APP_LINK.findall(written) if not _is_page(path)]


def without_unknown_links(written: str) -> str:
    """The text with each link to a page that does not exist reduced to its words.

    An invented page is a broken link, not an invented fact: the reply is kept and
    the link dropped, where an invented figure sends the reply back.
    """
    return _APP_LINK_WHOLE.sub(
        lambda m: m.group(0) if _is_page(m.group(2)) else m.group(1), written
    )


def check(raw: str, *, tool_results: Sequence[Any], user_messages: Sequence[str]) -> Checked:
    """Parse `raw` and check it against the conversation's evidence."""
    if is_degenerate(raw):
        return Checked(reply=None, problems=("degenerate",))
    reply = parse(raw)
    if reply is None:
        return Checked(reply=None, problems=("malformed",))
    evidence = {"tool_results": list(tool_results), "user": list(user_messages)}
    dates = {m.group(1) for s in _strings(evidence) for m in _DATE.finditer(s)}
    dateless = _without_dates(evidence)
    unsourced = tuple(
        figure
        for written in (reply.text, *reply.suggestions)
        for figure in unsourced_figures(_as_checked(written, dates), dateless)
    )
    if unsourced:
        return Checked(
            reply=reply,
            problems=(f"figures not in the evidence: {', '.join(unsourced)}",),
            unsourced=unsourced,
        )
    if unknown_links(reply.text):
        reply = replace(reply, text=without_unknown_links(reply.text))
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
    "get_universe_info": "The universe snapshot",
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
        # A tool's refusal is a result whose only field is `error`; a result that
        # merely has one (a replayed scan's) is still a source.
        if not isinstance(result, Mapping) or set(result) == {"error"}:
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
        elif name == "replay_scan":
            if result.get("scan_id"):
                add(
                    {
                        "kind": "page",
                        "label": f"{result.get('agent')}'s scan, {_when(result.get('started_at'))}",
                        "link": result.get("link"),
                    }
                )
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
            symbol = result.get("symbol")
            quotes = result.get("quotes")
            subject = (
                symbol
                if isinstance(symbol, str)
                else ", ".join(quotes)
                if isinstance(quotes, Mapping)
                else ""
            )
            add({"kind": "data", "label": f"{_DATA[str(name)]}{': ' + subject if subject else ''}"})
    return found


def _when(iso: Any) -> str:
    """ "2026-10-12T10:37:13.6+00:00" as "2026-10-12 10:37 UTC" for a source's label."""
    if not isinstance(iso, str) or len(iso) < 16:
        return str(iso)
    return (
        f"{iso[:10]} {iso[11:16]} UTC"
        if iso.endswith(("+00:00", "Z"))
        else iso[:16].replace("T", " ")
    )
