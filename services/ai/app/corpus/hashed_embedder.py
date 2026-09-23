"""A deterministic, keyless embedder: the hashing trick over word tokens.

**This is the CI path, not scaffolding.** The Python suite is hermetic and has no
API keys, and slice 4's eval set cannot depend on a network call, so an embedder
that needs neither has to exist permanently. It stays in the tree after the paid
provider arrives.

**What it actually does, stated plainly so nobody reads more into a ranking than
is there.** Each token is hashed to a bucket, given a sign from a further hash
bit, weighted by a sublinear term frequency, and the resulting vector is
normalised. Two texts therefore score highly together when they *share words*,
and not otherwise. There is no semantic knowledge in it whatsoever: "how much did
I lose from the top" and "drawdown" have a cosine similarity of essentially zero,
and that single example is the whole reason a paid model is owed. Treat a good
result from this embedder as evidence that the plumbing works, never as evidence
that retrieval works.

**Why lexical rather than random.** The alternative - hash the whole text into a
pseudo-random vector - is simpler and defensible, and it was rejected. Random
vectors make the vector half of hybrid retrieval *untestable*: there is no input
for which a correct implementation returns a particular row, so the ranking SQL,
the fusion and the ordering could all be wrong in CI and look exactly like
working code. A lexical embedder has real, checkable behaviour - a query sharing
words with a chunk must outrank one that does not - so the retrieval path is
exercised by tests rather than merely executed by them.

The honest cost of that choice: this embedder correlates with the full-text half
of the hybrid, so fusing them adds less than fusing two independent rankers
would. That is a property of the placeholder and disappears with the real model,
and it is preferable to a vector half that nothing can check.

**The signed hashing trick, not plain bucket counting.** Collisions are certain -
a few thousand distinct words over 1536 buckets - and unsigned counting makes
every collision add, so a colliding pair inflates similarity in one direction
only. Giving each token a deterministic sign makes collisions cancel on average
instead of accumulating, which is the standard result and costs one extra bit
from a hash already being computed.
"""

from __future__ import annotations

import hashlib
import math
import re
from collections import Counter

from app.corpus.embeddings import EMBEDDING_DIMENSION, Embedding

#: Word-ish tokens. Deliberately the same shape of split for documents and for
#: queries - an embedder whose two halves tokenise differently scores a text
#: against itself at less than 1, which is a bug that looks like tuning.
#: Apostrophes are kept inside a word so "don't" is one token rather than two.
_TOKEN = re.compile(r"[a-z0-9]+(?:'[a-z]+)?")

#: Domain tag mixed into every hash so these buckets cannot coincide with any
#: other hashing in the system, and so a future change of scheme can be told
#: apart by changing this string alone. blake2b's personalisation parameter is
#: capped at 16 bytes, which is why this is terse rather than descriptive; the
#: trailing version is the part that matters.
_DOMAIN = b"traders.corpus.1"


def _tokenize(text: str) -> list[str]:
    return _TOKEN.findall(text.lower())


def _bucket_and_sign(token: str, dimension: int) -> tuple[int, float]:
    """Map a token to a bucket and a sign, deterministically and portably.

    `hashlib.blake2b` rather than Python's `hash()`: `hash()` on a string is
    salted per process, so the same corpus would embed differently on every boot
    and a stored vector could never be compared with a query vector computed
    later. That failure is invisible in a single-process test and total in
    production.
    """
    digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8, person=_DOMAIN).digest()
    value = int.from_bytes(digest, "big")
    # The low bit for the sign and the rest for the bucket, so the two are not
    # read from the same bits.
    return (value >> 1) % dimension, 1.0 if value & 1 else -1.0


class HashedEmbedder:
    """Lexical embeddings with no network, no key and no state.

    Implements `BaseEmbedder`. Construction takes the dimension only so a test
    can exercise collision behaviour at a width small enough to reason about;
    everything that writes to `kb_chunks` uses the default, and the store checks
    the width it is handed rather than trusting it.
    """

    #: Versioned, because it is written to `kb_chunks.embedding_model` and is
    #: what decides whether a stored row needs re-embedding. Changing the
    #: tokeniser or the hash without changing this string would leave a corpus
    #: half-embedded under two incompatible schemes with nothing reporting it.
    model = "fixture/hashed-v1"

    charges_per_token = False

    def __init__(self, *, dimension: int = EMBEDDING_DIMENSION) -> None:
        if dimension < 1:
            raise ValueError("dimension must be positive")
        self.dimension = dimension

    def _embed(self, text: str) -> Embedding:
        counts = Counter(_tokenize(text))

        vector = [0.0] * self.dimension
        for token, count in counts.items():
            bucket, sign = _bucket_and_sign(token, self.dimension)
            # Sublinear term frequency: a word used six times in a section is
            # more about that section than a word used once, but not six times
            # more, and raw counts let one repeated word dominate a short chunk.
            vector[bucket] += sign * (1.0 + math.log(count))

        norm = math.sqrt(sum(component * component for component in vector))
        if norm == 0.0:
            # Text with no tokens at all, or whose tokens cancelled exactly in
            # every bucket. A zero vector must never be stored: pgvector's
            # cosine distance against one is undefined - it yields NaN, which
            # sorts unpredictably and would quietly corrupt a ranking rather
            # than fail. So an unusable text gets a deterministic unit vector
            # that is about nothing in particular, and ranks last against
            # anything real instead of ranking arbitrarily.
            return self._degenerate_vector(text)

        return [component / norm for component in vector]

    def _degenerate_vector(self, text: str) -> Embedding:
        """A unit vector for text that produced no usable tokens."""
        digest = hashlib.blake2b(text.encode("utf-8"), digest_size=8, person=_DOMAIN).digest()
        bucket = int.from_bytes(digest, "big") % self.dimension
        vector = [0.0] * self.dimension
        vector[bucket] = 1.0
        return vector

    async def embed_documents(self, texts: list[str]) -> list[Embedding]:
        return [self._embed(text) for text in texts]

    async def embed_query(self, text: str) -> Embedding:
        # Identical to the document side. The interface keeps them separate
        # because real asymmetric models need them separate; this one has no
        # instruction prefix to differ by, and pretending otherwise would be
        # inventing behaviour.
        return self._embed(text)
