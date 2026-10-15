# M9 PR 1 - what assumes one user (measured 2026-10-15)

M9's first step ([MILESTONES.md](MILESTONES.md#m9--multiple-users-planned-2026-10-14-pr-1-measured-2026-10-15)):
every query, route, run kind, cache key, budget and notification path that assumes one user,
with where it is. Read-only. Nothing here is decided; the decisions come next, each with a
recommendation, and this list is what they are argued from.

**How it was measured.**
- `git grep` for `SINGLE_USER_ID`, the seeded id and `APP_TIMEZONE`.
- A script that read every exported function in `apps/orchestrator/src/db/queries/*.ts` and
  every function in `services/ai/app/**/*.py`. It flagged each one that touches any of the 28
  tables with a `user_id` column without taking a user or agent id, and every flagged function
  was then read by hand.
- `pg_index` for unique indexes on those tables that do not include `user_id`.
- Every route registration under `http/routes/` and `telegram/`.
- Row counts per user on both databases: compose, and kind's `postgres-0`.

**The short answer.** The data layer is already multi-tenant. No user-facing query reads another
user's rows, and no unique constraint collides when a second user appears. Seven things assume one
user:
1. Login.
2. The scheduler, which never names a user.
3. Installation work that runs as a user's run.
4. One installation-wide LLM ceiling.
5. A time zone that cannot be set.
6. A user that cannot be deleted.
7. An admin gate around a user's own reset.

## 1. Where a request falls back to the seeded user

| Where | What it does |
|---|---|
| `apps/orchestrator/src/config.ts:75` | `SINGLE_USER_ID` defaults to `00000000-…-000000000001`, a value published in this repository (the reason `TELEGRAM_SIGNING_SECRET` is separate, `config.ts:108`) |
| `http/routes/auth.ts:48` | `POST /auth/login` checks `APP_PASSPHRASE` and signs in as `SINGLE_USER_ID`, always. No credential names a user |
| `http/routes/internal.ts:166` | `POST /internal/runs` runs as `SINGLE_USER_ID` when the body names no user |
| `scheduler.ts` `triggerRun` | The local timer posts `{kind, trigger}`, never a `userId` |
| `infra/k8s/base/cronjobs.yaml` | All 11 CronJobs post `{kind, trigger: "cronjob"}`, never a `userId` |
| `alembic/versions/0001`, `0025` | Seed the user and make it `admin` |
| `.github/workflows/ci.yml:288-290` | CI flips the seeded user's role by its id to test the admin gate |

So **every scheduled run is the seeded user's**, and the fallback at `internal.ts:166` is not an
edge case: it is the only path the schedule takes. Measured:

| | users | runs | runs with no user |
|---|---|---|---|
| compose | 1 | 2,679 (11 kinds) | 0 |
| kind | 1 | 1,776 (10 kinds) | 1 (the one `universe_rescreen`) |

Nothing outside these files names the seeded id: not the web app, the AI service's code or the
scripts.

## 2. Run kinds: whose work each one is

`POST /internal/runs` claims every kind except the rescreen under a user and that user's primary
agent (`runs_agent_run_key`; the default run key embeds the user id). Iterating users there is the
obvious change, and it is wrong for three kinds:

| Kind | Whose work | What iterating users would do |
|---|---|---|
| `snapshot`, `portfolio_scan`, `topic_scan`, `topic_discovery`, `daily_digest`, `agent_scans` | One user's | Right: one run per user |
| `backfill` | Asks for the closes of `listAnalysedInstruments(userId)` ∪ `listTradedInstruments(userId)` ∪ the benchmarks. The closes land in shared tables | Fetches every shared instrument and every benchmark once per user. The union across users is one request |
| `news_collect` | Collects for one user's instruments into `articles`, a shared table (no `user_id`) | Same as backfill: N collections of overlapping symbols |
| `proposal_sweep` | Already every user's (`sweepExpiredProposals()` is deliberately unscoped, `internal.ts:281`), but claimed as the seeded user's run. 930 runs on compose, 655 on kind | Runs N identical sweeps |
| `instrument_metadata` | The installation's (names instruments), claimed as the seeded user's | Runs N times; all but the first find nothing |
| `universe_rescreen` | The installation's, already claimed with no user | Unaffected |

## 3. Queries and routes

