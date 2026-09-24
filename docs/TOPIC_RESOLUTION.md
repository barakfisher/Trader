# Topic resolution — design, measurements and backlog

How a free-text topic ("Uranium & Nuclear Energy", "chips") becomes candidate instruments (PRD
FR-10), what has been measured, and what to try next. Written at the end of M5 slices 1–2
(2026-09-24) so that resolution work can be resumed without re-deriving any of it. The code is
`services/ai/app/topics/resolution.py`; every constant there carries the measurement it came from.

---

## 1. How it works today

1. **Universe.** Every US primary-exchange stock with a market cap ≥ $1B and every ETF with net
   assets ≥ $100M, screened from Yahoo — 5,294 instruments (2,592 stocks, 2,702 ETFs) as of
   2026-09-24T12:04Z. Membership, facts and ETF top-10 holdings are committed under
   `data/universe/`; Yahoo's business descriptions are not (licence), and live in a gitignored file
   and the database.
2. **Matching text.** Each description is embedded (`openai/text-embedding-3-small`) with the
   company's own name replaced by "The company" — names caused most false matches.
3. **Gate.** A stock is on topic if its cosine is within `BAND` (0.11) of the best match and ≥
   `CANDIDATE_FLOOR` (0.33); at most `MAX_ADMITTED` (30). A topic whose best match is below
   `NOTHING_BELOW` (0.32) resolves to nothing.
4. **Holdings.** Up to 3 ETFs above `ETF_SOURCE_FLOOR` (0.29) whose own holdings are about the
   topic (`COHERENCE_BAND` 0.13) are its sources; their matched top-10 holdings join the candidates
   without passing the gate, each carrying `held_by`.
5. **Meanings.** Candidates are grouped by description similarity; two unrelated groups are offered
   as separate interpretations. *Dormant on current data* — no fitting topic splits.
6. **Order.** Largest first (market cap / net assets), 15 per interpretation. The rationale is a
   sentence quoted verbatim from the description.

All thresholds were fitted on `threshold_fitting_topics` in `data/eval/topics.json` — topics written
before measuring and disjoint from the eval by test — never on eval cases.

## 2. Scoreboard

Same universe and embeddings for every row; only the resolver differs.

| Resolver | Primary suite (20 cases) | Batch 2, held out (11 cases) | Batch 2 expected tickers |
|---|---|---|---|
| Description similarity, ranked by similarity (first run) | 6/20 | — | — |
| Slice 1: + name stripping, gate, size order, meanings | 5/20 | 1/11 | 14/35 |
| Slice 2: + ETF holdings | **9/20** | **1/11** | **14/35** |

**The held-out row is the one that counts.** The primary suite shaped three design rounds; batch 2
was written by the user after the first run and kept unrun until slice 2 was final. Slice 2 gained
four primary cases and nothing held out. **Batch 2 is now spent** — see §5.

What did improve on held-out data: the nothing/something boundary. On the user's held-out topics
the `NOTHING_BELOW` line now sits inside the gap (lowest real topic 0.375, highest nonsense 0.307);
before name stripping it did not.

## 3. Why cases fail — measured causes

| Cause | Examples | Evidence |
|---|---|---|
| **One outlier sets the gate.** The band hangs off the single best match | "satellites": Planet Labs 0.52 → line 0.41, ASTS (3rd by similarity) excluded; "Defense & Aerospace": a niche firm at 0.62 shut out LMT/NOC/RTX before holdings | slice 2 diagnosis; slice 1 grid |
| **No thematic ETF clears the source floor.** Fund descriptions are index boilerplate | cloud SaaS, e-commerce, obesity drugs, robot surgery, "chips" — no ETF ≥ 0.29 although IBUY/CLOU exist | slice 2 diagnosis |
| **Giants are described too broadly** to sit near any theme | PLTR 0.32 for defense; AMZN, MSFT, GOOGL, ABT ranked > 100 | slices 1–2 |
| **Short phrasings are weak or ambiguous** | "robot surgery" best 0.378; "chips" matched potato chips first | slice 1 |
| **Top-10 holdings only** | QTUM (equal-weight) omits IONQ/RGTI; IBUY omits AMZN | slice 2 probe |
| **Universe excludes OTC ADRs** | LVMUY (LVMH) cannot be offered at all | batch 2 |

## 4. Backlog, in the order I would do it

Each item says what it fixes, how to test it, and its risk. **Item 0 is a prerequisite for all
others**: without an unseen batch, any change can only be measured on data that shaped it.

