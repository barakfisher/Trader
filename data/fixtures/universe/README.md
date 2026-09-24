# Fixture instrument descriptions

`descriptions.jsonl` has eleven short business descriptions, **written for this repository in
our own words**. They are not Yahoo's text, which is licensed and never committed (see
`app/universe/snapshot.py`).

They exist so CI can load a small but real universe. The committed membership and ETF holdings
from `data/universe/` are joined to these eleven descriptions, which lets the compose smoke test
run the resolver's SQL end to end (`search_profiles`, the coverage count, the holdings join). No
other gate reaches that SQL, because the Python suite has no Postgres.

Load them with `python scripts/ingest_universe.py --fixture`. The rows are recorded with a
`fixture:` source and licence, so a database that holds them says so. **Do not load them into a
database you use for real topics.** They cover three themes: uranium, gold mining and surgical
robots. A real load replaces each one, because its text hash differs.

Topic *quality* cannot be judged on them. CI uses the fixture embedder, and the resolver abstains
on it: candidates come back in similarity order and every one is graded `weak`.
