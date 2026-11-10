# Review — Backend (2026-11-10)

Scope: `apps/orchestrator` and `services/ai`, read at `95e4c6e`. Read-only: nothing was started,
no network, no database, no `.env`. One pure function (`evidence_validator.unsourced_figures`) was
executed locally against hand-written inputs to confirm finding 2; everything else is from reading
the code paths cited.

## Summary (5 lines max)

The write paths that move money or state (fills, proposal transitions, run claims, notification
claims) are careful and race-safe; I found no double-approval or double-fill path. The weak side is
**what happens after a failure**: a muted or failed digest, a failed push and a scan interrupted by
a deploy are each recorded as final and never tried again. The figure check is a set-membership
test, so a real figure attached to the wrong subject, sign or unit passes it, and one model-written
field skips it. The AI service runs synchronous SQL on its single event loop.

## What is strong and should stay

- **Run claims in Postgres** (`db/queries/runs.ts:69-140`): the INSERT is the claim, stale claims
  are reclaimed, heartbeats for long runs, timers that ask more often than the work is due
  (`scheduler.ts:27-60`). Restart-safe and multi-instance-safe for the claim itself.
- **The fill path** (`services/fills.ts:409-507`): bigint arithmetic end to end, cash row locked,
  idempotency key re-read under the lock, approval written in the fill's transaction
  (`tradeApproval.ts:281-300`), the database's own CHECK as the last line.
- **Conditional state transitions** (`db/queries/proposals.ts:236-256`): `AND state = $fromState`
  makes a web click and a Telegram tap one decision; the loser re-reads.
- **Claim, send, settle** for notifications (`services/notifications.ts:10-22`): the window is on
  the "missing" side, not the "duplicate" side. The ordering is right; finding 1 and 5 are about
  what happens to the row afterwards.
- **The AI client** (`packages/shared/src/ai/client.ts:151-200`): every response parsed with zod at
  runtime, a timeout per call sized to the work, gateway errors typed.
- **Spend guard** (`llm/budget.py:118-142`): fails closed on a zero cap and on an unreadable
  counter, checks the call's worst case before admitting it (D355), records spend on failed calls.
  The acknowledged race (two calls admitted at once) is the right trade against leaked reservations.
- **Unpriced is never zero on the quote path**: last-known-good is served flagged `stale`
  (`providers/registry.py:173-185`), a total quote failure degrades to an unpriced portfolio
  (`valuation.ts:112-121`), a snapshot with nothing priced is not written (`snapshot.ts:77-90`).
- **D397's answer parser** (`agents/answer.py:146-168`) and the capped tool results
  (`agents/tools.py:54-73`): prompt growth in a scan is bounded by construction.
- **`/readyz` semantics** on both services: status code answers "send traffic here?", the body
  says the rest, and the AI service being down does not take the orchestrator out of rotation.

## Findings (ranked)

### 1. A digest that is muted, or that fails to send, discards its entries — High

- **Evidence.** `services/notifications.ts:372-376` builds
  `{ delivered: false, error: 'the user is muted, so the digest was held' }`, and lines 398-404 then
  settle **every** pending entry as `failed`. `listPendingDigest` reads only `status = 'pending'`
  (`db/queries/notifications.ts:94-96`), and each entry's `dedupe_key` is already taken, so nothing
  can claim it again. The same happens when Telegram is down at digest time (line 396). The
  digest's run key is daily and is not in `RETRY_FAILED_KINDS` (`http/routes/internal.ts:110`).
- **Failure.** The policy test says the intent in its own title: "digests rather than discards
  while muted" (`test/notificationPolicy.test.ts:200`). A user who mutes until tomorrow loses every
  finding deferred during the mute, at the first digest that runs inside it. The word "held" in the
  error is not true. `sendDigest` has no test at all (no test file references it).
- **Improvement.** Leave entries `pending` when the digest is muted or the send fails; mark `sent`
  only on delivery. For a failed send, allow the daily key to be retried on the next hourly ask (the
  send is one message, so "may have sent part" does not apply when nothing was settled). Add tests:
  muted, send fails, send succeeds.
- **Effort.** S.

### 2. The figure check is a set-membership test: a real figure on the wrong subject, sign or unit passes — High

