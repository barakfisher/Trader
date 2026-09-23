"""The concept corpus: parsing, chunking and ingestion.

`documents` is pure - text in, chunks out - so the chunking rules can be tested
without a database. `ingest` is the part that talks to Postgres.
"""
