# Architecture Specification — Multi-Agent Trading Sandbox

**Status: approved specification, not yet implemented.** The product and engineering decisions in
this document are settled. What follows is the agreed design and its four-stage execution plan,
written against the system as it exists at PR #40.

**Amended 2026-10-04/05** (at PR #150): further decisions D1–D16 (§10), the schema as measured that day
(§11) and the exact Stage 1 task list (§12). Where §10 and an earlier section disagree, §10 wins, and
the earlier section carries a pointer to it.

A user creates several named **agents**, each with its own analysis philosophy, simulated budget and
domain focus, each keeping its own paper portfolio and sending its own proposals. The user's real
portfolio is one of these agents — the primary one, shown as **"Main portfolio"** — and is never
simulated, never raises a trade proposal, and never spends (§10 D1).

---

## 1. Prior art in this repository: none

Searched `docs/{PRD,DESIGN,FLOWS,MILESTONES}.md` and all source for `multi-agent`, `persona`,
`agent_id`, `custom agent`, `sub-portfolio`. **Nothing exists.** No milestone, no functional
requirement, no parked branch, no column, no seam. The single textual match was PRD P2's
"personalized", which is a prohibition rather than a plan.

The nearest existing concepts, and their distance:

| Concept | What exists | Distance |
|---|---|---|
| Portfolio | One per user, `holdings UNIQUE (user_id, instrument_id)` | The constraint forbids two portfolios per user |
| Proposal | `PROPOSABLE_KINDS` = `{allocation_drift: 'rebalance'}` — one entry | No buy/sell proposal kind exists |
| Ledger | `intents`, one row per approved proposal | Records assent; holds no cash, no fill, no position accounting |
| Tunable rules | `AnalysisThresholds`, injected, rules hold no numbers | Already agent-shaped — see §4.2 |

---

## 2. PRD P2: the agreed amendment

The feature places a persona-bearing agent in front of the user proposing a sized transaction in a
named instrument. Under PRD P2 as written — *"No personalized advice, no price targets, no position
sizing recommendations"* — that is prohibited. **P2 is amended rather than excepted**, so the
boundary is stated once in the product contract instead of remembered in review.

The agreed scoping: the prohibition continues to apply in full to the user's **real** portfolio.
Simulated agents may propose sized transactions within their own paper budget, guarded by three
things that must ship with them:

1. **Proposal-only, absolutely.** No agent executes anything. An approval writes to the virtual
   ledger, as it does today. This does not change and is not scoped — it is P1, untouched.
2. **The agent scoring framework (§6).** An agent that proposes and is never measured is a persona
   generating confident noise. Scoring is what makes the feature a teaching instrument rather than
   an advice channel, and it is therefore a prerequisite of the amendment, not a follow-up to it.
3. **Simulation framing at every surface.** A simulated proposal is labelled as an agent's
   hypothetical in the UI, in Telegram and in the digest. The disclaimer P2 already requires stays.

The corresponding edit to `docs/PRD.md` ships with this document.

---

## 3. Stage 1 — Database, isolation and the three broken constraints

No user-visible feature. This stage moves the system from "one portfolio" to "N portfolios, of which
one is real". Everything else depends on it and nothing else is safe before it.

### 3.1 The `agents` table

```sql
CREATE TABLE agents (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slug          text NOT NULL,              -- 'primary-portfolio' for the seeded row
    name          text NOT NULL,
    persona       text,                       -- display + prompt material; NULL for the primary
    philosophy    text NOT NULL CHECK (philosophy IN ('deterministic','llm','hybrid')),
    domain        text NOT NULL DEFAULT 'freehand',
    is_primary    boolean NOT NULL DEFAULT false,
    budget_minor  bigint,                     -- NULL for the primary: a real portfolio has no cap
    currency      text NOT NULL DEFAULT 'USD',
    scan_cadence  text NOT NULL,              -- see §7.1
    thresholds    jsonb NOT NULL DEFAULT '{}'::jsonb,   -- overrides AnalysisThresholds
    state         text NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused','archived')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, slug),
    UNIQUE (user_id, name),
    -- A primary agent is the real portfolio, so it cannot be simulated in any respect.
    CONSTRAINT agents_primary_is_real CHECK (
        NOT is_primary OR (philosophy = 'deterministic' AND budget_minor IS NULL AND persona IS NULL)
    )
);

CREATE UNIQUE INDEX agents_one_primary_idx ON agents (user_id) WHERE is_primary;
```

**`agent_id` stays a `uuid` foreign key.** `primary-portfolio` is the seeded row's `slug`, not its
id: a text sentinel in a uuid column cannot be a foreign key, and losing referential integrity on
the column that separates real assets from simulated ones would be the wrong place to save four
characters. Code identifies the primary by `is_primary`, never by matching a magic string.

The `agents_primary_is_real` CHECK is deliberate belt-and-braces. The application must also refuse
to raise a proposal against a primary agent; the constraint is the layer that survives a bug in the
application.

### 3.2 `agent_id NOT NULL` everywhere

Added as `agent_id uuid NOT NULL REFERENCES agents(id)` to: `holdings`, `observations`, `proposals`,
`intents`, `runs`, `portfolio_snapshots`, `target_weights`, `notifications` — and, since PR #40,
`proposal_episodes` (§11 lists the tables that deliberately do not get it, and why).

The migration seeds the primary agent per user and backfills every existing row to it before setting
`NOT NULL`, in that order, in one transaction.

**`agent_id IS NULL` never means "real".** A nullable discriminator is one forgotten
`WHERE agent_id IS NULL` away from presenting simulated holdings as real, and that query will be
forgotten, because `agent_id = $1` reads correct in isolation. A non-null column turns the same
mistake into a missing filter that returns *too much* — which is the failure mode that gets noticed.

`user_id` stays on all of these tables (guideline 5, and the existing `(user_id, created_at DESC)`
indexes stay usable). It is redundant with `agents.user_id`; consistency is enforced by a composite
foreign key on `(user_id, agent_id)` against a matching unique key on `agents`.

### 3.3 The three constraints that break, and their replacements

**(a) `observations.dedupe_key`** — [dedupe.py:35](../services/ai/app/analysis/dedupe.py#L35)

Today the key is `hash(kind | subject_ref | severity | date)`, globally UNIQUE, with no owner
component. Two agents that both notice a 3σ move in NVDA today produce **the same key**, and the
second insert is swallowed as a duplicate — silently, as a missing row rather than an error. That is
precisely the disagreement this feature exists to produce, deleted.

Replacement: `hash(agent_id | kind | subject_ref | severity | date_bucket)`. **Superseded by §10 D13:**
the hash stays as it is and the uniqueness becomes `UNIQUE (agent_id, dedupe_key)`, which separates
agents identically and leaves the 83 stored keys valid.

This re-defines what an observation *is*. Today it is a fact about the market; afterwards it is a
fact about what a given agent noticed. That is the correct meaning for this feature and breaks
nothing currently built, but it is a deliberate re-definition and is recorded here as one.

**(b) `holdings UNIQUE (user_id, instrument_id)`** — [0001_initial_portfolio.py:75](../services/ai/alembic/versions/0001_initial_portfolio.py#L75)

Two agents both holding NVDA is the normal case. Becomes `UNIQUE (agent_id, instrument_id)`. The
importer's merge logic (FLOWS F1) relies on this constraint, so the import path gains an agent
target; imports default to the primary agent.

**(c) `runs.run_key`** — [internal.ts:104](../apps/orchestrator/src/http/routes/internal.ts#L104)

The default key is `kind:userId:bucket`. Agent B's scan collides with agent A's on the same day and
is skipped as already-claimed — silently and correctly, because that skip is the idempotency
guarantee working as designed. The unique becomes `(agent_id, run_key)` and the default key becomes
`kind:userId:agentId:bucket`. **Amended by §10 D13:** the composite unique alone separates agents,
so the primary's key format is unchanged (its in-flight keys stay valid across the deploy);
simulated agents' keys add `agentId` for readability only.

**(d)–(f) Three more, added since PR #40** — measured in §11:
`portfolio_snapshots UNIQUE (user_id, as_of)`, `target_weights PRIMARY KEY (user_id, instrument_id)`
and `proposal_episodes_one_open (user_id, observation_kind, subject_ref) WHERE closed_at IS NULL`.
Each forbids a second agent the same way (b) does, and each is backed by an `ON CONFLICT` target in
the orchestrator; the replacement is `agent_id` in place of `user_id` in all three.

**Shared-ingestion run kinds are attributed to the primary agent.** `backfill` and
`instrument_metadata` fetch data that every agent shares (§4.1); they are not any agent's work. Under
`agent_id NOT NULL` they are recorded against the primary agent, and that is an accounting
convenience rather than a claim. `GET /runs` filtered to an agent must therefore exclude the shared
kinds, or the primary's run history will appear to contain work it did not do.

**Needs no change:** `notifications.dedupe_key` is `hash(channel, ref_kind, ref_id)` and `ref_id` is
a row id, so it separates per agent for free.

---

## 4. Stage 2 — Agents exist (amended by §10 D16)

Own portfolio, own observations, own thresholds, consolidated UI. No LLM, no budget, no proposals.
This stage is cheap and proves the isolation with zero cost exposure. **Amended (D16):** there are no
"deterministic agents" as a product — an agent's decisions come from its persona and tools in stage
4 (D14). What stage 2 keeps is everything that is not a decision: agents can be created, named and
paused, own a portfolio and observations (per-agent `AnalysisThresholds` still apply to the findings
an agent is briefed with, §4.2), and appear in the consolidated view.

### 4.1 Shared ingestion, independent interpretation

```
  SHARED, ONCE PER CYCLE, AGENT-BLIND
    market data  -> providers + Redis cache + rate limiter      (exists)
    news         -> ingestion, dedupe, entities, sentiment      (exists, fixture provider only)
    price series -> normalised, gap-checked                     (exists)
         |
  PER AGENT, OVER THE SAME INPUTS
    universe filter   (domain focus)                            NEW — see §8
    detection         (rules, with per-agent thresholds)        exists, needs parameterising
    interpretation    (philosophy)                              NEW — stage 4
    proposal          (budget-aware sizing)                     NEW — stage 3
```

The existing code already leans this way: `app/analysis/` makes no HTTP calls and touches no LLM, and
the market-data registry owns cache, rate limiter and per-provider daily budget. Raw data is fetched
once globally and shared; nothing in this feature adds a second fetch path.

### 4.2 A deterministic agent is mostly a configuration row

`AnalysisThresholds` ([thresholds.py](../services/ai/app/analysis/thresholds.py)) exists precisely so
"the same code has to serve someone who wants to hear about every 2% move and someone who only wants
shocks", and `from_settings` is its only bridge to global config. Building one per agent from
`agents.thresholds` requires **no change to any rule**. This is why stage 2 is the cheap half of the
feature and why it comes before anything that spends money.

### 4.3 UI: consolidated master view

**Default dashboard — one consolidated row per instrument**, showing the user's total holding of that
instrument across all agents. Expanding a row reveals the per-agent breakdown (Main Portfolio 10
shares · Agent C 2 shares) together with any pending proposals on that ticker.

**Global agent filter**, three modes: `All (Consolidated)` · `Primary / Real Portfolio Only` ·
individual agent views.

**Every consolidated figure carries a real/simulated split.** A blended total is the one place this
design can mislead — a user glancing at a number that silently mixes twelve real shares with two
imaginary ones has been told something false. The consolidated row therefore shows the split
inline, and the portfolio-value headline shows real and simulated as two figures, never one sum.
This follows the existing partial-snapshot precedent: degraded and simulated states are *marked*,
never blended into a figure that reads as authoritative.

Pending proposals never affect holdings or portfolio value. They are visible, and that is all.

---

## 5. Stage 3 — Budget, fills and scoring

**Amended (D16):** no agent decides anything yet. The ledger — cash, fees, fills, approval and
scoring — is built and proven with **manual trades** the user places into an agent's account
(§5.3), so every money path is tested before a model is allowed to propose through it. This is the
point at which the ledger can be right or wrong, and it is the
largest genuinely new subsystem: the system has no cash concept today. `intents` records what the
user assented to and holds no balance, no fill price and no position accounting.

### 5.1 Cash and fills

- `agent_cash(agent_id, balance_minor, currency)` — integer minor units, `Decimal` in Python,
  integer arithmetic in TypeScript (guideline 3).
- A **fill** is written at approval, carrying quantity, price, timestamp and the id of the quote it
  came from.
- **The fill uses the quote stored on the proposal, never a live re-fetch at approval time.** A
  re-fetch records a price nobody was shown and makes the ledger disagree with the question the user
  answered. This is also why P4's TTL matters more here than anywhere: a proposal whose stored quote
  has gone stale must expire and be re-derived, not fill at a price from an hour ago.
  **Superseded by §10 D3–D4:** the fill uses a live quote taken at approval, accepted only inside a
  server-computed range around the shown quote, inside the TTL and while the exchange is open — and
  the confirmation states both prices. The objection above is answered by the range: the fill can
  differ from what the user saw only by an amount they were shown in advance.
- **An out-of-budget proposal is rejected, not clamped.** Silently resizing an order the user
  approved changes what they agreed to.
- Cost basis per unit; totals computed at read time (guideline 3).

### 5.2 Proposal lifecycle and the two approval paths

The existing state machine — `pending · approved · rejected · snoozed · expired`
([proposalState.ts:31](../apps/orchestrator/src/services/proposalState.ts#L31)) — **gains no new
state.** "Executed" is not a state; it is the fill that approval writes. The unique index on
intents — since PR #40 `intents_one_live_per_proposal (proposal_id) WHERE revoked_at IS NULL`,
because an approval can now be revoked — makes a second approval a no-op at the database level, so
an idempotent double-tap cannot produce a second fill. That guarantee extends to fills, with one
addition revocation forces: **revoking an approval whose fill has been written must not delete the
fill.** It writes a reversing fill at the then-current quote, or it is refused — decided in stage 3.

**Approval from the dashboard is a first-class path, not a fallback.** Telegram may be unbound,
delayed or failing — per the current handoff, it is in fact unproven end to end — and a proposal that
can only be answered through a channel that may not deliver is a proposal that expires unanswered.
Both paths call the same transition function; only the audit row's recorded channel differs.

### 5.3 Manual trades

A trade the user places directly into an agent's account is recorded with
`source: 'manual_user_override'`, distinct from `source: 'agent'`. **Scoring excludes manual
overrides.** Otherwise a user who rescues a losing agent by hand credits the rescue to the agent's
philosophy, and the scoreboard stops measuring the thing it exists to measure.

### 5.4 Agent performance scoring

Per agent, over rolling 30 / 60 / 90-day windows:

- realised and unrealised P&L, in base currency;
- win rate over closed positions;
- return versus a benchmark, and versus the user's real portfolio.

Every figure is computed from stored fills and stored quotes, and an unpriced position makes the
window's return **unavailable rather than partial** — the same refusal `allocation_drift` already
makes, for the same reason: a systematically wrong comparison against a number the user is
evaluating is worse than silence.

---

## 6. Stage 4 — LLM philosophy

Gated on stage 3 shipping, on M3 (RAG), on a real news provider, and on a funded LLM workspace.

### 6.1 Artifact caching, and why idempotency survives

Guideline 8 says runs are idempotent. [sentiment.py](../services/ai/app/news/sentiment.py) already
refused an LLM scorer for exactly this reason: *"a model's score is not reproducible, so a re-run
over unchanged data could produce a different opinion and therefore a different observation."* An
LLM-philosophy agent is that argument at the centre of the product.

**Superseded by §10 D15.** An agent that chooses its own tool calls cannot have its evidence hashed
before it runs, so the cache below cannot be keyed in advance. Idempotency is kept instead by the
run key (a scan of a bucket runs once) and by storing each decision with the full transcript of the
tools it called; a re-run of the same bucket is skipped, not re-asked. The original text follows.

**Resolution: detection stays deterministic and shared; the agent's judgement becomes a stored
artifact keyed `(agent_id, finding_set_hash, date_bucket)`**, where `finding_set_hash` covers the
evidence the judgement was formed on. A re-run recomputes the hash, finds the row, and reuses the
judgement rather than re-asking the model. The opinion changes only when the evidence changes —
which is what a consistent philosophy ought to mean, so the constraint and the product intent point
the same way. Re-running is therefore free and exactly reproducible.

This is the existing decision 3 ("identity is decided before narration") applied one layer up.

### 6.2 The evidence validator applies unchanged

An agent's rationale is generated text with figures in it, and every figure must appear in the
evidence. This matters more for agents than for narration: a persona is a licence to sound
confident, and the validator is what stops confidence from becoming fabrication.

**Today this means an LLM agent would produce no rationale at all.** The OpenRouter workspace has a
*lifetime* $0.01 cap, and on the free model the validator rejects narration 3/3 for unsourced
figures. Stage 4 cannot begin before that is funded — this is a blocking dependency, not a
degradation.

### 6.3 Per-agent LLM budgets

`LLM_DAILY_BUDGET_USD` is a **single global guard**. N agents scanning daily race for one pot and
whichever runs last silently gets nothing, non-deterministically. Per-agent budgets are required and
belong in the existing budget module, with the global cap retained above them as a ceiling.

---

## 7. Scheduling

### 7.1 Fixed daily scans, off-peak

LLM agents scan twice daily: **pre-market open and post-market close**. Both enter through
`POST /internal/runs` with a run key, like all scheduled work, and take their own
`RUN_BUCKET_MINUTES` entry. Deterministic agents may keep the existing 30-minute cadence; their cost
is a database read.

**This makes market holidays material for the first time, and the answer is already decided.**
Existing decision 1 rejected a market-status API on the pricing path and recorded the alternative it
would accept: *"If scheduled scans ever make holidays material, the answer is a static calendar
applied at the scheduler, not a network call per quote."* A fixed pre-open/post-close schedule is
exactly that trigger. A static exchange calendar at the scheduler is therefore part of this stage.

Note also that "pre-market open" resolves against the **exchange's** calendar and timezone, not
`APP_TIMEZONE` (`Asia/Jerusalem`). The user's timezone continues to govern "today" for digests and
daily buckets; it does not govern when a US market opens.

### 7.2 Telegram

The existing `telegram_bindings` constraint is kept unchanged: `user_id PRIMARY KEY`, `chat_id
UNIQUE`, one chat per user. Agents do not get their own chats — N agents × N chats is a notification
volume problem wearing an architecture costume.

- **`agent_id` is included in the signed callback payload.** Without it, a signed callback minted for
  one agent's proposal can be replayed against another's.
- **The agent's name and persona badge appear in the message body**, so the sender is unambiguous in
  a single shared chat.
- **Per-agent severity floors default higher than the primary's.** Five agents on a daily cadence is
  five times the message volume against quiet-hours and digest policy that was tuned for one.

---

## 8. Remaining dependency: domain focus

Domain focus filters the **universe**, before detection — filtering afterwards wastes the detection.
But "Biotech" is not a fact the system holds: `instruments` has no sector column (migration `0010`
added display names only). And "Freehand / unrestricted" implies an instrument universe that does not
exist either, since today's universe is exactly what the user imported.

**This is M5's problem** — topic resolution to candidate instruments with confidence and rationale —
and this feature should be sequenced after it rather than solving it twice. Until M5 lands, an
agent's universe is the union of the user's imported instruments, and `domain` is recorded but not
enforced.

---

## 9. Execution plan

| Stage | Contents | Gated on |
|---|---|---|
| **1 — Isolation** | `agents` table, primary seeded + backfilled, `agent_id NOT NULL`, the six constraint replacements (§3.3, §11), the passive primary (D1) — tasks in §12 | — |
| **2 — Agents exist** | Create, name, pause; per-agent portfolios, observations and `AnalysisThresholds`; consolidated UI with filter and split figures. No decisions (D16) | Stage 1 |
| **3 — Budget, fills, scoring** | `agent_cash`, fees (D6), fills from a live quote inside the range (D3), TTL from the next open and the exchange calendar (D4), dashboard + Telegram approval, `manual_user_override`, 30/60/90-day scoring — all proven with manual trades (D16) | Stage 2 |
| **4 — The deciding agent** | Persona + tools decide (D14), briefing then read-only tool calls with a step limit and a stored transcript (D15), tool calling in the provider, reasoning in `services/ai` with a hand-written loop or core LangGraph by comparison and no checkpointer (D10), per-agent budgets (D12), pre-open/post-close schedule, persona rationale behind the validator, urgent sells through quiet hours (D5) | Stage 3; a paid model (§11 — M3, M5 and GDELT news have since landed, and the workspace is funded) |

The PRD P2 amendment (§2) ships with stage 1, since it is the boundary the whole feature stands on.

---

## 10. Amendment of 2026-10-04 — decisions

Settled in a planning conversation with the user before any code, against the measurements in §11.
Each records the alternative it rejected and the failure it prevents.

**D1 — The primary agent, "Main portfolio", is passive.** It holds the imported portfolio and is
never the subject of a trade proposal (`BUY`/`SELL` with a quantity, a fill or a cash effect), at any
stage, under any circumstances. The existing `rebalance` proposal continues on it: §11 shows its
payload is `{subjectRef, observationKind}` — an acknowledgement that an allocation drifted, with no
side, no quantity and no fill — so it is an observation the user answers, not a trade. Enforced in
three layers, so a bug in one is caught by the next: the agents CHECK (§3.1), an application refusal
in `services/proposals.ts`, and a database trigger that rejects any proposal kind other than
`rebalance` against a primary agent (§12 PR 4; triggers have precedent in `0026_admin_audit`).
*Rejected:* relying on the absence of a code path. "Nothing calls it" is true today and is not a
property anything checks.

**D2 — Budgets are notional.** `agents.budget_minor` is a simulated starting balance the user types.
It is taken from nothing: the real portfolio is imported holdings and holds no cash, and moving real
money into a paper account would blend the two things this feature most needs kept apart. Cash rises
only on a sell or an explicit top-up, recorded as its own ledger row.

**D3 — Approval re-checks a live quote inside a server-computed, two-sided range.** At proposal time
the server stores the quote it showed and computes `min/max = quote × (1 ∓ range_bps / 10 000)`,
`range_bps` per agent, default **50** (±0.5%). The model never supplies a bound (guideline 7). On
approval the server fetches a live quote and fills only if it is inside the range, the proposal is
inside its TTL, the exchange is open, and — in the same transaction, with the agent's cash row
locked — the recomputed cost plus fee is within cash. Any failure cancels with the reason; nothing is
resized (§5.1). Two-sided because a sharp move in the user's favour can also mean the thesis changed.
The confirmation states the price shown and the price filled.

**D4 — The TTL starts at the next market open.** `expires_at = max(created_at, next_open) + TTL`
(P4's 60 minutes). Without it every post-close proposal (~23:00 Israel time) would expire before the
US open, unanswered. Approval while the market is closed is refused rather than filled at the open,
because a fill price nobody can know when they tap is the thing D3 exists to prevent. This makes the
static exchange calendar (§7.1) a stage-3 deliverable, not a stage-4 one.

**D5 — Urgent sells break quiet hours; nothing else does.** A high-severity `SELL` of a position the
agent already holds is delivered through quiet hours. Every other agent message follows the existing
policy. Stop-losses are **alerts only**: an urgent proposal the user must approve, never an automatic
fill (P1, and the HITL framing of the whole feature).

**D6 — Fees are integer basis points, rounded up.** `fee_minor = max(MIN_FEE_MINOR,
ceil(notional_minor × FEE_BPS / 10 000))` with `FEE_BPS = 10` (0.1%) and `MIN_FEE_MINOR = 150`
($1.50), on both buys and sells, as `bigint` in TypeScript and `Decimal` in Python (guideline 3), in
one module per language named for the concept (`fees.ts`, `fees.py`), with tests asserting the
constants rather than their values (CLAUDE.md, convention 1). Rounding up keeps the cash check
conservative. Net worth is `cash + market value`; fees already left cash, so they are shown as a
figure and never subtracted a second time. P&L is `net worth − (budget + top-ups)`.

**D7 — USD-listed instruments only, in v1.** The $1.50 minimum is a USD amount, and agents with
non-USD instruments would need FX on fees, fills and cash. Refused at proposal time, not filtered
after.

**D8 — The tradable universe is the whole M5 universe** (5,225 profiles measured), not only the
imported instruments. `agents.domain` is stored and shown but not enforced until a later decision.

**D9 — Whole shares only.** Quantities still cross the wire as decimal strings (guideline 4); the
rule is a validation, not a type change.

**D10 — Reasoning runs in `services/ai`; the framework is chosen by comparison in stage 4.** The AI
service already owns the LLM provider factory, the evidence validator and the LLM budget; running the
reasoning anywhere else would duplicate all three. The first stage-4 PR builds the same scan twice —
a hand-written, step-bounded tool loop over the provider factory, and a LangGraph `StateGraph` using
only the core graph (no prebuilt agents, no LangChain chat models, no LangSmith) — and keeps the one
that is smaller and clearer. LangGraph earns its place if routing grows (conditional sub-agents,
retry paths, parallel analysts); a nearly linear pipeline does not need it. **Either way, no
checkpointer:** it would create and own Postgres tables, the trap Mastra set in migration 0008 and
that cost an outage in #150. Each scan is one stateless run whose result is stored as the judgement
artifact keyed by evidence hash (§6.1), with a hard step limit, which is what makes a per-agent
budget (D12) an actual bound.

**D11 — Mastra is retired; waiting for the user is a database row and a sweep.** This reverses
decision 11. Measured: nothing under `mastra/` decides anything; every entry point already falls
back to the direct path; what runs after a resume is "terminate and report"; and a pending
proposal survives a restart because the `proposals` row holds its state and `expires_at`, and the
`proposal_sweep` run expires it — not because of the suspended snapshot. The approval flow ran
broken through Mastra from 0033 to #150 without the product depending on it. Stage 3 gives it no new
work: the fill must be written atomically with the approval inside `applyDecision` (D3's cash lock),
never in a step after a resume, where a crash would leave an approval without a fill. A trade
proposal therefore follows the same path as a rebalance: row, `applyDecision`, sweep. The dashboard is
a first-class approval path (§5.2); Telegram arrives by long-polling, and nothing depends on the
transport. Retiring Mastra is its own PR, outside Stage 1: remove the workflow and the dependency,
keep the direct path, drop the `mastra` schema in a later migration once no suspended run remains.
**Done 2026-10-05** in one PR with migration 0039: no run was suspended on either installation (17
`success` on compose, none on kind), so the schema went in the same change.

**D12 — Per-agent LLM budget: $0.25 a day by default, in integer micro-USD,** below the existing
global `LLM_DAILY_BUDGET_USD` ($5), which stays as the ceiling over all agents. Derived in §11. A
scan that would exceed the agent's budget stops and records why; it never borrows from another
agent's.

**D13 — Uniqueness becomes per-agent by a composite key, not by rewriting keys.** `observations`
becomes `UNIQUE (agent_id, dedupe_key)` and `runs` `UNIQUE (agent_id, run_key)`, with the dedupe hash
and the primary's run-key format unchanged. Rewriting the hash (§3.3a as first written) cannot be
backfilled — a stored key is a digest, and its inputs are gone — so the first scan after the deploy
would re-emit every observation of the day under a new key and notify the user again.

### Added 2026-10-05

**D14 — The decision is the model's; the limits are the code's.** The goal is an agent that uses its
persona and its tools to reach a good judgement, not a rule set. The model chooses which instruments
to look into, what to ask for, whether to buy, sell or do nothing ("nothing" is the expected outcome
of most scans), how many shares, and the thesis. The code enforces, after the model has answered and
whatever it said: USD-listed, in the universe, whole shares (D7–D9); cash covers cost plus fee, or the
proposal is rejected (D3, D6); every figure in the thesis appears in what the tools returned (§6.2);
price, range, TTL and calendar computed by the server (D3, D4); and the user's approval, always. A
persona changes the decisions, never the limits. *Rejected:* deterministic strategies (mean
reversion, momentum) as the decision-maker — they are not what the product is for, and they would be
designed, built and scored only to be replaced.

**D15 — A briefing from the code, then read-only tools the model chooses.** Each scan opens with a
briefing the code assembles: cash, holdings with cost basis, today's findings on those holdings, the
day's largest market movers and instruments from the user's followed topics — so an agent never
starts blind and never misses that its own holding collapsed. Then the model investigates with tools
that wrap existing components, all read-only: `search_universe` (topic resolution), `get_quote` and
`get_price_history` (the market-data registry, with its cache and rate limiter), `get_findings` (the
analysis rules), `get_news` (GDELT articles with sentiment), `get_position`, and optionally
`explain_concept` (the corpus). It ends with one answer: a proposal or nothing. **No tool writes**;
submitting is the answer itself, validated by the server. Bounds: a step limit per scan (default 12
tool calls) and the per-agent budget (D12). Every tool call and its result is stored with the
decision — this is the brief's Activity & Decision Log, and it is the evidence the validator checks
the thesis against. Text inside news results that tries to instruct the model is harmless by
construction: nothing it could persuade the model to do passes the server's checks. Consequences:
the provider gains tool calling (`openai_compatible.py` has none today), §6.1's pre-computed cache
is superseded (above), and the framework comparison of D10 now tests the case LangGraph is built for.

**D16 — The stages are re-cut around the deciding agent.** Stage 2: agents exist (create, pause,
own portfolios and observations, the consolidated view) and decide nothing. Stage 3: the ledger
(cash, fees, fills, approval, scoring), proven with manual trades into an agent's account. Stage 4:
the agent that decides (D14, D15). Stage 1 is unchanged. *Rejected:* keeping deterministic agents as
a stage — it would mean designing trading rules (when to buy, how much) that the product does not
want, only to test a ledger that manual trades test as well.

---

## 11. Measured, 2026-10-04 (read-only, live compose database)

**Schema at `0035_observation_localized`, one user.** Rows: holdings 10, observations 83, proposals
18 (all `rebalance`: 14 expired, 4 approved), intents 6, runs 1,135, portfolio_snapshots 13,
target_weights 5, notifications 73, proposal_episodes 4, proposal_transitions 23. The migration is
small; its risk is in the constraints, not in volume.

**Every unique constraint Stage 1 must change** (each backed by an `ON CONFLICT` in the orchestrator,
so the constraint and the query must change together or the insert errors at runtime):

| Table | Today | Becomes | `ON CONFLICT` in |
|---|---|---|---|
| holdings | `UNIQUE (user_id, instrument_id)` | `(agent_id, instrument_id)` | `queries/holdings.ts` |
| observations | `UNIQUE (dedupe_key)` | `(agent_id, dedupe_key)` | `queries/observations.ts` |
| runs | `UNIQUE (run_key)` | `(agent_id, run_key)` | `queries/runs.ts` |
| portfolio_snapshots | `UNIQUE (user_id, as_of)` | `(agent_id, as_of)` | `queries/snapshots.ts` |
| target_weights | `PK (user_id, instrument_id)` | `PK (agent_id, instrument_id)` | `queries/targetWeights.ts` |
| proposal_episodes | `one_open (user_id, kind, subject) WHERE open` | `agent_id` for `user_id` | `queries/proposalEpisodes.ts` |

Unchanged, and why: `proposals_one_per_observation` (an observation is already one agent's);
`intents_one_live_per_proposal` (a proposal is already one agent's); `notifications.dedupe_key`
(§3.3); `runs_one_running_rescreen` (a shared, agent-blind kind).

**Tables that do not get `agent_id`:** `proposal_transitions` (a child of a proposal, reached through
it); `topics` and `topic_instruments` (the user's interests, which every agent reads);
`user_settings`, `telegram_bindings` (one per user, §7.2); `narration_transitions` (the narration
provider's health, not anyone's portfolio); `llm_calls` — **deferred to stage 4**, where spend becomes
per-agent. Note that `llm_calls` already has a column named **`agent`**, meaning the calling component
(`ask`, `narration`); stage 4 renames it `purpose` before adding `agent_id`, or the two will be
confused in every query that touches both.

**Where the SQL is.** Every statement on the nine tables is in the orchestrator's `src/db/queries/`
(about 57 statements across 12 modules); the AI service touches only `runs` (the universe rescreen).
Stage 1 is therefore almost entirely an orchestrator change, and one contract test over that
directory can check all of it.

**LLM cost, for D12.** Every one of the 11 recorded calls used `nvidia/nemotron-3.5-lightning:free`,
so the real per-call cost on this installation is **$0** and cannot be measured from spend. What
can be measured is size: narration prompts are 491–506 tokens and completions 77–127. The validator
accepted **3 of 10** narrations (6 `unsourced_figures`, 1 `malformed`); latency ran 1.4 s to 181 s.
**An agent cannot run on the free route** — a rationale rejected 70% of the time is an agent that
almost never proposes — so stage 4 requires a paid model.

Estimate, labelled as such: one agent scan (analyst + sentiment and risk sub-agents + a validated
rationale) at ~9,000 prompt and ~1,000 completion tokens; two scans a day (§7.1). At OpenRouter list
prices read that day:

| Model | In / out per M tokens | Per scan | Per agent per day |
|---|---|---|---|
| `anthropic/claude-haiku-4.5` | $1.00 / $5.00 | ~$0.014 | ~$0.03 |
| `anthropic/claude-sonnet-5.5` | $2.00 / $10.00 | ~$0.028 | ~$0.06 |
| `google/gemini-2.5-flash` | $0.30 / $2.50 | ~$0.005 | ~$0.01 |

$0.25 a day is ~8× the Haiku estimate and ~4× Sonnet's: room for graph loops and a validator retry,
small enough that a runaway graph is stopped the same day. The global $5 then admits ~20 agents at
their cap. The first stage-4 PR re-measures the token sizes on real scans and revises the default.

---

## 12. Stage 1 — implementation tasks

Stage 1 ships no user-visible change and touches neither Mastra nor any reasoning framework (D10, D11). Its exit: the live database migrated (on a copy first), every
existing row owned by "Main portfolio", and the next scheduled portfolio scan, snapshot, digest and
proposal sweep behaving exactly as before — no duplicate observation, no repeated notification.

**Standing rule for every migration in this feature:** it runs against a copy of the live database
before it is merged (the method in `.claude/MEMORY.md`, "A review copy of the live database"), with
row counts compared before and after, and `downgrade` exercised on the copy.

**PR 1 — The `agents` table, and `agent_id` written on every row.**
- Migration `0036_agents`: `agents` with only the columns something reads in stage 1 — `id`,
  `user_id`, `slug`, `name`, `persona`, `is_primary`, `budget_minor`, `currency`, `state`,
  `created_at`, the two uniques and the one-primary index of §3.1, `agents_primary_is_real` reduced
  to `NOT is_primary OR (budget_minor IS NULL AND persona IS NULL)`, plus `UNIQUE (user_id, id)` for
  the composite foreign key. **`philosophy` is dropped** (D14, D16: every non-primary agent is a
  deciding agent, so the column would hold one value); `domain`, `scan_cadence`, `thresholds` and
  the price-range setting arrive with the stage that reads them. Seed one primary per user
  (`slug = 'primary-portfolio'`, `name = 'Main portfolio'`); add `agent_id` to the nine
  tables (§3.2), backfill to the primary, then `SET NOT NULL` and the composite foreign key
  `(user_id, agent_id) → agents (user_id, id)`, in one transaction. **One exception, `runs`:** its
  `user_id` is already nullable because the universe rescreen is the installation's work, not an
  account's (`claimRun({ userId: null })`), and an installation has no primary agent. So
  `runs.agent_id` is nullable under `CHECK ((user_id IS NULL) = (agent_id IS NULL))`: a null there
  means "no account", never "real", and a run that has a user cannot lack an agent. **No column default:** a
  default of "the primary" would make a forgotten `agent_id` mean "real" — §3.2's trap in another
  form. The new per-agent unique indexes (§11 table) are **added beside** the old ones, not yet in
  place of them (expand now, contract in PR 3), so this PR's deploy cannot break an `ON CONFLICT`.
- `src/db/queries/agents.ts`: `primaryAgent(userId)`; re-exported from `queries.ts`.
- Every `INSERT` into the nine tables passes `agent_id` explicitly; the AI service's rescreen run
  insert likewise. `POST /internal/runs` accepts an optional `agentId` and resolves the primary
  **at the HTTP edge only**; below it the id is always explicit.
- Agent-blind run kinds (`backfill`, `instrument_metadata`, `universe_rescreen`, `news_collect`,
  and the user-level `topic_scan`, `topic_discovery`, `daily_digest`) are recorded against the
  primary as an accounting convenience (§3.3c); `portfolio_scan`, `snapshot` and `proposal_sweep`
  are the primary's own work and become per-agent in stage 2.
- Tests: migration up and down on CI's Postgres; seed and backfill counts; the app role can read
  and write `agents` (default privileges from 0033 should cover it — the test proves it); an insert
  without `agent_id` fails.

**PR 2 — Reads are agent-scoped, and a contract test keeps them so.**
- Every `SELECT`/`UPDATE`/`DELETE` on the nine tables takes an `agentId` and filters on it. Callers
  resolve the primary once per request or run, never inside a query module.
- `GET /runs` filtered to an agent excludes the shared kinds (§3.3c).
- A contract test (in the spirit of `test_concept_corpus_contract.py`) reads every SQL string under
  `src/db/queries/` and fails if a statement touching one of the nine tables does not mention
  `agent_id`, unless it is on an allowlist **with a written reason**. This is the guard against the
  forgotten filter: it fails at review time instead of in front of the user.

**PR 3 — Constraints become per-agent (contract).**
- Migration `0037`: drop the old `(user_id, …)` / `(dedupe_key)` / `(run_key)` uniques; the
  per-agent ones from PR 1 become the only ones. Every `ON CONFLICT` target in the §11 table moves
  to the per-agent key in the same PR.
- D13: dedupe hash and the primary's run-key format unchanged. Test: an observation with the same
  `dedupe_key` under two agents inserts twice; under one agent, once.
- Verified on the live copy by running a portfolio scan against it and counting observations and
  notifications before and after: zero new rows for an unchanged market.

**PR 4 — "Main portfolio" is passive, in three layers (D1).**
- Migration `0038`: trigger `proposals_primary_rebalance_only` — a proposal against a primary agent
  whose `kind` is not `rebalance` raises. (No trade kind exists yet; the test inserts one.)
- `services/proposals.ts` refuses before the database does, with a typed error.
- `docs/PRD.md` P2 gains one sentence naming the passive primary; this document's §1 already does.

**Then: handoff.** This amendment plus PRs 1–4 is five merged PRs, which is CLAUDE.md's handoff
trigger as well as the stage boundary: `.claude/MEMORY.md` is updated, committed as its own PR, and
the next session starts Stage 2.
