"""The embedder contract: text in, a fixed-width unit vector out.

Everything that turns text into coordinates sits behind this Protocol, for the
same reason `LLMProvider` and `MarketDataProvider` exist (guideline 6, and
DESIGN.md names `VectorStore` explicitly). The interface is not politeness: this
service ships with a deterministic local embedder because CI is hermetic and
keyless, and it is expected to gain a paid provider when the OpenRouter workspace
budget allows one. **Adding that provider must not touch a call site** - not the
ingester, not retrieval, not a router. If it does, this file was written wrong.

**Two methods, not one.** `embed_documents` and `embed_query` are separated
because several real embedding models are asymmetric: they are trained with a
distinct instruction or prefix for the stored passage and for the question asked
of it, and a provider that collapses the two loses accuracy in a way that is
invisible from the outside - retrieval still returns rows, just worse ones. Both
implementations here happen to treat them identically, and the split is kept so
that the adapter which does not can be added without changing what calls it.

**Unit length is part of the contract, not an implementation detail.** The index
is built with `vector_cosine_ops` and the retrieval SQL asks for cosine distance;
every provider normalising to length 1 means cosine and dot product agree, so a
future adapter cannot make ranking subtly wrong by returning unnormalised output.
`EmbeddingError` is what a provider raises when it cannot answer at all.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

#: The width of every vector in this system, and of `kb_chunks.embedding`.
#:
#: It is the width of `openai/text-embedding-3-small`, which is the model this
#: corpus is intended to be embedded by in production - see
#: `alembic/versions/0013_kb_embeddings.py` for the full argument, including why
#: it is deliberately not the width of whatever the fixture embedder finds
#: convenient. A contract test asserts this constant and the migration's agree.
EMBEDDING_DIMENSION = 1536

#: One embedding. A plain list of floats rather than a numpy array: it crosses
#: into SQL as a literal and into JSON as an array, and neither wants a
#: dependency on numpy's dtype rules. These are similarity coordinates, not
#: money - guideline 3's "never a float" is about amounts, and nothing here is
#: ever added to a balance.
Embedding = list[float]


class EmbeddingError(RuntimeError):
    """An embedder could not produce vectors for the text it was given.

    Deliberately one type rather than the four `LLMError` has. The caller's
    response is the same for every cause - leave the chunks unembedded, report
    it, and let the full-text half of retrieval carry the query - because an
    embedding is not something the product degrades *around*, it is something
    ingestion retries on the next run.
    """


@runtime_checkable
class BaseEmbedder(Protocol):
    """Turns text into vectors of `dimension` width, deterministically or not."""

    #: Stable identifier written to `kb_chunks.embedding_model` on every row this
    #: embedder produces, and compared against on the next run to decide what
    #: needs re-embedding. It names the *model*, not the provider, because two
    #: models behind one provider produce incomparable vectors of equal width -
    #: which is the failure this column exists to make impossible.
    model: str

    #: Width of the vectors this embedder returns. Always `EMBEDDING_DIMENSION`
    #: for anything that writes to `kb_chunks`; it is on the interface so a
    #: mismatch can be caught at construction rather than by Postgres rejecting
    #: an INSERT halfway through a corpus.
    dimension: int

    #: Does a call to this embedder cost money per token? False for the fixture,
    #: mirroring `LLMProvider.charges_per_token`. It exists so an operator can be
    #: told which of the two they are running without naming either.
    charges_per_token: bool

    async def embed_documents(self, texts: list[str]) -> list[Embedding]:
        """Embed stored passages, in the order given.

        Returns exactly one vector per input, including for empty strings: a
        caller zipping results back onto chunks must be able to rely on the
        positions lining up, and silently dropping an input would misattribute
        every vector after it.
        """
        ...

    async def embed_query(self, text: str) -> Embedding:
        """Embed one question asked of the corpus."""
        ...