0. **A new held-out batch (batch 3).** 10–15 topics with tickers, written by the user without seeing
   these results, recorded `sealed: true` and not run until a change is final. Include short
   phrasings; they are the weakest and most realistic.

1. **Robust gate reference.** Hang `BAND` off the *k*-th best similarity (k = 3–5) or the mean of the
   top *k*, not the single best. Fixes the outlier cause directly (satellites, defense). Tested once
   on pre-name-stripping vectors, where it did not help — re-measure on current vectors, on the
   fitting topics first. Risk: low; one constant.

2. **Rank fusion instead of gate-then-sort.** Order candidates by reciprocal-rank fusion of their
   similarity rank and their size rank, instead of a hard gate followed by a pure size sort. Softens
   both failure directions: a pure play just under the line is not silently dropped, and a large but
   tangential company is not automatically first. M3 already has `reciprocal_rank_fusion`
   (`app/corpus/retrieval.py`). Risk: medium — changes every list; measure on fitting topics by eye.

3. **Hybrid lexical + vector for topics.** `instrument_profiles.text_search` (a tsvector over the
   matching text) already exists and is unused. Phrases like "robotic surgery", "rare earth",
   "satellite" are literal in the descriptions that matter. Reuse M3's hybrid, **with the lexical
   half strict (AND)** — M3 measured that an OR'd lexical half dragged a semantic vector half from
   5/6 to 4/6. Risk: medium.

4. **Query expansion without a model: pseudo-relevance feedback.** Embed the topic, take the
   centroid of its top-*k* profile vectors, re-query with a blend (Rocchio). No dictionary to
   maintain, no model on the hot path, deterministic. Targets short phrasings ("robot surgery",
   "cyber"). Risk: drift — on an ambiguous topic the centroid can lock onto the wrong meaning, so
   apply it per interpretation, not before splitting. (LLM expansion is the alternative: cheap
   per call, but non-deterministic and it puts a model on the hot path — the user set it aside.)

5. **Better ETF sources.** (a) Match topics against ETF *names*, which are short and thematic, not
   their boilerplate descriptions — fixes "no ETF clears the floor". (b) Deeper holdings from issuer
   holdings files (iShares/SPDR publish full CSVs) — fixes the top-10 limit. (c) Revisit
   `COHERENCE_BAND`: NLR (holds BWXT) was dropped at 0.35 vs a 0.37 line. Risk: (b) is a new data
   source to maintain.

6. **OTC ADRs above a high size floor** (e.g. ≥ $10B): LVMH, Hermès, Nestlé, Toyota's peers trade
   only OTC in the US. Risk: the preferred/duplicate-listing rules need re-checking for ADRs.

7. **Disambiguation, re-fitted.** `MEANINGS_SPLIT_BELOW` was fitted before name stripping and has no
   positive fitting example left. Write ambiguous fitting topics that genuinely split on current
   vectors before trusting it.

8. **The product answer.** A confirmation screen where the user adds a ticker the resolver missed
   closes the gap regardless of recall — this is the next milestone's work (Topic CRUD &
   Confirmation), and the M5 exit criterion is a *confirmed* set, not a perfect suggestion list.

## 5. Tried and rejected — do not retry without new evidence

| Idea | Result | Why rejected |
|---|---|---|
| Size-scaled gate (mega-caps need lower similarity) | primary 3 → 8/17 at k = 0.06 | put NVDA and MSFT at #1–2 for "video game publishers", Fastenal under "fast food", Welltower under data centres; lost payments-fintech |
| Hand-written query expansion dictionary | not built | fits the topics already seen; does nothing for an unanticipated one |
| Raising `CANDIDATE_LIMIT` to fit eval ranks | not done | a must-include symbol ranked 17th is a ranking finding, not a reason to show more |
| Consensus (held by ≥ 2 source ETFs) | measured | dropped XOM/CVX, Roblox/NetEase, Wheaton; kept Amgen/Gilead for gene editing |
| Similarity floor on held-only candidates | measured | relevant ones as low as 0.28, irrelevant as high as 0.41 — no line exists |
| Instruments as a third namespace in `kb_chunks` | not built | HNSW post-filtering (`ef_search` 40) would silently starve `/ask` |

## 6. How to measure

```bash
cd services/ai
python scripts/run_topic_eval.py [--verbose] [--unseal]   # keyed embedder only; refuses the fixture
```

`--verbose` prints every interpretation with similarity, `held_by` and rationale. The report also
re-derives the `NOTHING_BELOW` separation on the fitting set and on the eval. To compare two
resolvers fairly, run both against the same database (check out the old one in a temporary
worktree) — that is how the scoreboard above was produced.
