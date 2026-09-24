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

**Adding the paid provider was a new module and one branch below, as claimed.**
Slice 2 wrote that down as a falsifiable prediction - if adding `openrouter` had
required touching `ingest.py`, `vector_store.py`, `retrieval.py` or a router,
something in this layer was wrong. It required none of them: `OpenRouterEmbedder`
plus the branch below, and the call sites did not move. Recorded because the
claim is cheap to make and was worth checking, and because the same standard
applies to the next provider.
"""

from __future__ import annotations

from app.config import Settings
from app.core.logging import get_logger
from app.corpus.embeddings import BaseEmbedder
from app.corpus.hashed_embedder import HashedEmbedder
from app.corpus.openrouter_embedder import OpenRouterEmbedder

log = get_logger("corpus.embedder_factory")


class EmbedderConfigurationError(RuntimeError):
    """`EMBEDDINGS_PROVIDER` names something this service cannot build."""


#: Providers that exist today.
_KNOWN = ("fixture", "openrouter")

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
    "openai": (
        "no direct OpenAI embeddings adapter exists; the intended production route "
        "is openai/text-embedding-3-small through OpenRouter - set "
        "EMBEDDINGS_PROVIDER=openrouter"
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

    if name == "openrouter":
        if not settings.openrouter_api_key:
            # The same refusal as an unknown name, for the same reason: there is
            # no honest null embedding, so a provider that cannot authenticate
            # stops the caller rather than quietly handing back the fixture and
            # letting a corpus be embedded by something nobody asked for.
            log.error("corpus.embedder_missing_key", provider=name, setting="OPENROUTER_API_KEY")
            raise EmbedderConfigurationError(
                "EMBEDDINGS_PROVIDER=openrouter needs OPENROUTER_API_KEY; set it, or "
                "set EMBEDDINGS_PROVIDER=fixture to embed offline"
            )

        embedder = OpenRouterEmbedder(
            model=settings.embeddings_model,
            base_url=settings.openrouter_base_url,
            api_key=settings.openrouter_api_key,
            timeout_seconds=settings.embeddings_timeout_seconds,
        )
        log.info(
            "corpus.embedder_selected",
            provider=name,
            model=embedder.model,
            dimension=embedder.dimension,
            semantic=True,
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
