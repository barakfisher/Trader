"""The text a topic is matched against: a description without its company's name.

Every Yahoo business summary opens with the company's own name, and an embedding
matches name tokens as readily as business ones. Measured on the fitting topics:
"fast food restaurants" admitted **Fastenal** (industrial fasteners) on "Fast-",
and "how tall is mount everest" found **Everest Group** (reinsurance) as its best
match. Neither says anything about what the business does. So the instrument's
own name is replaced with "The company" (or "The fund") before embedding.

**Only the name, never a word of it.** The name is stripped as a phrase - the
full name, then the core name (`app/news/entities.core_name`, the same rule the
news matcher uses: "Everest Group, Ltd." -> "Everest"). The news matcher also
aliases a company by its first word ("NuScale"), and that is deliberately *not*
done here: for Gold Fields Limited it would delete "Gold" from a gold miner's
description, which is the topic signal itself.

The stored description stays verbatim - rationales quote it, and a quotation
must be what the source said. This text exists only to be embedded, and the
profile's content hash is taken over it, so changing this rule
(`MATCHING_TEXT_VERSION`) re-embeds every profile once, and nothing else does.
"""

from __future__ import annotations

import re

from app.news.entities import core_name

#: Part of every profile's content hash. Bump it when the rule below changes,
#: and the next load re-embeds everything the change affects.
MATCHING_TEXT_VERSION = "strip-own-name-v1"

#: Shorter names are not stripped: a one- or two-letter core name ("X") would
#: match ordinary words, and the damage would land on exactly the text that
#: carries the topic.
MIN_STRIPPED_NAME_LENGTH = 3


def _phrase(text: str) -> re.Pattern[str]:
    # Word-bounded without \b, because names end in "." or "," and \b fails there.
    return re.compile(rf"(?<!\w){re.escape(text)}(?!\w)", re.IGNORECASE)


def matching_text(name: str | None, asset_class: str, description: str) -> str:
    """`description` with the instrument's own name replaced by a neutral subject."""
    subject = "The fund" if asset_class == "etf" else "The company"
    text = description
    phrases = ((name or "").strip(), core_name(name))
    for phrase in dict.fromkeys(p for p in phrases if len(p) >= MIN_STRIPPED_NAME_LENGTH):
        text = _phrase(phrase).sub(subject, text)
    return text
