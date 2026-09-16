"""The two hashes that decide whether an article is new.

The same story reaches us twice in two different ways, and each needs its own
answer:

  * **The same url, fetched again.** The scheduled run wakes every 30 minutes and
    asks for the last day of news, so nearly everything it sees it has seen
    before. The same link also arrives from two different symbol queries, and
    from a newsletter with `utm_source` bolted on. `url_hash` catches all of
    these, because it is computed over a *normalised* url rather than the string
    as received.
  * **The same story at a different url.** A wire item is republished by three
    outlets under three headlines, and a publisher moves an article from
    `/2026/09/15/slug` to `/news/slug`. No amount of url normalisation catches
    that; `content_hash` does, because it is computed over the body text.

Normalisation decisions for the url, each one a case we would otherwise have
stored twice:

  * scheme and host are lowercased, and `http` is folded to `https` - the same
    page served on both is one page;
  * a leading `www.` is dropped, and an `m.` mobile host is folded to its parent;
  * the fragment is dropped: `#comments` is a position on a page, not a page;
  * tracking parameters are dropped (`utm_*`, `fbclid`, `gclid`, `ref`,
    `mc_cid`, `mc_eid`, `at_medium`, `at_campaign`);
  * every OTHER query parameter is KEPT, and the survivors are sorted so that
    parameter order does not create a second identity. Stripping the query
    wholesale is the tempting simplification and it is wrong: plenty of sites
    still identify an article with `?id=12345`, and collapsing those would merge
    a publisher's entire archive into one row;
  * a trailing slash is removed, except from the root path, where it is the
    whole path;
  * the path's case is PRESERVED. Hosts are case-insensitive by specification
    and paths are not - on a case-sensitive origin `/Story` and `/story` are two
    resources, and only one of them exists.

Normalisation for the body text: lowercased, all runs of whitespace collapsed to
one space, ends trimmed. That is enough for the case it exists to catch - the
same text reflowed by a second CMS - and deliberately no more. It is not fuzzy
matching: an outlet that rewrites the lede gets a new `content_hash` and is
stored as a separate article. Near-duplicate detection by similarity (shingling,
embeddings) is a different tool with a threshold to tune and false positives of
its own, and a wrong merge silently deletes a story.

The title is NOT part of `content_hash`, which is the whole point of hashing the
body separately: syndication re-headlines. Including the title would make the
hash agree only when the url hash already did.
"""

from __future__ import annotations

import hashlib
import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

#: Query parameters that identify a campaign or a referrer rather than a
#: document. Prefix match for the `utm_` family, exact match for the rest.
TRACKING_PARAM_PREFIXES = ("utm_", "at_")
TRACKING_PARAMS = frozenset(
    {
        "fbclid",
        "gclid",
        "igshid",
        "mc_cid",
        "mc_eid",
        "ref",
        "ref_src",
        "spm",
    }
)

#: Host prefixes that are the same site by another name.
_HOST_PREFIXES = ("www.", "m.", "amp.")

_WHITESPACE = re.compile(r"\s+")


def normalise_url(url: str) -> str:
    """Canonical form of `url` for identity purposes. See the module docstring.

    A string that does not parse as a url is returned stripped and lowercased in
    its host-less entirety: it is still a usable key, and refusing to hash it
    would mean refusing the article.
    """
    parts = urlsplit(url.strip())
    if not parts.netloc:
        return url.strip()

    scheme = "https" if parts.scheme.lower() in {"http", "https", ""} else parts.scheme.lower()

    host = parts.netloc.lower()
    # Credentials and the default port are noise in an identity.
    if "@" in host:
        host = host.rsplit("@", 1)[1]
    if host.endswith(":443") or host.endswith(":80"):
        host = host.rsplit(":", 1)[0]
    for prefix in _HOST_PREFIXES:
        if host.startswith(prefix):
            host = host[len(prefix) :]
            break

    path = parts.path
    if len(path) > 1 and path.endswith("/"):
        path = path.rstrip("/")

    kept = sorted(
        (key, value)
        for key, value in parse_qsl(parts.query, keep_blank_values=True)
        if not _is_tracking_param(key)
    )
    query = urlencode(kept)

    return urlunsplit((scheme, host, path, query, ""))


def _is_tracking_param(key: str) -> bool:
    lowered = key.lower()
    return lowered in TRACKING_PARAMS or lowered.startswith(TRACKING_PARAM_PREFIXES)


def normalise_text(text: str) -> str:
    """Canonical form of body text for identity purposes: lowercase, single-spaced."""
    return _WHITESPACE.sub(" ", text).strip().lower()


def url_hash(url: str) -> str:
    """Hash of the normalised url. Catches the same story fetched again."""
    return _digest(normalise_url(url))


def content_hash(body: str) -> str:
    """Hash of the normalised body. Catches the same story at another url."""
    return _digest(normalise_text(body))


def _digest(value: str) -> str:
    """SHA-256, hex.

    Not a cryptographic requirement - nobody is attacking our news dedupe - but
    a 64-character hex digest is free to store, collision-free in practice, and
    stable across Python versions and processes, which `hash()` is emphatically
    not: `PYTHONHASHSEED` randomisation would give the same url a different key
    on every boot.
    """
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
