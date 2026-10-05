# Flows

Companion to [PRD.md](PRD.md) and [DESIGN.md](DESIGN.md). Each flow lists the happy path,
the failure branches we actually handle, and the state it touches.

---

## F1 — Onboarding & portfolio import

```mermaid
flowchart TD
  A[Login with passphrase] --> B[Empty dashboard]
  B --> C{Add holdings}
  C -->|CSV/JSON upload| D[Parse + validate rows]
  C -->|Manual form| G
  D --> E[Resolve symbol -> instrument via provider]
  E -->|ambiguous| F[Show candidate picker]
  E -->|unknown| F2[Row flagged, import continues]
  E -->|resolved| G[Preview table: value, currency, cost basis]
  F --> G
  G --> H{Confirm import?}
  H -->|no| C
  H -->|yes| I[Persist holdings + first snapshot]
  I --> J[Optional: set target weights]
  J --> K[Optional: add interest topics]
  K --> L[Dashboard live]
```
Rules: import is all-or-nothing per *file* only on parse failure; per-row resolution failures
are reported and skipped, never silently dropped. Re-uploading the same file offers
merge-or-replace rather than duplicating holdings.

---

## F2 — Scheduled portfolio scan

```mermaid
sequenceDiagram
  participant T as Trigger (cron / K8s CronJob)
  participant O as Orchestrator
  participant A as ai-service
  participant DB as Postgres
  participant N as Notifier
  T->>O: POST /internal/runs {kind: portfolioScan}
  O->>DB: insert run (run_key) — duplicate key ⇒ 200 no-op
  O->>A: POST /analyze/portfolio {holdings, thresholds}
  A->>A: quotes+FX (cached) → rule findings
  A->>A: news fetch → dedupe → entities → sentiment
  A->>A: correlate price↔news → narrate (validated) → concept links
  A-->>O: observations[] + proposal candidates[]
  O->>DB: upsert observations by dedupe_key
  O->>DB: close episodes the scan saw resolved (stats.seen)
  O->>DB: claim an episode per new candidate — open episode ⇒ no proposal (decision 92)
  O->>DB: create proposals (state=pending, expires_at)
  O->>N: fan-out (severity, quiet hours, digest batching)
  N-->>O: notification rows written with dedupe_key
  O->>DB: finish run (stats: found/suppressed/notified/cost)
```
Failure branches: provider outage ⇒ run marked `degraded`, rule layer still runs on last-known
quotes with staleness noted; LLM budget exhausted ⇒ observations emitted without narration and
flagged `narration: skipped`; ai-service unreachable ⇒ run marked `failed`, one retry with
backoff, no notification; partial success is persisted (never all-or-nothing).

---

## F3 — Human-in-the-loop proposal

```mermaid
stateDiagram-v2
  [*] --> pending: observation deemed actionable
  pending --> approved: user approves (UI or Telegram)
  pending --> rejected: user rejects
  pending --> snoozed: user snoozes (Xh)
  pending --> expired: expires_at passed
  snoozed --> pending: snooze elapses, still relevant
  snoozed --> expired: no longer relevant at wake
  approved --> [*]: intent written to ledger (no broker call)
  rejected --> [*]
  expired --> [*]
```
Invariants: transitions are idempotent (second tap on the same button returns the current
state, never re-applies); an expired proposal can never be approved — the UI/bot answers
"this has expired, here is the refreshed view"; every transition writes an immutable audit row
with surface, actor and the evidence snapshot the decision was made on.

---

## F4 — Telegram binding & approval

```mermaid
sequenceDiagram
  participant U as User
  participant W as Web UI
  participant TG as Telegram
  participant O as Orchestrator
  U->>W: "Connect Telegram"
  W->>O: POST /telegram/bind-token
  O-->>W: deep link t.me/<bot>?start=<signed,TTL,single-use>
  U->>TG: taps link
  TG->>O: webhook /start <token> (+ secret-token header)
  O->>O: verify signature, TTL, unused; bind chat_id↔user
  O-->>TG: "Connected."
  Note over O,TG: later — an alert with inline buttons
  O->>TG: message + callback_data {proposal_id, action, nonce} HMAC-signed
  U->>TG: taps Approve
  TG->>O: callback_query
  O->>O: verify HMAC, burn nonce, check chat binding + expires_at
  O->>O: apply transition (same state machine as UI)
  O-->>TG: edit message → "Approved ✓ (by you, 14:32)"
```
Unbound chat ⇒ ignored silently. Replayed callback ⇒ nonce already burned ⇒ answered with the
current state. Bot commands in v1: `/start`, `/portfolio`, `/pending`, `/mute <duration>`, `/stop`.

---

## F5 — Topic tracking & auto-discovery

```mermaid
flowchart TD
  A[User types topic: 'nuclear energy'] --> B[ai-service resolves to candidates]
  B --> C[Candidate tickers/ETFs + confidence + rationale]
  C --> D{User confirms set}
  D -->|edits| C
  D -->|confirms| E[topic active]
  E --> F[topicScan: news per topic, sentiment, movers]
  F --> G[Topic card + digest section]
  H[Auto-discovery: recurring entities across runs] --> I[topic status=proposed]
  I --> J{User accepts?}
  J -->|yes| B
  J -->|no| K[status=rejected, suppressed from future proposals]
```
Auto-discovery never subscribes on its own (PRD FR-11). A rejected theme is remembered so the
same proposal doesn't return within `TOPIC_REJECTION_COOLDOWN_DAYS` (default 90). "The same" means
every word of the rejected label appears in the new one, or at least half of the new proposal's
instruments were offered with the rejected one. Discovery reads recurring phrases in headlines
collected for what the user already follows (`topic_discovery` run, daily).

---

## F6 — Ask a question (RAG)

```mermaid
flowchart TD
  A[User question] --> B{Intent}
  B -->|about my portfolio| C[Inject structured portfolio + recent observations]
  B -->|about a concept| D[Hybrid retrieve: pgvector + FTS, RRF, rerank]
  B -->|both| E[Both contexts]
  C --> F[Answer with figures taken only from structured data]
  D --> F
  E --> F
  F --> G{Relevance above floor?}
  G -->|no| H["Not in my index" + what would be needed]
  G -->|yes| I[Answer + citations + related concepts]
```

---

## F7 — Daily digest

Fires once after market close (user timezone): portfolio delta and equity curve, top N
observations by severity, per-topic sentiment shift, pending proposals awaiting the user.
Delivered to UI inbox + Telegram as one message. Suppressed entirely if nothing crossed a
threshold and there are no pending proposals — silence is a valid digest.
