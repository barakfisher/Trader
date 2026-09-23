"""Assembles the configured embedder. The only place that names one.

`build_embedder` is to the corpus what `build_llm` is to narration: the one
function that reads configuration and decides which adapter exists. Callers
receive a `BaseEmbedder` and never learn which one, which is guideline 6 and the
reason the interface was written before the second implementation.

**It raises on an unknown name rather than degrading, and that is a deliberate
departure from `build_llm`.** Narration is optional by design, so a broken LLM
setting must not take the rest of the service down with it - there is a
`NullProvider`, and a badge on the dashboard telling the user narration is off.
There is no equivalent here, because there is no honest null embedding. An
embedder that returned nothing would leave retrieval running on its full-text
half alone while still reporting scores, ranks and an ordering: a product that
looks like it is searching and is doing half of it, with nothing saying so. The
whole of this repository's guideline 7 is that an unavailable thing is reported
as unavailable. So a misconfigured embedder stops ingestion, loudly, at the point
where it is cheap to fix.

**Adding the paid provider is a new module and one branch below.** That is the
test of whether the interface earned its place, and it is written down so the
session that does it can check the claim rather than take it on faith: if adding
`openrouter` here requires touching `ingest.py`, `vector_store.py`, `retrieval.py`
or a router, something in this layer is wrong and the fix belongs there, not in a
special case here.
"""

from __future__ import annotations

from app.config import Settings
from app.core.logging import get_logger
from app.corpus.embeddings import BaseEmbedder
from app.corpus.hashed_embedder import HashedEmbedder

log = get_logger("corpus.embedder_factory")


class EmbedderConfigurationError(RuntimeError):
    """`EMBEDDINGS_PROVIDER` names something this service cannot build."""


#: Providers that exist today. `openrouter` is the owed migration and is listed
#: in the error below rather than here, so an operator who sets it is told it is
#: planned and not implemented - which is a different thing from a typo, and the
#: two should not produce the same message.
_KNOWN = ("fixture",)

_PLANNED = {
    # Named explicitly because every .env written from the M0 example carries
    # it: the placeholder block predated any of this and guessed at a provider
    # nobody implemented. Without this entry an upgrade greets those
    # installations with "not a known embedder", which reads like a typo they
    # did not make. Telling them the value is obsolete and what to put instead
    # is the difference between a ten-second fix and a debugging session.
    "fastembed": (
        "no fastembed adapter was ever written; this value is an M0 placeholder "
        "from .env.example - set EMBEDDINGS_PROVIDER=fixture"
    ),
    "openrouter": (
        "the OpenRouter embeddings adapter is not implemented yet; it is owed once "
        "the workspace spend cap allows a paid model (see .claude/MEMORY.md)"
    ),
    "openai": (
        "no direct OpenAI embeddings adapter exists; the intended production route "
        "is openai/text-embedding-3-small through OpenRouter"
    ),
}


def build_embedder(settings: Settings) -> BaseEmbedder:
    """Build the embedder named by `EMBEDDINGS_PROVIDER`.

    Raises `EmbedderConfigurationError` for anything it cannot build, in every
    environment - see the module docstring for why this does not degrade.
    """
    name = settings.embeddings_provider.strip().lower()

    if name == "fixture":
        embedder = HashedEmbedder()
        log.info(
            "corpus.embedder_selected",
            provider=name,
            model=embedder.model,
            dimension=embedder.dimension,
            # Said out loud on every start, because the one thing an operator
            # must not conclude from a working search is that the embedding half
            # of it means anything. See hashed_embedder.py.
            semantic=False,
        )
        return embedder

    planned = _PLANNED.get(name)
    if planned is not None:
        log.error("corpus.embedder_not_implemented", provider=name)
        raise EmbedderConfigurationError(f"EMBEDDINGS_PROVIDER={name!r}: {planned}")

    log.error("corpus.unknown_embedder", provider=name, known=list(_KNOWN))
    raise EmbedderConfigurationError(
        f"EMBEDDINGS_PROVIDER={name!r} is not a known embedder; known values are "
        f"{', '.join(_KNOWN)}"
    )