- **Evidence.** `narration/evidence_validator.py:276-289` accepts a written number if **any** value
  in the evidence rounds to it; `_forms_for` adds both signs (line 196); numbers inside any
  evidence string are sourced for every use (lines 250-254); only digits are read
  (`_NUMBER_PATTERN`, line 55). For a scan the evidence is the whole briefing, every tool result
  and the user's instructions (`agents/scan.py:416-424`); for Ask it includes the user's own
  messages (`assistant/reply.py:228`). Executed against a two-holding briefing with one news
  headline, all of these returned no unsourced figure:
  "MSFT fell 8.5% to $182.40" (AAPL's figures); "AAPL rose 8.5%" (it fell); "AAPL is up 182.40%"
  (a price as a percent); "AAPL is 12% of the book" (a share count); "AAPL has gained 40%" (from a
  headline); "AAPL earned $3 billion" (3 from the instructions); "fell by a third ... dropped
  ninety percent" (no digits). The control ("fell 9.7% to $171.15") was refused.
- **Failure.** Guideline 7 promises that figures come from evidence. What the check proves is
  narrower: the digits exist somewhere in what the model saw. The larger the evidence (12 tool
  calls, 60 closes each, 8 headlines), the more any small number is "sourced". `scan.py:102-104`
  already says the check cannot see qualitative claims (D394); the numeric gap is not written down.
- **Improvement.** Cheap, in order: (a) refuse number words and magnitude words next to a figure
  ("billion", "third", "doubled") or treat them as unsourced; (b) make `%` strict: a figure
  followed by a percent sign matches only ratio-keyed values, never counts, prices or strings;
  (c) drop the sign-free match when the sentence has a direction verb (rose/fell) and the evidence
  value has a sign; (d) for narration, where the evidence is one finding, bind the nearest ticker
  to the figure's subject. Structurally: have the model cite a key path per figure and render the
  number server-side. Until then, say in the UI copy and docs what the check does and does not
  prove.
- **Effort.** (a)-(c) M; key-path citation L.

### 3. A scan's overview thesis beside its trades is never figure-checked, and is shown — High

- **Evidence.** `agents/scan.py:484-489`: `overall_thesis_problems` is computed for the first
  answer but acted on only when the answer is a pass (`passes and ...`). `_conclude`
  (`scan.py:605-611`) checks the overall thesis only `if not review.kept and not refused`, yet
  stores `thesis` in `result.answer` unconditionally. `scanSummary.ts:36-38` returns it as "an
  overview beside its trades", and `apps/web/src/components/AgentDecisions.tsx:294-296` renders it.
- **Failure.** An answer of `{"trades": [...valid...], "thesis": "NVDA trades at 35x earnings..."}`
  shows the user a model-written sentence whose figures nobody checked, on the same card as checked
  ones. This is the one place I found where model prose reaches the screen around the validator.
- **Improvement.** In `_conclude`, run `overall_thesis_problems` whenever `thesis` is not None; on
  a problem, drop the overview (store it under the transcript only) rather than failing the trades.
  One test: kept trade plus an overview with an invented figure.
- **Effort.** S.

### 4. A scheduled scan interrupted by a restart leaves its slot dead, silently — Med

- **Evidence.** `nextAttempt` returns null while the last attempt is `running`, with no age limit
  (`services/scheduledScans.ts:108`). A run is reclaimed only by a later claim of the **same key**
  (`db/queries/runs.ts:109-128`), and nothing claims an attempt's key twice: the BullMQ job id is
  that key and finished jobs are kept three days (`services/scanQueue.ts:24, 69-74`); a stalled job
  that BullMQ re-delivers meets `claimRun` refusing and returns (`scheduledScans.ts:244-245`).
  Shutdown gives in-flight work 10 seconds (`server.ts:85`) and closes the queue only inside
  `server.close`'s callback (`server.ts:79-80`), while one attempt may run 6 minutes
  (`ai/client.ts:104`).
- **Failure.** Any deploy or crash during a slot: the run stays `running`, the plan waits on it
  until the window closes, no retry is made and the give-up notice (the code's D74) is never sent,
  because it is only reached through `finish`. The scan the user scheduled did not happen and
  nothing says so. The AI service side recovers (`scan_log.py:45`, 15 minutes); the orchestrator
  side does not.
- **Improvement.** In `nextAttempt`, treat a `running` attempt older than the attempt timeout plus
  a margin as a retryable failure (and mark it failed with `cause: 'timeout'`). On SIGTERM, stop
  the poller and scheduler, `await worker.close()` first with a grace that covers a scan, then
  close HTTP. Test: a `running` row 20 minutes old yields the next attempt.
- **Effort.** S for the plan; M with the shutdown ordering.

### 5. A push that fails once is lost: no retry, no fallback to the digest — Med

- **Evidence.** `fanOut` settles a failed delivery as `failed` (`notifications.ts:262-270`) with the
  dedupe key spent. The Telegram client retries once, immediately, on 429/5xx only; a transport
  error or timeout returns at once (`telegram/client.ts:463-492`, lines 472-476), and a 429's
  `retry_after` is not read. The module header says a crash "leaves a `pending` row ... which the
  digest will pick up" (`notifications.ts:20-21`), but a pending push row has `channel = 'telegram'`
  and the digest reads `channel = 'digest'` only (`db/queries/notifications.ts:95`).
- **Failure.** A ten-second network blip while a trade proposal is announced means the user is
  never told; the proposal expires unseen. The row says `failed`, which is honest, but nobody reads
  it. The header's recovery claim is not true of the code.
- **Improvement.** On a transient failure (transport, 429, 5xx) re-route the row to the digest
  channel (`UPDATE ... SET channel = 'digest', status = 'pending'` with the digest's dedupe key) so
  the daily message carries it; honour `retry_after` up to a few seconds; one retry with backoff on
  transport errors. Keep 4xx (blocked bot) final, as now.
- **Effort.** M.

### 6. The AI service runs synchronous SQL on its only event loop — Med

- **Evidence.** One sync engine (`app/db.py:23`, no statement or pool timeout), 68
  `engine.connect()/begin()` sites, every route `async def`, one uvicorn worker
  (`infra/docker/Dockerfile.ai:60`). Examples on hot paths: `within_budget` runs a query on every
  model turn (`agents/scan.py:455-457`); `routers/analysis.py:66` opens a transaction with
  `get_engine().begin()` and holds it across the whole scan, model calls included.
- **Failure.** While any query runs, nothing else in the service does: quotes for the dashboard,
  `/readyz`, another user's Ask. `asyncio.wait_for` cannot cancel a blocked loop, so the 120 s and
  300 s limits do not bound it. D377 records exactly this (a 1,357 s stall) and fixed that query; I
  agree with that fix, but the class remains, and D377's rejection of `statement_timeout` was as
  the only fix, not as a backstop. The scan's long transaction also sits idle-in-transaction on a
  pooled connection for minutes.
- **Improvement.** Backstop first: `connect_args={"options": "-c statement_timeout=15000 -c
  idle_in_transaction_session_timeout=60000"}` on the engine, and the same pair on the
  orchestrator's pool (`db/pool.ts:16-21` sets neither). Then move DB work off the loop where it is
  called from async code (`asyncio.to_thread`, as `universe/rescreen.py:100` already does), starting
  with the tool handlers and `within_budget`. Split the portfolio scan's transaction: read, release,
  narrate, write.
- **Effort.** S for timeouts; M-L for the rest.

### 7. One odd narration reply fails the whole portfolio scan — Med

- **Evidence.** `narration/narrator.py:339-343`: `payload = json.loads(cleaned)` then
  `payload.get("headline")`. A reply that is valid JSON but not an object (`[...]`, `"text"`,
  `null`) raises `AttributeError`; `_narrate` catches `LLMError` only (line 272) and the pipeline's
  loop does not catch (`analysis/pipeline.py:281-283`). The other parsers check
  `isinstance(data, dict)` (`research/rating.py:93`, `agents/mandate_check.py:180`); the test covers
  only "not json" (`tests/test_narration.py:377-380`).
- **Failure.** The scan answers 500, every finding of that run is lost (including those already
  narrated and paid for), and the run is `failed` until the next 30-minute bucket. The template
  fallback that exists for this case is skipped.
- **Improvement.** `if not isinstance(payload, dict): return None`. While there, reuse D397's
  `_answer_object` so prose around the object is tolerated here too. Also narrate findings
  concurrently (a small semaphore) instead of one `await` per finding.
- **Effort.** S.

### 8. Valuation multiplies money by a float and can return zero for bad input — Med/Low

- **Evidence.** `packages/shared/src/money.ts:70-74`: `scaleMinor` does `Number(quantity)` on a
  `numeric(38,18)` string, multiplies, rounds, and returns **0** for a non-finite quantity.
  `convertMinor` (lines 77-89) rounds a second time and returns 0 for a bad rate. Both feed every
  holding's value (`services/valuation.ts:137-152`), hence the dashboard, snapshots and the scan's
  `value_minor`.
- **Failure.** Guideline 3 says integer arithmetic and one rounding; a foreign-currency holding is
  rounded twice, and a quantity with many decimals is rounded through a double. Realistic error is
  one minor unit, so this is correctness of principle more than of amounts. The zero is the sharper
  edge: guideline 7 says unavailable is null. `valuation.ts:137` guards a missing rate but a rate
  of `"0"` is a truthy string and would value the holding at 0.
- **Improvement.** Do it as the fill path does: bigint over scaled decimals (quantity × 10^18,
  rate × 10^k), one division with rounding at the end; return `null` for unparsable input and let
  the caller mark the holding unpriced.
- **Effort.** M (shared by web and orchestrator; property tests against the Python `Decimal`).

### 9. Redis is a single point of failure for pricing, and the cache's single-flight is unused — Low/Med

- **Evidence.** `core/cache.py:35-47`: `get`/`set` let any Redis error propagate, so
  `MarketDataService.quotes` fails whole (`providers/registry.py:129-132, 168-171`). The module
  advertises single-flight (`cache.py:1-7`, `get_or_set` lines 49-76) but nothing calls it. Quotes
  are read with one GET per symbol in a loop (`registry.py:129-132`). There is no circuit breaker:
  with Yahoo hanging, each symbol waits its full timeout on every request, and
  `asyncio.wait_for(asyncio.to_thread(...))` (`yfinance_provider.py:196-199`) abandons the thread
  without stopping it, so the default executor fills.
- **Failure.** A Redis restart makes every holding unpriced although the provider is healthy (the
  orchestrator degrades honestly, so it is an outage, not a wrong number). Two dashboards opened
  together fetch the same symbols twice against a quota-limited provider.
- **Improvement.** Catch Redis errors in `Cache.get/set` (miss / no-op, logged once); `MGET` the
  quote keys; either use `get_or_set` per symbol or delete it; a per-provider breaker (N failures →
  skip for T seconds) so a dead provider costs one timeout, not one per symbol.
- **Effort.** S-M.

### 10. Graceful shutdown stops accepting work but does not wait for it — Low

- **Evidence.** `server.ts:75-86`: 10-second hard exit; `scanQueue.close()` and `closePool()` run
  only after `server.close` reports every connection ended; a fan-out `POST /internal/runs` can be
  minutes long (`internal.ts:424-435`, each user's scan up to 5 minutes). The AI service's research
  tasks are plain `asyncio.create_task` (`routers/research.py:117-130`) and are dropped at exit.
- **Failure.** Every deploy during a scan produces a `running` row (reclaimed after 30 minutes for
  timer kinds, never for slot attempts — finding 4) and a half-written run. Both services recover
  by design for most kinds; the cost is lost paid model calls and finding 4.
- **Improvement.** With finding 4. Also set the container's stop grace to match.
- **Effort.** S-M.

### 11. Sub-day run buckets repeat for one hour on the autumn clock change — Low

- **Evidence.** `http/routes/internal.ts:113-120`: the key is `<local date>:<slot of the UTC
  minute-of-day>`. On a 25-hour local day the same UTC hour falls inside one local date twice
  (Asia/Jerusalem: 21:00-22:00 UTC at both ends of the last Sunday of October).
- **Failure.** `portfolio_scan`, `news_collect`, `proposal_sweep` and `agent_scans` asks are
  answered "already claimed" for that hour, once a year per timezone. Harmless in size, but it is
  the silent skip the header of `scheduler.ts` is written against. `test/runBucket.test.ts` has no
  DST case.
- **Improvement.** Key sub-day buckets on the UTC date (`toISOString().slice(0, 10)`), keeping the
  local date for daily kinds only.
- **Effort.** S.

### 12. Fan-out runs every user in turn inside one HTTP request — Low (grows with users)

- **Evidence.** `internal.ts:424-435` awaits each user's run sequentially; the timer's `fetch` has
  no timeout (`scheduler.ts:114-118`); `planScheduledScans` reads slot attempts one agent at a time
  (`scheduledScans.ts:172-190`).
- **Failure.** With N users a `portfolio_scan` ask takes N scans' time; past the 30-minute bucket
  the later users' scans slide into the next bucket and the timer's asks overlap (claims keep them
  correct, not timely). Agent scans already solved this with a queue (the code's D73).
- **Improvement.** Put per-user runs on the same BullMQ queue (the run key is the job id already);
  the HTTP call then only plans. Not urgent at today's user count; decide before public signup.
- **Effort.** M.

### 13. Observability stops at logs — Low

- **Evidence.** Scheduled attempts call the AI service with no request id
  (`scheduledScans.ts:268`), so the AI service mints its own (`app/main.py:141`) and the two logs
  join only through `scan_id`. No metrics endpoint or error reporter exists in either service
  (grep for prometheus/sentry/metrics finds only Langfuse's tracing). The AI service's `/readyz`
  checks Redis but not Postgres (`routers/health.py:30-49`), though scans, Ask and news need it.
  `unhandledRejection` is logged and ignored (`server.ts:90`).
- **Failure.** "Did pushes fail this week?", "how long do scans take?", "is the loop stalling?"
  each need a hand-written SQL or log search. A Postgres outage leaves the AI pod "ready".
- **Improvement.** Pass the run key as `x-request-id` from the worker; add Postgres to the AI
  `/readyz`; a small `/metrics` (run outcomes, push failures, LLM verdicts, event-loop lag) or a
  daily ops digest built from `runs` and `notifications`, which already hold the facts.
- **Effort.** S-M.

### 14. API consistency — Low

- **Evidence.** Query parameters are parsed by hand and an invalid `limit` silently becomes the
  default (`routes/portfolio.ts:151-152`, `routes/proposals.ts:143-145`,
  `routes/notifications.ts:46-48`) while bodies use zod; three paging styles coexist (`before=<id>`
  `portfolio.ts:158`, `before=<datetime>` `agentScans.ts:33`, limit-only elsewhere);
  `GET /runs?kind=` is unvalidated (`internal.ts:453`); the 404 body omits `requestId`
  (`app.ts:270-275`) though every other error carries it (`errors.ts:62-88`); a non-JSON error body
  from the AI service is reported as "unreachable, 503" because `JSON.parse` throws before the
  status is read (`ai/client.ts:170-171, 193-196`); there is no version prefix.
- **Failure.** Small surprises for a client; a proxy's HTML 502 is logged as the wrong fault.
- **Improvement.** One `listQuery` zod schema (limit, before) shared by list routes, 400 on a bad
  value; parse the AI body inside a try and keep the status; add `requestId` to 404. A version
  prefix is not worth it while the web app is the only client.
- **Effort.** S.

### 15. A new HTTP client per model call — Low

- **Evidence.** `llm/openai_compatible.py:378-396, 406`: `async with self._client()` builds and
  closes an `AsyncOpenAI` (and its connection pool) for every completion.
- **Failure.** A TLS handshake per turn; a 12-turn scan pays it 12 times, inside a 300 s limit.
- **Improvement.** One client per provider instance (per key), closed in `lifespan`.
- **Effort.** S.

## Unverified

- **How often findings 1 and 5 have already happened.** Check, read-only, on production:
  `SELECT error, count(*) FROM notifications WHERE status = 'failed' GROUP BY 1` — look for
  "the user is muted, so the digest was held" and "transport error%".
- **Finding 4 in practice.** I traced the code but did not kill a process. Check: in compose, start
  a scheduled attempt, `docker kill` the orchestrator mid-scan, restart, and watch whether the slot
  gets another attempt or a give-up notice; and `SELECT run_key, started_at FROM runs WHERE kind =
  'agent_scan' AND status = 'running' AND started_at < now() - interval '1 hour'` on production.
- **A crash between `scanAgent` returning and `proposeFromScan` writing**
  (`scheduledScans.ts:268-269`): the AI service has stored a `trade` scan, the orchestrator has
  written no proposal. I did not find a reconciler. Check: a scan with outcome `trade` and no row in
  `proposals` for its `scan_id`.
- **Whether SIGTERM reaches the orchestrator at all.** The image runs `pnpm start`
  (`infra/docker/Dockerfile.orchestrator:38`); a package manager as PID 1 does not always forward
  signals. Check: `docker stop` the container and look for the "shutting down" log line.
- **Event-loop stall size (finding 6).** Check: log loop lag (a 1 s ticker that reports drift) for
  a day, or compare `/healthz` latency during a portfolio scan.
- **Idle-in-transaction during a portfolio scan.** Check: `SELECT state, now() - xact_start FROM
  pg_stat_activity WHERE state = 'idle in transaction'` while a scan narrates.
- **Telegram's 429 `retry_after`.** The immediate retry (`telegram/client.ts:463-492`) will likely
  hit the same limit; I did not test against Telegram.
- **The digest's duplicate on a crash between send and settle** (`notifications.ts:377-404` with
  the 30-minute stale reclaim): plausible, rare, not traced end to end.
- **Thread build-up under a hanging Yahoo** (finding 9): reasoned from `asyncio.to_thread`'s
  semantics, not observed.
