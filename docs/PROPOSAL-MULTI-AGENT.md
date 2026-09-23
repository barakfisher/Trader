# Architecture Specification — Multi-Agent Trading Sandbox

**Status: approved specification, not yet implemented.** The product and engineering decisions in
this document are settled. What follows is the agreed design and its four-stage execution plan,
written against the system as it exists at PR #40.

A user creates several named **agents**, each with its own analysis philosophy, simulated budget and
domain focus, each keeping its own paper portfolio and sending its own proposals. The user's real
portfolio is one of these agents — the primary one — and is never simulated, never proposes, and
never spends.

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
`intents`, `runs`, `portfolio_snapshots`, `target_weights`, `notifications`.

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

Replacement: `hash(agent_id | kind | subject_ref | severity | date_bucket)`.

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
`kind:userId:agentId:bucket`.

**Shared-ingestion run kinds are attributed to the primary agent.** `backfill` and
`instrument_metadata` fetch data that every agent shares (§4.1); they are not any agent's work. Under
`agent_id NOT NULL` they are recorded against the primary agent, and that is an accounting
convenience rather than a claim. `GET /runs` filtered to an agent must therefore exclude the shared
kinds, or the primary's run history will appear to contain work it did not do.

**Needs no change:** `notifications.dedupe_key` is `hash(channel, ref_kind, ref_id)` and `ref_id` is
a row id, so it separates per agent for free.

---

## 4. Stage 2 — Deterministic agents

Own portfolio, own observations, own thresholds, consolidated UI. No LLM, no budget, no proposals.
This stage is cheap and proves the isolation with zero cost exposure.

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

Still deterministic. This is the first point at which an agent can be right or wrong, and it is the
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
- **An out-of-budget proposal is rejected, not clamped.** Silently resizing an order the user
  approved changes what they agreed to.
- Cost basis per unit; totals computed at read time (guideline 3).

### 5.2 Proposal lifecycle and the two approval paths

The existing state machine — `pending · approved · rejected · snoozed · expired`
([proposalState.ts:31](../apps/orchestrator/src/services/proposalState.ts#L31)) — **gains no new
state.** "Executed" is not a state; it is the fill that approval writes. `intents_one_per_proposal
UNIQUE (proposal_id)` already makes a second approval a no-op at the database level, so an
idempotent double-tap cannot produce a second fill. That guarantee extends to fills unchanged.

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
| **1 — Isolation** | `agents` table, primary seeded + backfilled, `agent_id NOT NULL`, the three constraint replacements (§3.3) | — |
| **2 — Deterministic agents** | Per-agent `AnalysisThresholds`, per-agent portfolios and observations, consolidated UI with filter and split figures | Stage 1 |
| **3 — Budget, fills, scoring** | `agent_cash`, fills from stored quotes, dashboard + Telegram approval, `manual_user_override`, 30/60/90-day scoring | Stage 2 |
| **4 — LLM philosophy** | Judgement artifacts, per-agent budgets, pre-open/post-close schedule + exchange calendar, persona rationale behind the validator | Stage 3, M3, M5, a funded workspace, a real news provider |

The PRD P2 amendment (§2) ships with stage 1, since it is the boundary the whole feature stands on.
