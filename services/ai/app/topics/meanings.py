"""Does a topic mean one thing or several? Decided by the candidates, not the words.

"chips" is potato chips and semiconductors; "mining" is gold, coal and bitcoin.
A dictionary of ambiguous words would cover the ones somebody thought of. What
separates the meanings is already in the data: the businesses under one meaning
describe themselves alike, and the businesses under two meanings do not. So the
candidates are grouped by how similar their *descriptions are to each other*,
and a topic is ambiguous when that grouping yields two or more real groups.

**Average linkage at `split_below`, not a sector label.** Yahoo's sectors put a
snack maker and a restaurant in different sectors and a chip designer and a
chip-equipment maker in one; description similarity follows the business.
Average linkage merges two groups when their members are, on average, at least
`split_below` alike - so a single odd pair cannot bridge two meanings, which
single linkage would allow.

**Facets are not meanings, and the threshold is where they part.** Every broad
topic splits somewhere if you look closely enough: E&P companies and oilfield
services, restaurants and food distributors. On the fitting topics those facet
pairs sit at 0.405-0.430 mean similarity; bitcoin miners and metal miners at
0.359. The threshold (`resolution.MEANINGS_SPLIT_BELOW`) sits between.

Pure functions over vectors, so the grouping is testable without a database.
"""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np

from app.corpus.embeddings import Embedding


def group(vectors: Sequence[Embedding], *, split_below: float) -> list[list[int]]:
    """Average-linkage groups of `vectors` (by index), merged while similar enough.

    Vectors are unit length (every embedder normalises), so a dot product is a
    cosine. Groups come back largest first, members in input order.
    """
    if not vectors:
        return []
    matrix = np.asarray(vectors, dtype=float)
    similarity = matrix @ matrix.T
    groups: list[list[int]] = [[i] for i in range(len(vectors))]
    # Sum of pairwise similarity between every two groups; the average is this
    # over the product of their sizes. Kept incrementally (Lance-Williams), so a
    # merge costs one row update rather than re-summing every pair.
    sums = similarity.copy()

    while len(groups) > 1:
        sizes = np.array([len(g) for g in groups], dtype=float)
        averages = sums / np.outer(sizes, sizes)
        np.fill_diagonal(averages, -np.inf)
        a, b = np.unravel_index(np.argmax(averages), averages.shape)
        if averages[a, b] < split_below:
            break
        a, b = min(a, b), max(a, b)
        groups[a].extend(groups[b])
        del groups[b]
        sums[a, :] += sums[b, :]
        sums[:, a] += sums[:, b]
        sums = np.delete(np.delete(sums, b, axis=0), b, axis=1)

    for members in groups:
        members.sort()
    return sorted(groups, key=lambda g: (-len(g), g[0]))


def nearest_group(
    vector: Embedding, groups: Sequence[Sequence[int]], vectors: Sequence[Embedding]
) -> int:
    """Index of the group whose members `vector` is most similar to on average."""
    matrix = np.asarray(vectors, dtype=float)
    point = np.asarray(vector, dtype=float)
    scores = [float(np.mean(matrix[list(members)] @ point)) for members in groups]
    return int(np.argmax(scores))
