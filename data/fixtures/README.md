# Fixtures

Deterministic offline data so the whole system runs with **no API keys and no network**:

| File | Used by |
|---|---|
| `instruments.json` | `FixtureProvider` symbol resolution |
| `quotes.json` | `FixtureProvider` prices and FX rates |
| `demo-portfolio.csv` / `.json` | import wizard demo, importer tests |

`MARKET_DATA_PROVIDERS=fixture,yfinance` means fixture symbols answer instantly and
anything else falls through to Yahoo Finance. Set `MARKET_DATA_PROVIDERS=fixture` for a
fully offline run (CI does this), or put `yfinance` first to prefer live prices.

Prices here are plausible but invented. Do not read anything into them.
