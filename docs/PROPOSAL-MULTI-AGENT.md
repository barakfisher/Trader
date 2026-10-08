# Architecture Specification — Multi-Agent Trading Sandbox

**Status: approved specification, not yet implemented.** The product and engineering decisions in
this document are settled. What follows is the agreed design and its four-stage execution plan,
written against the system as it exists at PR #40.

**Amended 2026-10-04/05** (at PR #150): further decisions D1–D31 (§10), the schema as measured that day
(§11), the exact Stage 1 task list (§12), and Stage 3's measurements and task list (§13).
**Amended 2026-10-06** (at PR #170): decisions D32–D52 (§10) and Stage 4's measurements and task list
(§14). Where §10
and an earlier section disagree, §10 wins, and the earlier section carries a pointer to it.

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
**Decided by §10 D23:** refused; a filled trade is reversed only by a counter-trade. **And moved by
D26:** the trade proposal and its approval paths are built in Stage 4, with the agent that proposes.

**Approval from the dashboard is a first-class path, not a fallback.** Telegram may be unbound,
delayed or failing — per the current handoff, it is in fact unproven end to end — and a proposal that
can only be answered through a channel that may not deliver is a proposal that expires unanswered.
Both paths call the same transition function; only the audit row's recorded channel differs.

### 5.3 Manual trades

A trade the user places directly into an agent's account is recorded with
`source: 'manual_user_override'`, distinct from `source: 'agent'`. **Scoring excludes manual
overrides.** Otherwise a user who rescues a losing agent by hand credits the rescue to the agent's
philosophy, and the scoreboard stops measuring the thing it exists to measure.
**Pricing and entry: §10 D21.**

### 5.4 Agent performance scoring

Per agent, over rolling 30 / 60 / 90-day windows:

- realised and unrealised P&L, in base currency;
- win rate over closed positions;
- return versus a benchmark, and versus the user's real portfolio.

Every figure is computed from stored fills and stored quotes, and an unpriced position makes the
window's return **unavailable rather than partial** — the same refusal `allocation_drift` already
makes, for the same reason: a systematically wrong comparison against a number the user is
evaluating is worse than silence.

**Amended (D24):** the benchmark is SPY, through a shadow portfolio that receives the agent's deposits
on the same days; P&L versus the benchmark covers every trade, the 30/60/90-day score only the agent's
own. The comparison with the real portfolio is deferred (D24).

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
**Amended (D12, D45):** $0.50 a day per agent by default, editable per agent.

---

## 7. Scheduling

### 7.1 Fixed daily scans, off-peak

LLM agents scan twice daily: **pre-market open and post-market close**. **Amended (D46):** the
schedule is each agent's choice, pre-open once a day by default. Both enter through
`POST /internal/runs` with a run key, like all scheduled work, and take their own
`RUN_BUCKET_MINUTES` entry. Deterministic agents may keep the existing 30-minute cadence; their cost
is a database read.

**This makes market holidays material for the first time, and the answer is already decided.**
Existing decision 1 rejected a market-status API on the pricing path and recorded the alternative it
would accept: *"If scheduled scans ever make holidays material, the answer is a static calendar
applied at the scheduler, not a network call per quote."* A fixed pre-open/post-close schedule is
exactly that trigger. A static exchange calendar at the scheduler is therefore part of this stage.
**Amended (D4, D25):** the calendar arrives in Stage 3, because a manual trade at the live quote needs
it before any scan does; it is a committed file, read by the AI service and asked by the orchestrator.

Note also that "pre-market open" resolves against the **exchange's** calendar and timezone, not
`APP_TIMEZONE` (`Asia/Jerusalem`). The user's timezone continues to govern "today" for digests and
daily buckets; it does not govern when a US market opens.

### 7.2 Telegram

The existing `telegram_bindings` constraint is kept unchanged: `user_id PRIMARY KEY`, `chat_id
UNIQUE`, one chat per user. Agents do not get their own chats — N agents × N chats is a notification
volume problem wearing an architecture costume.

- **`agent_id` is included in the signed callback payload.** Without it, a signed callback minted for
  one agent's proposal can be replayed against another's. **Amended (§10, opening Stage 4):** not
  needed - the HMAC already covers the proposal id, which names one agent.
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
| **2 — Agents exist** | Create, name, budget, persona, pause, archive; an Agents page and a page per agent (D17-D20). No decisions (D16); the consolidated view moves to Stage 3 (D17) | Stage 1 |
| **3 — Budget, fills, scoring** | the consolidated view with filter and split figures (D17), `agent_cash` and recorded top-ups (D22), fees (D6), the fill function with D3's range and TTL checks, the exchange calendar and next open (D4, D25), manual trades at the live quote or a flagged typed price (D21), P&L against a shadow SPY and 30/60/90-day scoring (D24) — tasks in §13 | Stage 2 |
| **4 — The deciding agent** | The trade proposal and its dashboard + Telegram approval (D26), persona + tools decide (D14), briefing then read-only tool calls with a step limit and a stored transcript (D15), tool calling in the provider, reasoning in `services/ai` with a hand-written loop or core LangGraph by comparison and no checkpointer (D10), per-agent budgets (D12), pre-open/post-close schedule, persona rationale behind the validator, urgent sells through quiet hours (D5) | Stage 3; a paid model (§11 — M3, M5 and GDELT news have since landed; the workspace is **not** funded, §14.1) |

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
**Amended (D47):** the range is centred on the live price an approval's preview shows, and the
preview is refused beyond 300 bps of the agent's price.

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

### Added 2026-10-05, opening Stage 2

Measured first: one agent exists (the primary); a simulated agent cannot trade until Stage 3, so in
Stage 2 it would hold nothing, and the consolidated view (§4.3) would have nothing to consolidate.

**D17 — Stage 2 is agent management; the consolidated view moves to Stage 3.** Create, rename,
budget, persona, pause, archive. The consolidated holdings view, the `All / Real only / per agent`
filter and the real/simulated split arrive with Stage 3's ledger, when agents hold something - built
against real rows rather than fixtures. *Rejected:* seeding an agent with a copy of the real
holdings (they would sit outside its cash budget, which Stage 3 would then have to reconcile), and
building the view against fixture agents (nothing visible until Stage 3 either way).

**D18 — A paused agent still owns what it holds.** Pause stops scanning and proposing (Stage 4); its
holdings stay in the consolidated view, badged *Paused*. An archived agent leaves the consolidated
view and stays readable on its own page. Agents are archived, never deleted: their history is the
record scoring (§5.4) is computed from.

**D19 — Agents get their own page.** An *Agents* item in the navigation: a list (status, budget,
value) with a create form, and `/agents/:id` with settings, the persona editor, and *Holdings* and
*Activity* tabs - the management panel of the original brief. The primary appears in the list,
named through the UI catalogue, and links to the dashboard; it has no settings (D1).

**D20 — The persona is stored and editable now, labelled as unused until Stage 4.** Up to 4,000
characters; an empty persona is stored as none. Nothing reads it before the deciding agent.

Also settled while building the API, not needing a decision: budgets are typed in dollars with at
most two decimals and refused - not rounded - otherwise; the ceiling is $1,000,000,000, so a
minor-unit count stays an exact integer in JavaScript; a budget can be edited in Stage 2 (Stage 3
turns later changes into recorded top-ups); a name is unique per user (409 otherwise); the slug is
random, so a rename keeps the agent's identity and a name in any script works.

### Added 2026-10-05, opening Stage 3

Measured first (§13): one agent exists, the primary; there is no cash or fill table; every instrument
in the tradable universe is USD- and US-listed; quotes are Yahoo's, 15 minutes delayed; SPY is in the
universe with no stored price; every proposal ever written is a `rebalance`.

**D21 — A manual trade fills at the live quote by default; a typed price is allowed, and flagged.**
The default takes the same path an approval will (D3): a quote fetched now, the exchange open, and the
quote's time and delay stored on the fill — "live" here means the provider's delayed quote, and the
form says so. The user may type a price instead: the fill records `price_source: 'user'`, skips the
range and the open-market check, and still obeys everything else — the universe, USD, whole shares,
fees, the cash check under the row lock, no selling more than is held. A manual trade is always
recorded *now*; there is no backdating. *Rejected:* backdated entries — inserting a trade into the
past rewrites the cash history and the benchmark comparison from that date, and can date a purchase
before the cash existed.

**D22 — Cash starts at the budget; raising the budget is a recorded top-up; lowering it is refused
once the agent has traded.** An agent's cash row and its opening deposit are written when the agent
is created (and backfilled for agents created before the ledger). Until the first fill, a budget
edit replaces the opening deposit — nothing has been measured against it yet. After it, an increase
is a deposit row of its own, dated, and a decrease is refused. *Rejected:* decreases as withdrawals
— more flexible, but a withdrawal must also leave the shadow benchmark (D24) and be refused against
cash already spent, for a case nobody asked for.

**D23 — A recorded trade is final.** There is no undo of a fill and no free-form cash adjustment; a
mistake is corrected by a counter-trade, which is itself recorded. This settles §5.2's open question
for the approval path as well: revoking a filled approval is refused. The ledger is append-only, so
every balance can be recomputed from its rows and checked against the stored one.

**D24 — Two figures: P&L against a shadow SPY, and the score.** *P&L* is `net worth − deposits`
(D6), over everything in the account, manual trades included. Beside it, a **shadow SPY portfolio**
receives each deposit on the day it was made, bought at that trading day's SPY close (the next
trading day's for a deposit on a closed day); both returns are `P&L / deposits`, so both lines are
given the same money at the same times and a top-up is never mistaken for a gain. *The 30/60/90-day
score* (§5.4) counts only `source: 'agent'` fills, so until Stage 4 it reads "no agent decisions
yet" and its arithmetic is proven by tests. An unpriced position or a missing SPY close makes the
figure unavailable, not partial. The comparison with the real portfolio is deferred: it has no cash
and no deposit history, and an import replaces its holdings, so a percentage beside an agent's would
not be like for like. *Rejected:* a simple percentage from the first budget — wrong at the first
top-up; and scoring live-price manual trades — it would score the user's judgement and leave it in
the agent's record.

**D25 — The exchange calendar is a committed file from a generator of our own; no library.**
`data/calendar/xnys.json` lists full closures and early closes for several years. A script in
`services/ai/scripts/` computes them from NYSE's published rules (weekend observance, Easter for
Good Friday, the fourth Thursday of November); closures no rule predicts (a national day of
mourning) are added by hand and kept on regeneration. It is committed like the universe (decision
90's stance: one fixed input that CI, the eval and production share, and a change that shows in a
diff) but generated separately, because the universe comes from Yahoo, which publishes no holidays,
and is rebuilt on a different cadence. The AI service reads it beside `market_sessions.py` and
answers *is it open* and *when does it next open*; the orchestrator asks rather than re-implementing
it. A test fails 90 days before the file's last year ends, so it cannot run out silently. NYSE and
Nasdaq share the calendar, and every tradable instrument is listed on one or the other (§13).
Quote caching (decision 1) is unchanged. *Rejected:* `exchange_calendars` as a dependency (the
user's preference: no third-party calendar), bundling it into the universe build, and a hand-typed
file (the same file with a person as its generator).

**D26 — The trade proposal and its approval paths move to Stage 4.** Stage 3 builds what they stand
on — the fill function with D3's range, TTL and cash checks, the calendar and the next open — and
tests it with proposal-shaped input. The `BUY`/`SELL` proposal kind, the dashboard and Telegram
approval buttons and D4's TTL arrive in Stage 4's first PR, with the agent that writes them.
*Rejected:* building them now against proposals only tests create — D17's reasoning: build against
real rows.

### Added 2026-10-05, building manual trades (Stage 3, PR 4)

Asked and answered before the trade path was written. Each applies to Stage 4's approvals unchanged,
because they run through the same function (`services/fills.ts`).

**D27 — A trade is previewed, then confirmed; the confirm re-checks the live price against the one
shown.** The preview computes price, fee, cash and holding after, and writes nothing. The confirm
fetches the quote again and fills only within D3's ±50 bps of the price the preview showed;
otherwise it is refused with the new price, and the user previews again. *Rejected:* filling at the
previewed price — it may be minutes old by the confirm, and it would be a second path beside the one
approvals take.

**D28 — A live price may be at most 30 minutes old.** Yahoo's quotes run 15 minutes behind and the
quote cache may add one cycle; a quote whose own `as_of` is older than 30 minutes, or that the
provider marks stale, is refused ("try again or type a price"). The fill records the quote's time
and delay. *Rejected:* bypassing the cache for every trade — always ~15 minutes behind, but a Yahoo
request for every preview and confirm, and Yahoo rate-limits.

**D29 — A typed price is warned about, never blocked.** When it is 5% or more from the last known
price, the preview says by how much; the trade still fills, recorded as `price_source: 'user'`.
*Rejected:* refusing beyond ±20% — it catches a typo, but it also blocks a genuine price exactly
when the override is needed (a stale or missing quote).

**D30 — A paused agent may be traded by hand; an archived one may not.** Pause stops the agent
scanning and proposing (D18), not its owner managing the account. Archived is read-only history.

**D31 — The agent page: a Trade panel, one timeline, and Add cash.** A *Trade* button (and *Sell* on
each holding) opens a side panel - symbol, side, whole shares, market or typed price - that previews
before it confirms (D27). The *Activity* tab is one timeline of every cash movement - the opening
deposit, added cash, each buy and sell with its price, fee and price source - each showing the
balance it left, so every dollar can be traced. *Add cash* takes an amount and raises the budget by
it in one statement (`budget_minor = budget_minor + amount`), so two additions never read the same
old budget; the budget field in Settings stays, and after the first trade only rises (D22).
*Rejected:* an always-visible form (it occupies the page on every visit); trades-only activity
(deposits would be missing, and the cash figure could not be traced back); top-ups only by editing
the budget ("1,000 to 1,500" is a less direct way to say "add $500").

### Added 2026-10-05, building the consolidated view (Stage 3, PR 6)

Measured first: the dashboard - summary, holdings table, equity curve, allocation, findings - is
entirely the real portfolio's; no simulated agent existed on either installation. Asked and
answered before the view was written; every answer was the recommendation.

**D32 - The filter switches the holdings card and the headline, nothing else.** `Real only / All /
<agent>` sits above the headline. The equity curve, the allocation chart, targets and the findings
feed stay the real portfolio's, and a scoped headline says so. *Rejected:* the whole dashboard
following the filter - an allocation chart over real and paper shares together is the blended
figure §4.3 forbids, and every card would need its own split; a separate page - the view belongs
where the holdings already are.

**D33 - `Real only` is the default, and the choice lives in the address** (`?holdings=all`,
`?holdings=<agent id>`). Nothing changes for a user who does not ask, and the view matches the
real-only cards around it; a chosen view survives a reload and can be sent. The picker appears
only when a non-archived simulated agent exists. An unknown or archived agent in the address is
the default view. *Rejected:* `All` as the default (§4.3 as first written) - a glance at "NVDA 40"
must mean the real 40.

**D34 - Under `All` the headline is two figures: the real portfolio's value and the simulated
agents' net worth** (cash + holdings, "of which cash" beneath it), never their sum. Each keeps its
own rule for a missing price: the real one is partial and marked, as the dashboard always was; the
simulated one is withheld and names the unpriced symbols (decision 111). One agent's view shows
its cash, holdings value, net worth and P&L, as its own page does. *Rejected:* holdings value
only - an agent's cash is most of what it has before it trades.

**D35 - Simulated rows are read-only and link to the agent's page; pending proposals are not
shown until Stage 4.** An agent's shares change only through a fill (decision 109), so the view
offers no edit or remove on them; a row expands to each holder with a *Paused* badge where it
applies (D18) and links to the real holding's page or the agent's. Agents write no proposals
until Stage 4, so §4.3's "pending proposals on that ticker" arrives with them. The Agents list
gains each simulated agent's net worth (D19). *Rejected:* a *Sell* on the dashboard row - a
second entry to the trade panel for no case the agent page does not already serve.

### Added 2026-10-05, building performance (Stage 3, PR 7)

Measured first: daily closes are kept indefinitely (about 191 per held symbol since 2025-12-29, one
per trading day, nothing prunes them); SPY had none; the real portfolio's snapshot has gaps whenever
the machine was off (13 rows in 21 days) and values holdings at midnight Israel time, not at the
close. Asked one at a time; every answer was the recommendation, D38's with a reservation.

**D36 - An agent's daily value is computed, not stored.** At each session's close: cash after the
last movement made by that instant, plus each holding (replayed from the fills) at that day's
stored close. The ledger is append-only and closes are kept, so any past day can be recomputed,
with no gaps and on the same closes the benchmark uses. No migration. The series ends at the last
session whose SPY close is stored: a session that has closed but whose close the next backfill
has not fetched yet is *not recorded*, which is different from *unpriced*. *Rejected:* a nightly
snapshot per agent - gaps when the machine is off, a midnight price, and a column for cash.

**D37 - A deposit buys the shadow SPY at the first session close at or after it**, read from the
exchange calendar (`GET /market/sessions`), early closes included: during a session, that day's
close; after the close or on a closed day, the next session's. Until that close is recorded the
deposit is *pending* and in neither figure. *Rejected:* the deposit's calendar date even after
hours (it would buy at a price from before the money existed), and the previous close.

**D38 - The shadow holds fractional shares and pays no fees.** It is an index line, not a trade:
every dollar deposited is in SPY at that close, exactly, and the agent's own fees remain a cost it
has to beat. **Recorded as debt at the user's request:** fees on the benchmark will be added later
(`.claude/MEMORY.md`, "Current technical debt"). *Rejected for now:* whole shares with fees (the
benchmark would start ~3% behind on a $10,000 deposit for reasons that are not SPY's).

**D39 - The score replays the agent's own book.** Only `source = 'agent'` fills, as if the user
had never traded by hand: a sell is scored against the shares the agent itself bought, at their
share of its cost; a sell beyond what the agent bought scores only the part it did. Unrealised P&L
values what the book still holds, capped at what is actually still held. Manual trades count in
P&L against SPY (D24), never in the score. *Rejected:* scoring against the real position (the
user's intervention would change the agent's record), and skipping mixed holdings.

**D40 - A win is a sell with a profit after fees**: its own fee and its share of the buy fees.
Break-even is not a win. Example: 10 bought at $100.00 and sold at $100.10, $1.50 each way, is a
$2.00 loss. *Rejected:* price above average cost, fees ignored.

**D41 - Each sell is one decision, counted in the windows its date falls in.** The 30/60/90-day
windows count the agent's fills (decisions), its scored sells, wins, the win rate and realised
P&L by the sell's date; unrealised P&L is one figure for now, not repeated per window. *Rejected:*
a position counted only on its round trip to zero (a position trimmed for months shows nothing),
and counting only positions opened inside the window.

**D42 - The agent page shows a Performance card: the figures, both lines and the score.** The
agent's P&L and return, SPY's on the same deposits and the difference in points, at the latest
recorded close; a chart of the agent's net worth and the shadow at each close; and the score,
which reads "no agent decisions yet" until Stage 4.

### Added 2026-10-06, opening Stage 4

Measured first (§14.1): the OpenRouter account holds no credit and is on the free tier, so the
"funded workspace" §9 assumed does not exist yet; every recorded call used the free route, whose
narrations were accepted 16 times in 49; a tool loop re-sends its whole conversation at every step,
so a scan is several times D12's estimate. Asked one at a time; the user chose every
recommendation, and added three things of their own: both models editable on the Admin page with a
cost estimate (D43, D44), the schedule a per-agent choice with pre-open as the default and a cost per
run beside it (D46), and the scan's cost made visible wherever it is chosen.

**D43 - One model for narration and `/ask`, one for agents, both chosen on the Admin page from a
list of priced models.** The default for both is `anthropic/claude-sonnet-5.5` (OpenRouter, $2 / $10
per million tokens). The choice is installation-wide, stored in the database and read by the AI
service on each call, so switching needs no redeploy; `LLM_MODEL` remains the value before anyone
has chosen. The list holds only models with a price in `app/llm/pricing.py` (or
`LLM_MODEL_PRICES`), and the agents' list only those that support tool calling. Every change is an
`admin_audit` row. The API key stays in `.env` (guideline 9). *Rejected:* a typed model id (an
unpriced model is charged the pessimistic $20 per million tokens, so a $5 day ends after about five
scans for no visible reason); narration staying on the free route (rejected two times in three, for
about $0.02 a day saved); an environment variable per purpose (a redeploy to try a model).

**D44 - The Admin page says what the choice will cost.** Beside each picker: an estimate per day
and per month, labelled as an estimate - the last 7 days of recorded narration and `/ask` tokens
re-priced at the chosen model, plus each scanning agent's average scan cost (D46) times its
scheduled scans - and the OpenRouter credit balance, read from OpenRouter's own `/credits` with the
existing key. The question it answers is "how much should I add to the account". Funding it is the
user's act, not the system's.

**D45 - Each agent's LLM budget is $0.50 a day by default, editable on its Settings.** Amends D12's
$0.25, which assumed a 10,000-token scan. Integer micro-USD; the day is the global guard's UTC day;
spend is summed from the agent's own `llm_calls` rows. Before each model call the scan checks the
agent's budget and the global ceiling (`LLM_DAILY_BUDGET_USD`, unchanged) and stops with
"budget reached" when either is spent, so a scan overruns by at most one call. It never borrows
another agent's allowance. *Rejected:* $0.25 (a long scan is cut short most days); a fixed default
for every agent (a persona that researches widely costs more, by design).

**D46 - Each agent's schedule is a choice on its Settings; pre-open once a day is the default.**
The choices: *pre-open only* (default), *pre-open and post-close*, *10:00 and 14:00 New York*,
*10:00 New York only*. Times are the exchange's (§7.1), from the calendar (D25): no scan on a closed
day, and a post-close scan follows an early close. Beside the choice, the estimated cost per run:
the agent's average over its recent scans, or, before it has one, the installation's agents'
average, or, before any, §14.1's assumption - labelled as such. Amends §7.1, which fixed two scans
for every agent. *Rejected:* intraday scans as the default (recommended for D3's sake; the user
preferred pre-open, and D47 makes it work).

**D47 - Approving a trade proposal shows the live price, then confirms it.** Amends D3. A proposal
stores the quote the agent saw; at a pre-open scan that is the previous close, and an overnight gap
larger than 0.5% would otherwise refuse every approval. So *Approve* is D27's preview: the agent's
price, the live price now and the distance between them, cost with fee and the cash after; then
*Confirm* fills within ±50 bps of the live price that preview showed, through `executeFill`, with the
exchange open, the quote fresh (D28) and the cash checked under the lock. **The preview is refused
when the live price is more than 300 bps from the agent's price**: the thesis was formed at a price
that no longer holds. In Telegram, *Approve* replies with the preview and a *Confirm* button. The
server still computes every bound; the model supplies none.

**D48 - A trade proposal has Approve and Reject, and nothing else.** No snooze - its life is an hour
from the open (D4) and its price an hour old by the time a snooze ends - and no undo, which would
delete a fill (D23). The server refuses both for the trade kinds whatever the surface sends;
`rebalance` keeps all four.

**D49 - A refused approval leaves the proposal pending.** Price outside the range, more than 300 bps
from the agent's price, the exchange closed, a stale quote, not enough cash: nothing is written to
the ledger, the reason and both prices are shown, and the attempt is recorded with the proposal so
its history shows it. The user may try again until it expires, or reject it. No new state (§5.2).
*Rejected:* closing the proposal on the first refusal (a brief spike would end one the user wanted).

**D50 - Every scan is shown, on a *Decisions* tab.** One row per scan - time, outcome (*proposed*,
*no trade*, *budget reached*, *step limit*, *failed*), cost and steps - expanding to the briefing,
each tool call with its result, and the answer with its thesis. A proposal links to the scan that
made it, and a fill to its proposal. This is D15's stored transcript, made readable. *Rejected:*
showing only scans that proposed (the money spent on "no trade" would be invisible, and so would the
reasoning behind an agent that never acts).

**D51 - The thesis is written in the user's language.** The model writes it in
`user_settings.language`; tickers and figures are unchanged, and the evidence validator checks them
the same way. Tool results are stored as returned. The frame around it - side, quantity, prices,
range, expiry - comes from the UI catalogue and the Telegram catalogue. This amends guideline 1 for
the thesis only; `CLAUDE.md` changes with the PR that writes the first thesis. *Rejected:* an English
thesis under a Hebrew frame - the paragraph read before approving is the one that most needs to be
in the reader's language.

**D52 - An agent scans only with a persona; it can be asked to scan now.** An active agent with no
persona is shown as waiting for one and is never billed. *Run a scan now* on its page starts one
scan outside the schedule, against its daily budget; it is refused for a paused or archived agent,
without a persona, or with the budget spent. *Rejected:* a neutral default persona (an agent the
user has not described spending money on decisions nobody asked it to make).

### Added 2026-10-07, building PR 4

**D53 - The scan is a hand-written loop; LangGraph is not built (amends D10).** Decided with the
user before PR 4, after comparing the two on paper: the same scan is ~25 lines as a plain loop and
~45 as a core-only `StateGraph`, with nothing the graph does that the loop cannot (one model, read-only
tools in sequence, three stops). The same choice was made for every model call in the service - the
planned assistant (`/ask` with tools) included - so one style serves all three, and the assistant's
milestone moves the client to the official `openai` package (`.claude/MEMORY.md`, debt). *Rejected:*
building both to measure, as D10 asked - the comparison D10 wanted is the one above, and a version
written to be discarded costs a PR of review; LangGraph's one feature the assistant would use is
streaming progress, which the `openai` package also gives. *Reopen if:* scans grow separate stages or
several cooperating agents. No checkpointer either way, as D10 said.

**D54 - What PR 4's answer check leaves to PR 5.** The scan checks what it can know when the model
answers (D14): tradable symbol, whole shares, a sell within holdings, every thesis figure sourced.
Cash for cost plus fee is checked when the proposal is written (PR 5), at the price and fee of that
moment. The thesis is English until D51's proposal frame arrives. A value that is already a
percentage is named `_percent` in tool output, never `_pct`, which the evidence validator reads as a
ratio (task 17).

Also settled while measuring, not needing a decision:
- **A scan proposes at most once** (D15: "a proposal or nothing"). Its answer becomes an observation
  carrying the thesis and evidence, and the proposal hangs from it - `proposals.observation_id` is
  `NOT NULL` and unique, so a proposal without an observation cannot exist.
- **The Telegram callback does not gain an agent id** (amends §7.2). It signs the proposal id with an
  HMAC, and a proposal belongs to one agent, so a callback cannot be replayed against another
  agent's proposal; a second UUID would also not fit Telegram's 64 bytes.
- **The fill is written in the approval's transaction** (D11): `executeFill` takes the caller's
  transaction, so an approval without its fill, or a fill without its approval, cannot be committed.
- **`llm_calls.agent` becomes `purpose` before it gains `agent_id`** (§11), expand then contract
  (decision 101 of `.claude/MEMORY.md`), so the pods running during the migration keep writing.

### Added 2026-10-07, building PR 5

Measured first (§14.3): the account was funded ($10) and three real scans were run on Sonnet 5.5
against a test agent. Asked one at a time; the user chose every recommendation.

**D55 - A buy the agent cannot pay for is an invalid answer, checked at the end of the scan.** D54
left the cash check to the proposal. It runs as the scan's last step instead, at the quote of that
moment - the agent's price the proposal then carries (D47) - with D6's fee: when `notional + fee`
exceeds cash, the scan is stored as `invalid_answer` with both amounts ("buying 19 CCJ at 54.32
costs 1033.58 with the fee; cash is 1000.00") and no proposal is written. The same treatment as a
sell of more than is held (D14); nothing is resized (§5.1). Checked in the scan rather than when the
orchestrator writes the proposal seconds later so that the stored outcome is always the true one:
a `trade` that silently proposed nothing would be the one row the *Decisions* tab got wrong. The
model's verdict stays `accepted` - the answer was well formed; the refusal is the server's.
*Rejected:* one more turn for the model ("you can afford at most 8"), a correction loop for a case
the briefing's cash already makes rare; shrinking the quantity to fit (§5.1).

**D56 - PR 5 is two PRs: the money path, then Telegram.** 5a: migration 0044, the scan's proposal,
Approve (a preview at the live price) / Confirm / Reject on the dashboard and the proposal's page,
refused attempts recorded and shown. 5b: Telegram - *Approve* replies with the preview and a
*Confirm* button (D47) - and the consolidated view's pending proposals (D35). Until 5b, a Telegram
*Approve* on a trade is refused with "trades are approved in the app" (the trade kinds never reach
Telegram in 5a; the refusal is for a surface that sends one anyway). *Rejected:* one PR - twice
the review, and the money path waiting on messaging plumbing.

**D57 - News on demand, as its own PR after 5a.** Measured: every one of the three scans looked
for news on the day's mover it considered and found none, because news is collected only for
followed instruments; a persona that checks the news first can then never act. The tool fetches a
symbol's recent headlines through `NewsProvider` once when nothing is stored, and caches them for
every agent. *Rejected:* inside 5a (a larger money-path PR); leaving it until the schedule (PR 7).

**D59 - News on demand comes from Yahoo through yfinance, at most hourly per symbol (D57).**
Measured first: GDELT cannot be asked about one symbol (a stream of 15-minute files; three days is
~860 MB), and widening its filter to the universe matched 559 of 1,255 headlines in one file on
names such as "ON" and "News". No other news key is set. `yfinance.Search` - already a dependency;
its `Ticker.get_news` returned nothing - answered each symbol in under a second with eight or so
headlines, publisher and time. A `yahoo` provider sits behind `NewsProvider`; when an agent's
`get_news` names a symbol, it is fetched unless anyone fetched it within the hour (a Redis mark,
given back if the fetch fails), and stored through the collection run's own pipeline - deduped,
linked only when the headline names the company, scored - so every agent reads the same rows.
Yahoo's `relatedTickers` are dropped, as every vendor's relevance is (`app/news/base.py`): half of
INTC's results were market stories listing forty tickers. Measured on a copy, 2026-10-07: BULL
(down 20%) got "Webull Sinks 22% as Congressional Panel Finds..." and four more; INTC 5, NVDA 8,
QXO 2, SITE 2, CCJ 1; 0.6-1.5 s each. `AGENT_NEWS_PROVIDER` (`yahoo` by default, `fixture` in
`.env.example`, `off`). *Rejected:* fetching only when nothing is stored (a followed stock with one
old article never gets fresher news); fetching on every call (one request per agent per step).
*Debt found:* the lexicon sentiment scorer reads "Sinks 22%" and "Plummets" as neutral.

**D58 - The validator sources a window the evidence names, and the thesis's own quantity.**
Asked when real scans on the branch were refused for "a 60-day high" (two of five) and a Hebrew
thesis for "2 מניות" (its own quantity). A whole number written straight before a unit of time -
"60-day", "over 5 days", "60 יום" - is sourced when a key in the evidence names that window
(`"60d"`, as the history tool labels its changes); a window no key names is still a figure, so
"its worst day in 14 months" is still refused. A buy's or sell's thesis may state the quantity it
proposes; any other number is checked as ever. *Rejected:* exempting every number before a time
unit (it let "14 months" through - a claim about history nobody supplied, which the existing test
caught); waiting for the news PR (half the real scans refused until then).

Also settled while building, not needing a decision:
- **An approved trade writes no intent.** The fill is the ledger row and carries the proposal;
  an intent would record the same assent twice. `rebalance` approvals still write theirs.
- **Several pending trade proposals per agent are allowed.** Each *Confirm* re-checks cash under
  the agent's row lock, so two pending buys cannot overspend; the second is refused, and recorded.
- **The scan link lives on the proposal** (`proposals.scan_id`, unique), not on `agent_scans`: the
  scan's row stays as the scan wrote it, and a trade kind without a scan is refused by CHECK.
- **The thesis is the observation's explanation in every language**; the headline is the
  catalogue's frame in each (`notify/messages.ts`), so a Hebrew reader sees a Hebrew frame around
  the thesis the model wrote in Hebrew (D51).

### Added 2026-10-07, building PR 5b

Measured first (§14.3): today's callback is 57 of Telegram's 64 bytes; a trade observation is
`notable` while the live install's push floor is `high`; a scan's proposal reached no channel.
Asked one at a time; the user chose every recommendation.

**D60 - A trade proposal is pushed whatever the severity floor.** It expires an hour after the
open (D4), so the digest would deliver it dead, and it exists only because the user created the
agent that made it. Quiet hours and a mute still hold it for the digest (D5's urgent sell arrives
with PR 7's schedule). The notification's reason stays `above_floor` - nothing held it back - so
no CHECK changes. *Rejected:* writing trade observations as `high` (it would change what "high"
means in the feed and the digest); following the floor (with `high`, no trade would ever be
pushed).

**D61 - Every scan that proposes announces it, a manual one included.** Whoever pressed *Run* may
have left the page by the time it answers, and the proposal lives an hour. One path for manual and
scheduled scans (PR 7), keyed by the observation so a retried scan announces once. An announcement
that fails is logged, never a failed scan: the proposal is written and on the dashboard.

**D62 - In Telegram, Approve answers with the preview and Confirm fills; a refusal keeps Approve
and Reject.** As D47 says, two taps: *Approve* edits the message with the live price, the agent's
and the distance, cost, fee and cash after, and offers *Confirm* and *Reject*. *Confirm* carries
the previewed price **inside its signed callback** - a varint after the nonce, under the same MAC,
so the ±50 bps band is centred on the price the user read and an edited button fails verification.
At most `MAX_CALLBACK_PRICE_MINOR` (28 bits, $2,684,354.55: the token is then 63 bytes); a price
above it is shown with *Reject* only and "confirm it in the app". A refusal (market closed with its
next open in the user's time, price too far from the agent's with both prices, price moved, stale
quote, no cash) appends a stamped line to the message in the user's language, is recorded with
`surface: 'telegram'` (D49), and leaves *Approve* and *Reject*: there is no Confirm without a fresh
preview. The fill line names quantity, price, fee and cash after; a trade keeps no buttons after it
(D48: no undo). *Rejected:* one tap that fills (money moves before the live price is seen); the
reason as a toast only (the chat would keep no record of the refusal).

**D63 - The consolidated view shows pending trades beside their ticker, and the rest above it.**
`GET /portfolio/consolidated` returns `pendingTrades` - the shown agents' trade proposals still
answerable by their deadline, soonest first. A held ticker's row carries an "N pending" badge and
lists them when expanded; a trade on a ticker the view does not list (a buy of something new) goes
in a "waiting for you" list above it. Both follow the `All / Real only / per agent` filter: *Real
only* has none (D1). *Rejected:* badges only (a buy of a new stock would be invisible here); a
separate list only (not "beside the ticker", §4.3).

### Added 2026-10-07, building PR 6

Measured first: the account reset (task 18) had erased every `agent_scans` row, so the tab starts
empty; `llm_calls` kept the Test agent's 12 scan calls of the day ($0.108). A stored scan is a
10-20 KB briefing and a transcript of up to twelve tool results, ~100 KB: the list carries a
summary and a row loads its detail when opened. `agents.llm_budget_micro_usd` and
`agents.scan_schedule` (0042) were enforced or stored but shown nowhere. Asked one at a time; the
user chose every recommendation.

**D64 - The *Decisions* tab shows a scan as readable steps.** One row per scan - time, outcome,
what it proposed, who started it, cost and steps - opening to a line for the briefing (cash,
holdings, the day's movers it saw, with the whole briefing folded beneath), then each turn: the
model's words, each tool it chose with its arguments, and the result folded as the JSON the model
read; then the answer with its thesis, the refusal's problems or the error, and links to the
proposal (in its state now) and to the fill. `GET /agents/:id/scans` pages summaries by
`before`; `GET /agents/:id/scans/:scanId` returns one in full. *Rejected:* a sentence per tool
(seven renderers to keep in step with the tools); the raw transcript.

**D65 - *Run a scan now* waits for the scan, in place.** One click, its expected cost beside it
(D46's estimate), no confirm; "Scanning..." while the request holds (6-16 s measured), then the
outcome where the button is - "Proposed: Buy 2 NVDA" with a link, "No trade", or why it stopped -
and the scan at the top of *Decisions*. Refused with the reason, in the reader's words, for a
paused or archived agent, one with no persona (shown as *Waiting for a persona* on its page and
in the list), a spent budget, a scan already running, or no model chosen. *Rejected:* a confirm
dialog (one more step for $0.04); a background run (a job and polling for a fifteen-second wait).

**D66 - The schedule is chosen and stored in PR 6, and says it is not running yet.** Settings
shows D46's four choices with the cost per trading day (the per-scan estimate times the scans the
choice runs) and "Scheduled scans are not running yet; until then this agent scans only when you
press *Run a scan now*." PR 7 removes the sentence; the choice is already stored. Beside it the
model budget in dollars (more than $0, at most $100) with today's spend against it, summed on the
UTC day `scan_budget.py` counts. Before an agent's first scan the per-scan estimate is the
installation's agents' recent average, or §14.3's measured $0.036, labelled as which.
*Rejected:* hiding the picker until PR 7 (the UI work moves into the scheduler's PR).

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

---

## 13. Stage 3 — measured, and the implementation tasks

### 13.1 Measured, 2026-10-05 (read-only, live compose database at `0039_retire_mastra`)

- **One agent, the primary**, with 10 holdings: seven USD equities and ETFs, two crypto pairs
  (`BTC-USD`, `ETH-USD`, exchange `CCC`) and `SAP.DE` in EUR. No simulated agent exists, so the
  ledger migration backfills nothing on this installation; it still backfills cash for any agent
  created before it lands.
- **No cash, fill or transaction table.** `holdings` is one row per `(agent_id, instrument_id)` with
  cost per unit (`cost_basis_minor`); `intents` (6 rows) records assent and holds no money.
- **The tradable universe is entirely USD and US-listed:** 5,225 profiles, all `USD`, on `PCX` 1,513,
  `NYQ` 1,501, `NMS` 833, `NGM` 713, `BTS` 549, `NCM` 83, `ASE` 26 and a handful under display names
  (`NASDAQ`, `NYSE`, `NYSEARCA`). No crypto. One calendar (D25) covers every instrument an agent can
  trade; the primary's crypto and EUR holdings are outside the universe and never traded (D1).
- **Quotes are Yahoo's, 15 minutes delayed:** of 3,006 stored, 668 intraday rows carry
  `delay_seconds = 900`, 2,290 are daily closes, 48 are old fixture rows. A "live" fill price is
  therefore a delayed quote (D21).
- **SPY is in the universe (`PCX`) with no stored price.** The daily backfill covers held and
  followed instruments only (`listAnalysedInstruments`), so the benchmark must be added to it. It
  stores about a year; the shadow portfolio (D24) needs closes only from each agent's first deposit.
- **Proposals: 18, all `rebalance`** (4 approved, 14 expired). Nothing writes a trade proposal (D26).
- **Snapshots are already per agent** (`portfolio_snapshots`, unique `(agent_id, as_of)`, 13 rows),
  but value holdings only; an agent's net worth adds its cash.

### 13.2 Tasks

Each PR the size of a Stage 1 PR; every migration rehearsed on a copy of the live database first.

**PR 1 — This amendment.** D21–D26 and §13.

**PR 2 — The exchange calendar (D25).** The generator script and `data/calendar/xnys.json`; a
calendar module in the AI service beside `market_sessions.py` (closed day, early close, *is open*,
*next open*), exposed to the orchestrator through the generated client; tests for the rule-based
dates against NYSE's published list, the hand-added closures surviving regeneration, and the expiry
test. No migration.

**PR 3 — The ledger (migration 0040).** `agent_cash` (one balance row per simulated agent, locked by
every trade); an append-only cash-movement table (opening deposit, top-up, trade debit and credit,
each with its fill where it has one); `fills` (side, whole-share quantity as `numeric(38, 18)`, price
and fee in minor units, `price_source` `quote`/`user`, the quote's `as_of` and delay, `source`
`manual_user_override`/`agent`, an optional `proposal_id` for Stage 4). A trigger refuses a fill or
a cash row on a primary agent — D1's fourth layer. `fees.ts` and `fees.py` (D6). Agent creation
writes the cash row and opening deposit; budget edits follow D22. A test recomputes every balance
from its movements.

**PR 4 — Manual trades.** `POST /agents/:id/trades/preview` and `POST /agents/:id/trades`: buy or
sell, whole shares, at the live quote (the exchange open, D28's age, D27's range against the price
shown) or a typed price (D21, D29). One fill function, the one Stage 4's approval will call: cash
row locked, fee added, refused and never resized, no selling more than is held, holdings updated in
the same transaction (average cost per unit on a buy; a sell to zero removes the row), one fill per
idempotency key. Paused agents may still be traded by hand; archived agents may not (D30).
`GET /agents/:id/fills` lists the ledger for PR 5's Activity tab.

**PR 5 — The agent page (D31).** The account (cash, holdings at market, net worth, P&L against
deposits - none of them when a holding is unpriced), the Trade panel (quote, its time and delay,
fee, cash after; preview, then confirm), *Holdings* with *Sell* from real rows, *Activity* as one
timeline with the balance after each movement, and *Add cash* (`POST /agents/:id/top-ups`);
English and Hebrew.

**PR 5b — Telegram (D47, D56).** *Approve* replies with the preview and a *Confirm* button; the
consolidated view's pending proposals (D35).

**News on demand (D57, D59).** A symbol's recent headlines from Yahoo, fetched at most hourly
when an agent asks, stored through the collection pipeline.

**Then: handoff** (five merged PRs).

**PR 6 — The consolidated holdings view (§4.3, D17, D18, D32-D35).** One row per instrument across
agents, expanding to the per-agent split; the `All / Real only / per agent` filter; real and
simulated never summed; paused badged, archived excluded. `GET /portfolio/consolidated` values each
agent as its own page does (`valueAgentAccount`) and the real portfolio as `/portfolio` does.

**PR 7 — Performance (D24, §5.4, D36-D42).** Daily net worth per simulated agent (cash + market
value) computed from the ledger and stored closes, SPY and every traded instrument in the backfill,
the shadow benchmark, P&L and return beside it on the agent page, and the 30/60/90-day score over
`agent` fills. `GET /market/sessions` (AI service) lists the calendar's sessions with their closes;
`GET /agents/:id/performance` computes the rest on each request.

---

## 14. Stage 4 — measured, and the implementation tasks

### 14.1 Measured, 2026-10-06 (read-only, live compose database at `0040_ledger`)

- **One agent, the primary; no fills; 18 proposals, all `rebalance`** (14 expired, 4 approved).
  Neither installation holds a simulated agent.
- **The model is not funded.** OpenRouter's `/key` reports `is_free_tier: true` and `/credits`
  `total_credits: 0`; `ANTHROPIC_API_KEY` is empty. Every one of the 52 recorded calls used
  `nvidia/nemotron-3.5-lightning:free` at $0. Narration: 16 accepted, 32 `unsourced_figures`,
  1 `malformed`; `/ask`: 2 accepted, 1 `unsourced_figures`. A paid model is a precondition (§11),
  and buying credit is the user's act (D44).
- **Prices, read from OpenRouter's model list that day** (USD per million tokens, input / output /
  cached input): `anthropic/claude-sonnet-5.5` 2 / 10 / 0.20, `anthropic/claude-haiku-4.5`
  1 / 5 / 0.10, `anthropic/claude-opus-5.5` 4 / 20 / 0.20, `google/gemini-3.5-flash-lite`
  0.30 / 2.50; all four support tool calling. `app/llm/pricing.py`'s defaults stop at the 4.x
  generation, so Sonnet 5.5 would today be charged the pessimistic unknown-model rate.
- **A tool loop costs more than §11 estimated.** Each step re-sends the conversation so far. With a
  ~4,000-token system prompt and briefing and ~1,500 tokens per tool result, a scan of five tool
  calls sends ~45,000 prompt tokens and one of twelve ~170,000, with ~300 completion tokens per step.
  On Sonnet 5.5: ~$0.11 and ~$0.38 uncached; with the repeated prefix cached, ~$0.04 for the typical
  scan. **An assumption until PR 3 measures real scans**, and the figure D44 and D46 show until then.
- **The provider has no tool calling** (`openai_compatible.py` sends one system and one user
  message); LangGraph is not installed. The global spend guard is a Redis counter per UTC day
  (`app/llm/budget.py`); nothing is per agent.
- **`llm_calls.agent`** is `CHECK (agent IN ('narration', 'ask'))`, read by the Admin page's LLM card
  (`services/llmPanel.ts`), which is read-only. There is no installation-wide settings table, only
  `user_settings`.
- **Approval today** (`services/proposals.ts:applyDecision`) writes an intent and offers approve,
  reject, snooze and undo; `executeFill` opens its own transaction. **Proposals require an
  observation** (`observation_id NOT NULL`, unique). The Telegram callback carries proposal id,
  action and nonce under a 16-byte HMAC, inside 64 bytes.

### 14.2 Tasks

One PR at a time off `main`; every migration rehearsed on a copy of the live database first.

**PR 1 — This amendment.** D43–D52 and §14.

**PR 2 — The models, on the Admin page (migration 0041; D43, D44).** An installation settings table
for the narration/`/ask` model and the agents' model; the AI service resolves the model per purpose
from it, falling back to `LLM_MODEL`. `llm_calls` gains `purpose` (expand: written beside `agent`,
which a later migration drops) and a nullable `agent_id`. Prices for the 5.x generation and the
other listed models; a tool-calling flag per listed model. The Admin page: two pickers, the
estimate per day and month, the OpenRouter balance; each change audited. **Then the user funds the
account and chooses.**

**PR 3 — The scan's inputs (migration 0042; D15, D45).** *Split from the planned scan on
2026-10-06: the loop cannot be measured until the account is funded, and its inputs can be built and
tested without a model.* The migration contracts PR 2's rename (drops `llm_calls.agent`, its CHECK
and trigger; `purpose` gains `agent_scan`, which alone names an agent) and gives each agent its LLM
budget (`agents.llm_budget_micro_usd`, default $0.50) and schedule (`agents.scan_schedule`, default
pre-open). Tool calling in the provider; the day's movers behind `MarketDataProvider` (Yahoo's
day-gainers, day-losers and most-active screens - one request each, cached for every agent in a
slot); the seven read-only tools (§10 D15); the briefing. Nothing calls a model yet.

**PR 4 — The scan (migration 0043; D14, D50, D52, D53, D54).** The per-agent budget checked before
each call; the step limit; `agent_scans` holding each scan's outcome, cost, steps and full
transcript. One hand-written loop (D53). The answer is checked and stored; it proposes nothing yet.
`POST /agents/:id/scans` runs one. Built and tested with a scripted model; **real scans on the funded
account are measured before PR 5** - their cost replaces §14.1's assumption.

**PR 5a — The trade proposal and its approval, on the dashboard (migration 0044; D26, D47-D49,
D51, D55, D56).** *Split by D56; PR 5b is Telegram and the consolidated view's pending proposals.*
**PR 5 as first planned — The trade proposal and its approval (migration 0044; D26, D47-D49, D51).** `buy` / `sell`
proposal kinds, never on the primary (decision 104's allowlist and trigger unchanged);
`CHECK (source <> 'agent' OR proposal_id IS NOT NULL)` on `fills`. A scan's answer becomes an
observation with the thesis in the user's language and a proposal with the agent's quote, TTL from
the next open (D4). Approve previews at the live price (refused beyond 300 bps of the agent's),
Confirm fills through `executeFill` in the approval's transaction; Approve and Reject only; a
refused attempt leaves it pending and is recorded. Dashboard and Telegram; the consolidated view's
pending proposals (D35). `CLAUDE.md` guideline 1 amended for the thesis.

**PR 5b — Telegram (D47, D56, D60-D63).** A scan's proposal is announced, pushed past the floor
(D60, D61); *Approve* replies with the preview and a *Confirm* button carrying the signed price,
a refusal keeps *Approve* and *Reject* (D62); the consolidated view's pending proposals (D35, D63).
No migration.

**News on demand (D57).** A symbol's recent headlines fetched once when none are stored.

**Then: handoff** (five merged PRs).

**PR 6 — The agent page (D45, D46, D50, D52, D64-D66).** The *Decisions* tab; on Settings the schedule
(`agents.scan_schedule`, default pre-open) with its cost per run, the LLM budget, *Run a scan now*,
and the waiting-for-a-persona state; English and Hebrew. No migration.

**PR 7 — The schedule.** Each agent's scans entered through `POST /internal/runs` at its chosen
times on the exchange calendar, with a run key per agent and slot; the kind CronJob and its
contract test; a high-severity `SELL` of a held position delivered through quiet hours (D5).

### 14.3 Measured, 2026-10-07 (live compose database at `0043_agent_scans`)

- **The account is funded** ($10, the user's act, D44); OpenRouter reports `is_free_tier: false`.
  The agents' model was chosen on the Admin page: `anthropic/claude-sonnet-5.5`. Narration stays
  on the free route for now, so task 17's re-measurement measures the model it was about.
- **Three real scans** of a test agent (a cautious large-cap persona, $10,000), 2026-10-07:

  | Outcome | Tool calls | Cost | Time |
  |---|---|---|---|
  | `no_trade` | 2 | $0.0146 | 7 s |
  | `no_trade` | 8 | $0.0775 | 16 s |
  | `invalid_answer` | 2 | $0.0159 | 6 s |

  **$0.036 a scan on average**, against §14.1's assumed $0.04-0.38: each call sent 2,500-5,600
  prompt tokens, not the ~45,000 assumed, and no caching was used. This replaces §14.1's figure in
  D44's and D46's estimates.
- **The reasoning followed the persona** each time: INTC down 3.18% at 112.50, news looked for,
  none found, nothing done. **No news was found for any mover** - news is collected only for
  followed instruments (D57).
- **The invalid answer was a false positive:** "a 60-day range" - the evidence validator read the
  window length as a figure not in the evidence. Fixed by D58.
- **On the PR 5a branch, against a copy of the live database** (the test agent given a persona
  that always buys): five more real scans - two refused for "60-day" and one for its own quantity
  in Hebrew before D58, then two `trade` scans that wrote proposals (buy 2 NVDA at 239.24, one
  thesis in English and one in Hebrew), each $0.014-0.040. The proposal expired at the next open
  plus 60 minutes; *Approve* before the open was refused as `market_closed` and recorded.
- **The Admin page showed "Claude Sonnet 5.5" selected for agents while nothing was chosen** and
  scans ran on the free route: a select with no matching option shows its first. Recorded as debt.
- **PR 5b, rehearsed on a copy of the live database (`0045`), market open, 2026-10-07 ~15:25 UTC.**
  This branch's code, the compose AI service, a fake Telegram transport: a `trade` scan's proposal
  (buy 2 NVDA at 237.14) was announced as a push past the `high` floor, in Hebrew, with *Approve*
  and *Reject*; the consolidated pending list held it. *Approve* previewed at the live 237.14,
  cost 474.28, fee 1.50, cash after 9,524.22; the *Confirm* token carried 23714 in 61 bytes. A
  *Confirm* signed at 2% above it was refused `price_moved`, recorded with `surface: 'telegram'`,
  and gave *Approve* back. The real *Confirm* filled: cash 10,000.00 -> 9,524.22, no buttons left;
  repeating it answered the same fill (one fill row). The proposal left the pending list.
