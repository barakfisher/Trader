"""Answering a question: routing it, judging coverage, and building a reply.

Separate from `app/corpus`, which owns the documents and the retrieval over
them. This package owns the decisions made *with* a retrieval result - where a
question goes, whether the corpus covers it, and what a reader is shown when it
does not.
"""