**SQL.** The orchestrator has 31 query modules. Every function that touches a user-owned table
either takes the user (or one of that user's agents), or is one of these:
- **A by-id write after a scoped read:** `finishRun`, `settleNotification`, `agent_scans` →
  `finish_scan`, `llm_calls` → `set_verdict`.
- **An admin read of the whole installation:** `listAllRuns`, `listOpsEvents`, `groupLlmCalls`,
  `llmLatencies`, `listLlmCalls`, `firstLlmCallAt`, `countNarrationFallbacks`. On the AI side
  `spend_estimate.explain_basis` / `agent_basis` give the Admin page's cost estimate.
- **Deliberately every user's:** `sweepExpiredProposals`.
- **The installation's own rows:** the rescreen's `runs` rows; `get_universe_info` reads them.

**Routes.** There are 78 route registrations, and every route that takes an id passes
`currentUserId` into the lookup:
- `getAgent(userId, id)`
- `findProposal(userId, id)`
- `getHolding(userId, agentId, id)`
- `getAgentScan(userId, agentId, scanId)`
- `getAssistantConversation(userId, id)`
- the topic routes' `userId`

Another user's id therefore answers 404, the same as an id that does not exist. Telegram resolves a
chat to its binding's user (`telegram/updates.ts:273, 390`). It never trusts a user id from a
callback payload; the bind token's user id is signed.

**What is not proved.** Four test files assert cross-user isolation for single features:
`assistantApi`, `holdingDetailApi`, `proposalsApi` and `queries.postgres`. Nothing signs in as one
user and walks every route, which is what M9's exit asks for.

## 4. Unique constraints, cache keys and dedupe keys

None collides when a second user appears.

- **19 unique indexes** on user-owned tables omit `user_id`. Each is keyed on one of:
  - an agent (`holdings`, `observations`, `portfolio_snapshots`, the episode tables, the open
    `agent_scans`, `fills` idempotency, the opening deposit);
  - a row id (`proposal_id`, `fill_id`, `scan_id`, `observation_id`);
  - a key that embeds one. `notifications.dedupe_key` is `channel:refKind:refId`, and the ref is a
    user's row. `ops_events` keys embed the user id (`universeGaps.ts:111, 143`).
  - `runs_agent_run_key`'s key embeds the user id.
  - `telegram_bindings.chat_id` is one chat to one user, as intended.
- **Redis** holds market data only: `history:`, `resolve:`, `fx:`, `movers`, `news:on_demand:`,
  and the rate limiter's per-provider counters. It is shared by design and holds nothing of a
  user's. Scan-queue job ids come from run keys, which carry the agent.

## 5. Budgets, limits and the queue

| What | Scope today | Where | Consequence with several users |
|---|---|---|---|
| `LLM_DAILY_BUDGET_USD` | **Installation**, UTC day | `services/ai/app/llm/budget.py` | One user's agents and questions can exhaust narration for everyone; the fallback hides it as template text |
| Assistant allowance | Per user, amount from `installation_settings` | `assistant/budget.py` | Correct, but its "midnight" is `settings.app_timezone` (`routers/assistant.py:103`), not the user's zone |
| An agent's monthly LLM budget | Per agent | `agents/scan_budget.py` | Correct |
| `max_agents_per_user` | Per user, set per installation | `installation_settings` | Correct |
| Model choice per scope | Installation | `llm_model_choices` | Every user's narration and assistant use the admin's choice |
| Scan queue | One BullMQ queue, `AGENT_SCAN_CONCURRENCY` global | `services/scanQueue.ts` | No fairness: one user's due agents can fill every slot (D73: per-user groups need BullMQ Pro) |

## 6. Time zone

The doc that planned M9 says "today resolves in `APP_TIMEZONE`". The code is further along than
that:
- **`users.timezone` already exists** (default `Asia/Jerusalem`).
- It is what the run keys use (`localDate(user.timezone)`), along with the digest and the gap
  events.
- The session carries it to the web app (`/auth/session`; `relativeTime.ts`).

What remains per installation:
- **Nothing writes `users.timezone`.** No route, no setting, no migration after the seed. A
  second user would be in Jerusalem.
- **The AI service reads only `APP_TIMEZONE`:** the assistant's scheduling answer (`next_scan`) and
  its budget's midnight (`routers/assistant.py:61, 103`).
- **The rescreen's day** (`internal.ts:145`, `admin.ts:299`) is the installation's, correctly.

## 7. Login, sessions and the user's lifecycle

**Login and sessions.**
- **One credential:** `APP_PASSPHRASE`. The login page's copy names it
  (`i18n/locales/en.json` `intro`, and `he.json`).
- `users.email` exists, is nullable and unique, and nothing reads it.
- **Sessions:** a signed, self-describing cookie (`http/auth.ts`) with no session table. A
  session cannot be ended before `SESSION_TTL_HOURS`. The role is read from `users` on every admin
  request, so a demotion is immediate; a removal is not.

**Creating a user** works in the database: an insert fires `users_seed_primary_agent`. No route
does it.

**Deleting a user fails.** Seven foreign keys to `users` have no `ON DELETE` action:
- `agent_cash`
- `agent_scans`
- `assistant_conversations`
- `cash_movements`
- `fills`
- `proposal_attempts`
- `admin_audit`

`DELETE FROM users` errors as soon as the user has any of those rows. Of the other 23, 20 cascade and 3 set the reference to null.
Removing a user is therefore one of two things:
- **a disable** (a state on `users`, plus the session problem above);
- **an erase** (a migration that settles those seven, including whether an admin's audit trail
  outlives them).

## 8. The admin surface

`/admin/*` is gated by `users.role`:
- `/admin/runs`, `/admin/gaps` and `/admin/llm` read **every user's** rows. On one installation
  that is the operator's view, and it is the "what an admin may see" decision.
- `/admin/account/reset` resets **the caller's own** account (`currentUserId`), but sits behind the
  admin gate. A user who is not an admin cannot reset their own account.
- `/admin/settings` and `/admin/llm/models/:scope` set installation-wide values.

## What this changes in the decisions

The decision list in MILESTONES.md stands. The measurement sharpens five of them:
- **Scheduling** is three changes, not one:
  1. The triggers stop relying on the fallback.
  2. The per-user kinds iterate users.
  3. `backfill`, `news_collect`, `proposal_sweep` and `instrument_metadata` become installation
     runs over the union of what users hold.
- **Shared costs** has a concrete risk: the installation-wide daily ceiling in front of everyone's
  narration.
- **Time zone** needs a write path and two AI-service reads, not a new column.
- **Sessions and removing a user** come together: neither a disable nor an erase exists, and the
  cookie outlives both.
- **Admin** includes moving the account reset out from behind the admin gate.
