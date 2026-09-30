"""Which prices an installation may treat as real.

The fixture provider's prices are invented: constant numbers in a JSON file, so
CI and a keyless demo can run offline. That is honest in an installation whose
chain *starts* with `fixture` - everything it shows is the demo. It is not honest
as a fallback behind a real provider, which is how this machine's `.env` had it
(`yfinance,fixture`): when Yahoo failed, the chain answered with a fixture price,
the backfill stored it among real closes, and on 2026-09-23 the drawdown rule
reported "NVDA is -48.6% from its 30-day high" from a fixture $118.45 beside real
closes near $218. Guideline 7 says an unavailable price is null - never invented.

So a real installation (one whose chain does not start with `fixture`):
- does not consult the fixture provider at all (`admissible_chain`), so a
  failure upstream leaves a holding unpriced; and
- does not read fixture rows already stored in `quotes` (`excluded_price_sources`).

The `.env` / `.env.example` asymmetry is untouched: the example keeps
`fixture,yfinance`, so a fresh clone and CI stay offline and keyless.
"""

from __future__ import annotations

from collections.abc import Sequence

FIXTURE = "fixture"


def is_demo_chain(chain: Sequence[str]) -> bool:
    """True when the installation runs on fixture prices first: a demo or CI."""
    return len(chain) > 0 and chain[0] == FIXTURE


def admissible_chain(chain: Sequence[str]) -> list[str]:
    """The chain with `fixture` removed wherever a real provider comes before it."""
    if is_demo_chain(chain):
        return list(chain)
    return [name for name in chain if name != FIXTURE]


def excluded_price_sources(chain: Sequence[str]) -> tuple[str, ...]:
    """`quotes.source` values a price read must skip in this installation."""
    return () if is_demo_chain(chain) else (FIXTURE,)
