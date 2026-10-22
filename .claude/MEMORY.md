# Project memory — Traders

Written for a session that has never seen the conversation that built this. The code is readable;
the reasoning behind it is not, and that is what this file is for. Maintained per
[CLAUDE.md](../CLAUDE.md) "Session management & memory".

Updated: 2026-10-21 - **Handoff at a milestone boundary: M9 (multiple users) is complete in one
PR** - scheduling per user (D238), the user's own zone (D163's reads, guideline 10 amended), the
admin's user list and each user's own reset (D239), and the exit test (D240), all asked up front
and built without stopping, as the user asked. Merges since handoff #285: #286 (memory), #287
(D227-D228), #288 (the dashboard's one holdings table, D229-D233) and #289 (idle cash must be explained, D234-D237) - both another session's - and this PR. Decisions reached **240** (next: **241**). Migrations: none in this PR;
**`0067_telegram_conversation` is head** (next free: **`0068`**). **Deployed:** compose runs #289
at `0067` (read 2026-10-21); **this PR is undeployed**; kind's state is the other session's to report (its CronJobs change here).
**Next:** "Next session: after M9".

Previous update, 2026-10-20 ~20:30 UTC - **Handoff: improvements items 4-5 and the two small fixes from
the own-key check are merged and deployed.** Merges since handoff #279: #280 (re-check an expired
proposal, D212-D217, `0066`), #281 (D218-D219), #282 (Telegram ask mode, D220-D224, `0067`), #283
(Create agent says what is missing, D225), #284 (the product guide names only the assistant's
own tools, D226) - five, so this PR is the handoff. Decisions reached **226** (next: **227**).
Migrations: **`0067_telegram_conversation` is head** (next free: **`0068`**). **Deployed:**
compose runs #284 at `0067` (redeployed 2026-10-20 ~20:25 UTC; no migration since the 19:50 UTC
backup `traders-compose-20261020T195058Z.dump`; both /readyz ok, `telegram.poller_started`
logged). kind is untouched at `0059`. **Telegram ask mode checked live 2026-10-21 05:11-05:12 UTC**
(item 1 below): two Hebrew questions from the phone, two Hebrew answers. **Next:**
"Next session: after the guide fix".

Previous update, 2026-10-20 ~17:45 UTC - **Handoff: improvements items 1-3 are done and deployed, and
the own key was checked live.** This PR (D211: own-key spend is limited on OpenRouter's side, one
sentence on the key card) is the **fifth merge since handoff #274** (#275, #276, #277, #278,
this) - so it is also the handoff. Decisions reached **211** (next: **212**). Migrations:
**`0065_own_llm_keys` is head** (next free: **`0066`**; `git fetch` and check `main` has one head
before writing one). **Deployed:** compose runs #278 at `0065` (redeployed 2026-10-20 ~14:00 UTC
after a backup, `~/Backups/traders/compose/traders-compose-20261020T135449Z.dump`; both /readyz
checks ok). Compose's `.env` holds a generated `LLM_KEY_ENCRYPTION_KEYS` (one Fernet key); the
value it replaced was not a Fernet key and the AI service refused to start on it, as D208 intends.
This PR is web copy only and undeployed. kind is untouched at `0059`. **Live check, 2026-10-20
~17:16-17:27 UTC:** the non-admin user `f36b1a45` saved a real key (ending 13e4) and made 17
calls - 3 Ask questions, a mandate check, a manual scan of a new agent "George" that ended `trade`
- every one `paid_by = 'own_key'` ($0.0094), none on the installation, and Settings said the
monthly limit does not apply. Two things it turned up are under "Next session: after the own-key
check". **Next:** that section.

Previous update, 2026-10-20 ~17:00 UTC - **Handoff at the end of improvements item 3: the monthly cap
(#277) is merged and live on compose; the user's own OpenRouter key (PR 3b, D206-D210, `0065`)
is this handoff's PR.** Merges since handoff #274: #275, #276, #277 - three; this PR is the
fourth. Decisions reached **210** (next: **211**). Migrations: **`0065_own_llm_keys` is head once
this PR merges** (next free: **`0066`**). **Deployed:** compose runs `main` at `0064_monthly_cap`
(read 2026-10-20 ~16:30 UTC) - so **D186 holds again: signup is live with the cap enforced**;
kind is untouched at `0059`. **PR 3b is undeployed:** before its redeploy, compose's `.env` needs
`LLM_KEY_ENCRYPTION_KEYS` (one Fernet key; generator in `.env.example`) or the feature stays off.
`0065` was rehearsed on the 12:55 UTC compose backup (at `0062`) in a throwaway container: up to
`0065` clean (403 calls -> `installation`), an own-key call did not move the cap's sum, the
downgrade refuses while own-key rows exist and steps once cleared. **Next:** "Next session: after
the own key" under "Where to go next".

Previous update, 2026-10-20 ~09:30 UTC - **Handoff after seven merges since #266 (late: two sessions
were merging in parallel, and the count was only noticed at the seventh).** Merged: #265 (D189),
#267 (D190-D193), #268 (D194), #269 (`0060`, D195-D196), #270 (`0061`, D197-D198), #272, and
**#271: the first PR of the user's 2026-10-20 improvements list.** Decisions reached **210** (next:
**211**; D199-D201 are PR 2, the active-only agent limit, #275; D202 its 50-agent ceiling, #276;
D203-D205 PR 3a, the monthly cap, #277; D206-D210 PR 3b, the user's own key). Migrations:
**`0065_own_llm_keys` is head once PR 3b merges** (next free: **`0066`**; `git fetch` and check `main` has one head before writing one). **Deployed:** compose runs `main` as of #272 (`0061`,
rebuilt 2026-10-20 08:56 UTC, before #271) - **which means #264's signup is live on compose without
the cap, against D186**; kind runs #263 at `0059`. Nobody in this session redeployed; ask the user
whether that was intended (item 1 under "after the UI batch").
**Next:** "Next session: after the UI batch" under "Where to go next".

Addendum from the parallel session, 2026-10-20 ~09:30 UTC - **its four merges (#268, #269, #270,
#272): agents got their controls - four tabs, scans every N hours, several decisions a scan.**
**Who redeployed:** this session did - compose's 08:56 UTC rebuild is its #272 redeploy, the third
that day, each on the user's word and after a backup when a migration ran. **D186 is broken on compose:** it already ran past #264 (signup) before this session
began - its AI service had #265's code at the start - and today one user signed up and was
approved (`users`: admin, one `active` user with a cap stored, one `rejected`). That user's
`llm_cap_micro_usd` is checked by nothing; the bound is D186's ~$2/day of per-agent and assistant
allowances. kind still runs `796cf3d` at `0059`. **#271** (another session: password eye toggle,
agent Performance tab, Settings sign-in card) is merged and not deployed. This session:
- **Telegram trade approval tested live** (2026-10-19 19:49-19:51 UTC): a hand-made "buy 1 AAPL"
  proposal for Test agent (its scan row's briefing says `hand-made test scan for Telegram
  buttons`), Approve -> Confirm from the phone, filled at 342.80 + 7.50. The first live proof of the
  Telegram leg; refusals still untested live.
- **#268 (D194):** an agent's page is Holdings / Activity / Scans / Settings.
- **#269 (D195, D196, 0060):** schedule = every 1-6 h in market hours + pre-open + post-close, any
  combination or none; Run a scan now waits for a running scan and names one due in 30 min.
- **#270 (D197, D198, 0061):** up to 10 trades a scan, each its own proposal (sells reviewed first;
  a buy may name the sell that funds it); the briefing lists waiting proposals and a repeat is
  refused; `trade_review.py` is the new cumulative check.
- **#272:** old one-trade scans read right in the new history.
**Its next steps are notes under the user's list, not a second order:** "Addendum: after the
agent controls" under "Where to go next".

Earlier update, 2026-10-19 ~17:00 UTC - **Handoff after five merges since #259: M9 has login (#260) and
signup with the admin's approval (#264); the next M9 PR is the cap's enforcement.** Decisions
reached **193** (next: **194**; D189 figures retry #265, D190-D193 taxonomy names in Hebrew). Migrations: **`0059_mandate_check` is head** (next free: **`0060`**;
`git fetch` and check `main` has one head before writing one). **Deployed:** compose and kind both
run `796cf3d` (#263) at `0059`. **#264 is merged and undeployed, and must stay so until the cap PR
is merged (D186)** - redeploy only on the user's "redeploy". This stretch:
- **#260 (D179-D182):** email + password login (argon2id), `session_version` checked on every
  request, the admin's `admin:password` script; `APP_PASSPHRASE` retired.
- **#261 (D183):** the contradiction check names a sentence by number; the server quotes it.
- **#262:** the agents form's fixes from its first browser walk; Change email on Settings.
- **#263:** every agent's prompt says what a trade costs (D6, D76), from the ledger's constants.
- **#264 (D184-D188):** ask to join (one answer for every email, "closed" at the waiting limit);
  the admin's Telegram message (default cap, Custom budget = $5/$20/$50 + Admin link, Reject) and
  the Admin page's requests card, settings and count; conditional transitions instead of nonces;
  `account_pending` at sign-in. Walked end to end in the browser on `traders-agents-ci`; Telegram
  covered by tests only (no bot token in the preview).
**Next:** "Next session: after M9's signup" under "Where to go next".

Earlier update, 2026-10-19 ~08:00 UTC - **Handoff: the agent template creator is complete (#252, #254,
#257, #258).** Decisions reached **188** (next: **189**; 179-188 since this header: login, D183, signup). Migrations: **`0059_mandate_check` is head**
(next free: **`0060`**) - **before writing a migration, `git fetch` and check `main` has one head**:
two sessions merging 40 s apart left two 0057s (#253/#254, fixed by #255). **Deployed nowhere past
0055:** both environments run `a7c3c96`; #232 and #249-#258 are merged and undeployed - redeploy only
on the user's "redeploy" (0056-0059 run then; the startup loader then fills `universe_taxonomy`).
The template creator, designed one question at a time with the user (decisions 164-178):
- **#252 (0056, D164):** `universe_taxonomy` - industries and ETF categories the screened universe
  holds, with counts, rewritten inside every universe load (write-free when unchanged); ETF
  categories mapped onto Yahoo's 11 sectors in `app/universe/taxonomy.py` (14 mapped, 101 listed
  sectorless, contract-tested against the committed snapshot); `GET /universe/taxonomy`.
- **#254 (0057, D165-D173):** the mandate on `agents`; `app/agents/mandate.py` checks every **buy**
  (never a sell) after `price_answer` - limits in bps of **capital at cost** (D171), market-cap bands
  for equities, the sector selection, the ETF switch, the blocked list (no whitelist, D173); one
  retry with the reasons, then `rule_rejected`. The prompt states the mandate above the persona.
- **#257 (D174-D175):** the form - risk slider proposing limits, horizon, style, limits, ETFs, size,
  the Downshift "Sectors & industries" picker, blocked tickers; templates as full presets; the
  persona relabelled "Additional instructions" and **written from the settings in words, never
  figures, only while untouched**. **Settings alone are enough to scan** (one readiness rule in the
  AI service, scheduler and views; `waitingForPersona` -> `waitingForBrief`; wire code stays
  `no_persona`).
- **#258 (0059, D176-D178):** after a save whose instructions are the user's own words, one
  `mandate_check` call returns `{setting, quote}` pairs; quotes not in the text are dropped; stored
  on the agent with a fingerprint; warning + Dismiss on the agent page, a badge on the list.
- **Not verified in a browser, and no real model has run the check** - both are the first items
  under "Next session: after the template creator".
**Next:** "Next session: after the template creator" under "Where to go next" - or M9's signup and
login ("after M9's schema"), whichever the user picks.

Previous update, 2026-10-18 ~14:30 UTC - **Handoff after six merges since ea2c3a7 (#249-#254; #255 is the
seventh, the fix below).** **M9 has its decisions and its schema; the next M9 PR is signup and
login.** Decisions reached **178** (next: **179**; 174-178 came with the template creator's form #257 and its contradiction check, PR 4 with `0059_mandate_check`). Migrations: **`0059_mandate_check` is head**
(next free: **`0060`**; check `main` for a head before writing one - #253 and #254 merged 40 s apart and
left two 0057 heads). **Deployed nowhere past 0055:** both environments run `a7c3c96`; #232,
#249-#255 are merged and undeployed - redeploy only on the user's "redeploy" (0056-0058 run then).
This session:
- **M9 decisions 155-163** (#251), one question at a time with the user. The short version:
  - trusted users over Tailscale, one admin;
  - signup into `pending`, approved from Telegram or the Admin page;
  - a monthly cap per non-admin, checked before each call, with alerts on template text when capped;
  - email + argon2id;
  - a cookie with `session_version`, checked against the user on every request;
  - explicit `every_active_user` fan-out, scans interleaved, shared kinds run once;
  - the admin sees operations only, each user resets their own account, the admin can set a one-time password;
  - the zone from the browser.

  M10 (OAuth, strangers) is on the roadmap.
- **M9 schema #253, renumbered by #255 to `0058_user_accounts`.**
  - `users`: `status` defaulting to `pending`, password columns, `session_version`, and `llm_cap_micro_usd`, required for an active non-admin by `users_active_user_has_cap`.
  - Email is unique by `lower(email)`; the primary agent is seeded on activation.
  - The downgrade refuses while any user isn't active.
  - Rehearsed on the 10-18 01:00 compose backup, restored into `traders-agents-ci` (0052 -> head -> 0052 -> head, counts identical).
  - **Every new user insert must say `status = 'active'` and give a cap** - the test inserts do.
- **#255 fixed two Alembic heads on `main`**: #253 and #254 (another session, template creator
  PR 2) both merged a 0057 on 0056. See Bugs ("two green PRs, one broken main").
- **#232 is still deployed nowhere** (checked 11:05: both pods pre-#232).
- **0055 read back, and the prune question open:** the window read uses `articles_fetched_idx`.
  The market prune has been 278-937 ms on 4 of 5 collects since the deploy, probably cache
  eviction by 09:00's scratch restore. **Re-read on 2026-10-19** against the 11:07 snapshot (prune
  138 calls / 6,027 ms total; `articles` seq_scan 442), then decide on a partial index on
  `coalesce(published_at, fetched_at) WHERE feed = 'market'`. Restoring a *backup* into a separate
  container does not touch the compose server - that is how #253 was rehearsed.
**Next:** "Next session: after M9's schema" under "Where to go next".

Previous update, 2026-10-18 ~11:30 UTC - **M9 decisions 155-163 - all of M9's decisions** (users, signup
with approval, monthly spend cap, enforcement, email+password, sessions, scheduling, admin, time
zone); decisions reached **175** (next: **176**; 164-175 are the agent template creator's design, agreed the same day; PR 1 #252 (`0056`) and PR 2 #254 (`0057`) merged, PR 3 the form, PR 4 the save-time warning). Next is M9's code, PR by PR (MILESTONES). **#232 is
deployed nowhere** - checked 11:05 UTC: both environments' `instructions.py` is pre-#232 (pods
started 09:18-09:20). **0055 read back:** the window read uses `articles_fetched_idx`; the market
prune (`DELETE ... coalesce(published_at, fetched_at)`, deletes 0 rows) has been 278-937 ms on 4
of 5 collects since, likely cache eviction by 09:00's scratch restore. **Re-read on 2026-10-19**
against the 11:07 snapshot (prune calls 138 / 6,027 ms total; `articles` seq_scan 442) before
deciding a partial index on `coalesce(...) WHERE feed = 'market'`; restore nothing onto compose's
server until then.

Previous update, 2026-10-18 ~10:30 UTC - **Handoff after five merges since #242 (#243-#246, #232). One
draft is open on purpose (#247).** Decisions reached **154** (next: **155**); no migration since
`0055` (next free: `0056`). **Deployed:** both environments run `a7c3c96` (#245, revision 0055) -
**#232 is merged (`fb4547a`) but deployed nowhere**; redeploy only on the user's "redeploy". This
session:
- **#232 measured and merged.** One eval run (`--repeat 3`, the user's new budget: cap $1.50,
  spent $1.42): **166/258** graded as the baseline was (4b re-run: 143), 171 with the new link rule.
  Targeted cases: 7 of 11 improved, none worse; still 0/3: `account-cash`, `advice-yes-or-no`,
  `more-agents-vs-portfolio`, `user-news-today`. Elsewhere 15 cases gained and 9 lost; the two
  losses probably caused by the new lines: `topic-agent-traded-on-topic` (quotes the thesis and
  claims a cause the records don't show) and `account-why-sell-ura` (links `/proposals`, not the
  proposal). Prompt tokens per question 4,695 -> 5,456. Full numbers in #232's body.
- **The user's two eval-grading answers:** a link to `/agents` passes where a case expects
  `/agents/$agentId` (the 4 cases now list both); a decline must still give the expected reason
  code, because the code decides what the UI tells the user.
- **`traders-assistant-ci` is removed.** The next paid eval or local integration run needs a
  disposable `_ci` Postgres again (any name ending `_ci`/`_test`; integration tests read
  `TEST_DATABASE_URL`).
- **#247 (draft, on purpose): the agent scan's prompt.** The user brought a full rewrite of the
  scan prompt; it was reviewed against the code and not adopted. It dropped the thesis language
  (D51), the step limit and "doing nothing is the most common answer"; it named a tool that does
  not exist (`lookup_share_price`); and it asked the model to check cash by arithmetic it is told
  never to do, against a fee the briefing never showed. What #247 does instead: each briefing mover
  carries `affordable_shares` (`fees.affordable_shares`, fee included), and four prompt lines
  (search_universe first and ETFs count; never trade an unpriced quote, say when no news explains a
  move; size at or below `affordable_shares`; rules beat the persona; a `none` names its reason).
  **Merge only after the 2026-10-20 Test agent scan review**, which is its baseline.
**Next:** "Next session: after #232" under "Where to go next".

Previous update, 2026-10-18 ~09:00 UTC - **DB4's second half is reviewed: decisions 151-154, three migration
PRs in order** (0053 drop the profiles' HNSW index, 0054 drop two unread indexes, 0055 an `articles`
index for the collector's window read). See "The database sprint's review, second half" for the
week's numbers. Decisions reached **154** (next: **155**). #243 (0053), #244 (0054) and
#245 (0055) merged. **Deployed 2026-10-18 ~09:15 UTC: both environments run `a7c3c96` (#245) at
revision 0055** - this also deployed #241 ("Evidence checked"). Measured after: `instrument_profiles`
97 -> 54 MB on both, compose `articles` 65 -> 59 MB, kind's database 117 -> 75 MB. **The 0053-0055 index changes
have not been read back from the statistics yet** - the next report should show `articles_fetched_idx`
scanned ~48 times a day on compose and `articles`' `seq_scan` no longer climbing per collect. Kind
keeps 20 `Error` Job pods from 2026-10-10/11 (8d/7d old), predating this deploy; not investigated. Nothing below changed otherwise.

Previous update, 2026-10-18 ~08:00 UTC - **Handoff after six merges (#236-#241) - one past the five-merge
trigger, noticed late. One draft is still open on purpose (#232).** No migration since `0052` (next
free: `0053`); decisions reached **150** (next: **151**). **Deployed:** compose and kind both run
`8d42fdf` (#239) - **#241 is merged but deployed nowhere**; redeploy only on the user's "redeploy".
What happened, in order:
- **#236** - M9 (multiple users) added to the plan (MILESTONES, PRD §7). Docs only.
- **#237 (decision 148)** - a move and a drawdown on one holding from one scan are one Telegram
  message, merged at the fan-out (`services/holdingAlerts.ts`); each half keeps its own row and
  dedupe key. Not yet seen on the real bot.
- **#238 (decision 149)** - a move alert carries a market line: the best-fitting index (highest R²
  over 90 days among SPY/QQQ/IWM, BTC-USD for crypto) when it moved >=1% the same way. Framed, never
  muted - a beta-adjusted mute would have silenced OUST -9.51%, EOSE -15%, IREN -12% on 10-14.
  **The web feed and the digest do not show the line yet** (evidence is stored for them).
- **#240 (M9 PR 1)** - `docs/M9-MEASUREMENT.md`: the data layer is already tenant-safe; what assumes
  one user is the schedule (never names a user), installation-wide kinds run as a user's run, one
  `LLM_DAILY_BUDGET_USD`, `users.timezone` unwritable, user delete blocked by 7 FKs, irrevocable
  cookie, self-reset behind the admin gate.
- **#239 (decision 150)** - a failed `backfill` is re-claimable the same day (`RETRY_FAILED_KINDS`);
  compose had 3 of 25 fail on the first ask after the Mac woke.
- **#241** - "Evidence checked" on an agent's trade proposal (web card + Telegram): the scan's tool
  calls, derived at read time from `agent_scans.transcript` (`SCAN_TOOL_CALLS`), no migration.
  Unknown tool names are counted, never named - a future research sub-agent shows as "1 other tool".
  Checked on fixtures only (no real proposal existed locally).
**Next:** "Next session: after #241" under "Where to go next".

Previous update, 2026-10-14 ~15:00 UTC - **Handoff after five merges (#229, #230, #231, #233, #234). One draft
is open on purpose (#232).** Both environments run `main` at `6248524`, no migration since `0052`
(next free: `0053`; decisions reached 147). What happened, in order:
- **Redeploy + PR 5's live check:** `/ask` answered first time on the `openai` package. **Narration had
  failed on every call since 2026-10-07**: OpenRouter began refusing `reasoning: {effort: "none"}`
  ("Reasoning is mandatory for this endpoint") - Sonnet 5.5 from 10-09, Flash-Lite from 10-13. Not PR
  5 (the old client got the same 400). **#229:** `NO_REASONING="none"` -> `LEAST_REASONING="minimal"`
  (measured: 0 reasoning tokens on both models, the same as "none" gave).
- **#230:** the first narration after #229 wrote CIFR's -12.8% as "-0.1276923076923077 percent" (the
  stored ratio, a hundredfold too small) and the validator passed it - its percent rule saw only `%`.
  Now the word counts (percent / per cent / percentage / אחוז), for narration, the assistant and the
  agents' theses alike, and the prompt shows ratios as percentages (`"-12.77%"`) by the validator's
  own `is_ratio_key`. Live: 3/3 then wrote 12.77%.
- **The 4b eval re-run:** 143/258 turns (PR 4: 132), mechanical 201 (210), judge 161 (152), $1.28.
  Report: `services/ai/eval-results/assistant-google_gemini-3.5-flash-lite-20261014T121135.*` (main
  checkout, gitignored). **#231 (4c, the tested half):** Gemini's `MALFORMED_FUNCTION_CALL` (a 200
  with `finish_reason: "error"`, zero usage - 12 of the "no completion text" turns) is retried once;
  `get_portfolio`'s snapshot says what its total leaves out (`total_covers`; `edge-unpriced` was 0/3);
  `get_price_history` reports `trading_days`; the eval reads a judge verdict whose JSON broke after
  it decided. **#232 (the prompt half) is a DRAFT on purpose** - see "Next session" below.
- **#233:** task 19's after-measurement (closed: 0 repeated drawdown rows, 0 merged-move overlaps) and
  the scheduled scans' review (measured nothing: compose's one agent had no money).
- **The user gave "Test agent" (compose, `pre_open`) $10,000 paper** via the top-up route (it is its
  `opening_deposit`), so Flash-Lite's trading can be measured; a one-time scheduled task
  `traders-test-agent-scan-review` reviews its scans read-only on **2026-10-20 10:00 Israel**.
- **#234:** the narration watch now announces a *first* state that is already a break (decision 58
  amended) - the week-long outage had become the watch's silent baseline.
**Eval spend:** ~$4.82 of the user's $5 (this session $1.42); #232's run needs a new budget.
**`traders-assistant-ci` (127.0.0.1:55435) is kept on purpose** until #232 is measured (the user).

Previous update, 2026-10-14 ~12:00 UTC - **Assistant milestone handoff: every planned PR is merged (#225 PR 4,
#226 PR 4b, #227 PR 5). Nothing is in flight.** The trigger is the milestone boundary (CLAUDE.md).
**Owed, in order:** (1) **redeploy** - this session (a cloud container) deployed nothing, so both
environments still run what the last session left (`1d7d754` per the update below, unless the user
redeployed since: check with `git -C <checkout> log -1` against `origin/main` = `36f9ff2`); no
migration since `0052`. (2) **The live check of PR 5:** one narration and one `/ask` question after
deploy - the `openai` package has never spoken to OpenRouter from this code. (3) **The 4b eval
re-run** (paid, the user's machine, ~$1.30, cap $1.60 - command under "Next session: the assistant's
PR 4b"); compare with PR 4's 132/258. (4) Then remove the disposable `traders-assistant-ci` container
on the Mac (`docker rm -f traders-assistant-ci`) - the eval needs it until (3) is done. **Next work:**
"Next session: after the assistant milestone" below. **Cloud-session note:** a container session can
run the whole suite - `dockerd &` then a `pgvector/pgvector:pg16` container for
`TEST_DATABASE_URL`; the daemon does not survive an idle container, so restart it if integration tests
suddenly all error with "connection refused".

Previous update, 2026-10-14 - **Assistant PR 5: the `openai` package for chat and embeddings together.** Both
clients (`app/llm/openai_compatible.py`, `app/corpus/openrouter_embedder.py`) now send through
`AsyncOpenAI` pointed at the configured base URL; their constructors, and so `factory.py` and every
call site, are unchanged (guideline 6), and every existing test passed unchanged. **Kept ours, on
purpose:** the retry policy (the package's `max_retries=0`: it would retry timeouts and wait out a
Retry-After of up to a minute; ours retries 429/5xx once, never a timeout, and caps the wait at 10 s),
reasoning sent as OpenRouter spells it (`extra_body`), prompt caching, pricing, and every check on a
reply or a vector - the package validates nothing (a non-JSON 200 comes back as a string; a malformed
embeddings body parses). `encoding_format="float"` is sent: unset, the package asks for base64. **A
keyless gateway (Ollama) sends `Bearer keyless`**: the package refuses to build a client without a key
and would otherwise read `OPENAI_API_KEY` from the environment. The debt row "hand-written over `httpx`"
is removed. **Not run against the live API** by this session (no key): the first narration or `/ask`
question after deploy is the check. The assistant milestone's planned PRs are all built; the 4b eval
re-run is still owed.

Previous update, 2026-10-14 - **Assistant PR 4b: the eval's findings, built; the paid re-run is owed.** Tool gaps
closed: `get_agents` has each agent's `next_scan` (in the user's zone) and `month_to_date`;
`get_portfolio` has today's change in money (`today`, per holding `day_change`), `delayed_minutes`, and
a `cash_note` saying the real portfolio keeps no cash; `get_price_history`'s `days` are **trading days**
(the agents' too). The prompt now says: a price's time and delay, a proposal's state, news sources, a
replayed scan's conclusion, and "how was the universe made?" is `get_universe_info`. The assistant's
figure check accepts a date written in words ("12 October", "Oct 12, 2026") when the evidence states it.
**Not yet measured on a model** - this session had no key; run PR 4's command (below) against PR 4's
numbers before calling 4b done. Then PR 5 (`openai` package). No migration.

Previous update, 2026-10-12 ~13:30 UTC - **Assistant PR 4: the eval runner, the measured limit, the old `/ask`
removed.** `scripts/run_assistant_eval.py` runs `data/eval/assistant.json` on a real model in a seeded,
disposable world and grades each turn mechanically and by a Sonnet 5.5 judge (the user's choice: model
judge + the user reads failures and disagreements). **Flash-Lite won** (51% of turns pass over 3
samples, $0.0019 a question, 2 s; Haiku 4.5: 40%, $0.0123, 10 s). **The $0.50/day limit stays - now
measured** (~160 questions at the p90 cost). The old `POST /ask`, `app/ask/` (relevance moved to
`app/corpus/relevance.py`), `data/eval/ask.json` and both its CI jobs are gone. **Next: PR 4b - the
eval's findings** (see "Next session: the assistant's PR 4b"), then PR 5 (`openai` package). Eval
budget the user gave: $5, ~$3.40 spent. No migration.

Previous update, 2026-10-12 ~11:45 UTC - **Assistant handoff (five merged PRs: #212, #220-#223). The assistant
is live on `/ask`. Nothing is in flight.** #212 - the 80-case test set (`data/eval/assistant.json`,
written before the assistant, 11 cases in the user's words). #220 - the AI service core: the shared
tool loop (the scan uses it), 14 read-only tools, checked replies, conversations, migration
**0052**. #221 - the Admin `assistant` model picker and per-user daily limit, the orchestrator's
`/assistant/*`. #222 - `replay_scan` and `get_universe_info`, and the fixes a real model forced.
#223 - the `/ask` chat screen (`react-markdown`), history, 90-day retention. **Both environments
run `main` at `1d7d754`, migration `0052_assistant`**, redeployed by this session. **The user has
not yet chosen the assistant's model on the Admin page** - until they do it runs on the free route
(90 s, fails its checks); Flash-Lite was recommended (~5 s, ~$0.003 a question, measured on copies).
**Next: assistant PR 4** - see "Next session: the assistant's PR 4". Merges used `gh pr merge
--squash --admin --subject "<title> (#N)"` on the user's "merge"; auto mode's classifier refused
the `--admin` merge until the user left auto mode. A disposable Postgres container
`traders-assistant-ci` (127.0.0.1:55435, `traders_ci`) was left running for integration tests -
remove it when the milestone ends (`docker rm -f traders-assistant-ci`).

Previous update, 2026-10-11 ~13:59 UTC - **Insights handoff: queue tasks 19-21 complete (#206, #209, #214,
fix #216). Nothing is in flight.** #206 - drawdown and drift written once per band per episode
(`finding_episodes`, migration **0049**), `price_move` dropped where `sigma_move` fired (decision
132). #209 - Insights tabs Alerts / Proposals / Digest / All findings, Alerts with source pills
(decision 134). #214 - All findings opens on today and steps back 7 days, unread dot and highlight
(`insights_seen_at`, migration **0051**, decision 133). **#214 first shipped its migration as 0050
and collided with DB3's `0050_query_statistics` (#213): two heads on `main`, both deploys stopped,
compose was down ~35 min and kind's crons failed ~15 min (Sunday morning, market closed; runs
caught up).** #216 renumbered it; lesson under "Bugs". **Both environments run `main` at
`49d43d7` (DB4's #218/#219 included, deployed by the database sprint's session), migration
`0051_insights_seen`**. **Due:** task 19's after-measurement
on kind after Monday 2026-10-12's scans - see "Next session: after the Insights work".
**Other sessions at this handoff:** DB4's first half merged and deployed (**#218**, the `runs` claim
predicate; **#219**, decisions 143-147 - its status is the previous update below). A worktree,
`ask-agent-plan-4a141f`, is on a branch `claude/assistant-build` with no commits yet.

Previous update, 2026-10-11 ~09:00 UTC - **DB4, first half (decisions 143-147).** The user asked for the
review a week early; the window was 29 minutes, so DB4 was split (decision 143): what code reading
settles was decided now - `runs`' full scans are `IS NOT DISTINCT FROM` and **#218** rewrites it
(decision 144), `db-report.sh` reads `reltuples` (145), `traders_m5` is dropped by the user (146),
no off-laptop copy, by choice (147). **Index drops and `runs` retention are read on or after
2026-10-18** - see "Next session: the database sprint's review". Both environments run `main` at
`2696fbf` (#216 renumbered Insights' migration to **0051**). Backups: launchd's last exit 0, both
dumps under an hour old at 08:25 UTC.

Previous update, 2026-10-11 ~08:00 UTC - **Database sprint handoff (five merged PRs: #207, #208, #210,
#211, #213). Nothing is in flight.** DB1 backups (#208; launchd schedule installed, daily 04:00
local), DB2 the loader writes only changed rows (#210; `instrument_profiles` reclaimed 155 -> 96 MB
on both), DB3 query statistics (#213, migration **0050**). **Both environments run `main` at
`0232a21`, migration `0050_query_statistics`**, redeployed by this session at the user's request.
**The measurement window opened 2026-10-11 07:56 UTC** (`db-report.sh --reset` on both): **DB4,
the review, is due on or after 2026-10-18** - see "Next session: the database sprint's review".
**No backup leaves the laptop** (no Time Machine destination, no synced folder; the user knows).
Merges this session used `gh pr merge --squash --admin --subject "<title> (#N)"` on the user's
"merge" per PR.

Previous update, 2026-10-08 ~19:45 UTC - **Two debt fixes merged and deployed; the user stopped the session.
Nothing is in flight.** **#202** - `lexicon-v2` reads present-tense headlines ("Sinks",
"Plummets"); `scripts/rescore_sentiment.py` was run once on compose (27,678 articles; kind has
none). **#203** - the Admin model picker shows "Not chosen - using <model>" instead of the first
model. Both environments run `main` at `012d72b`, migration still `0048`. **Open, and the user's
to do:** D75's Admin choice of Sonnet for *explain* (narration and `/ask`) was still unsaved at
19:40 UTC - `llm_model_choices` held only the `agent` row, so narration was still on the free route;
check the table before assuming either way. **IBI is gated (decision 135): no IBI work at all -
not even the Excel mapper - until the MCP probe shows our app can connect.** Next session: see
"Next session: after the debt fixes".

Previous handoff, 2026-10-08 ~18:45 UTC - **Multi-agent Stage 4 is complete: agents decide on their own
schedule. Handoff at the stage boundary. Nothing is in flight.** Merged and deployed this session,
in order: **#186** (PR 5b: trade proposals announced past the floor, Telegram Approve -> preview ->
Confirm with the price signed in the button, pending trades in the consolidated view; D60-D63),
**#188** (PR 6: the *Decisions* tab, *Run a scan now*, schedule and model budget on Settings;
D64-D66), **#197** (PR 7a: at most 3 simulated agents per user, set on the Admin page; migration
**0047**; D72), **#199** (PR 7b: scheduled scans on a BullMQ queue, slots from the exchange
calendar, bounded retries, one give-up alert; migration **0048**; D68-D71, D73, D74). Another
session merged the UI/UX sprint (#189-#196) and #190 in the middle of it - see the paragraph below.
**Both environments run `main` at `e736ffc`, migration `0048_agent_scan_runs`**, deployed by this
session at the user's request (`git pull && bash scripts/dev-docker.sh && bash scripts/k8s-up.sh`
in the main checkout). **Scheduled scans are ON in compose** (`ENABLE_SCHEDULED_SCANS=true` added to
the user's `.env`, with their yes) **and off in kind** (`config.env`). The first one ran at 18:29 UTC
on 2026-10-08, catching up that day's pre-open slot: `invalid_answer` ("figures not in the evidence:
1,923"), $0.026, no retry by design. The next is each trading day at 09:00 New York (16:00 Israel).
**GitHub:** the repository is now **public** (the user's answer to the Actions billing block; CI is
free); the ruleset "protect main" covers every branch, so merges use `gh pr merge --squash --admin
--subject "<title> (#N)"` - `--subject`, because a squash otherwise takes the *first commit's*
message (#197's title on `main` reads "wip: PR 7a before merging main"). The user says "merge" (or
"merge and redeploy") per PR. **First thing next session: task 17** (narration re-measurement, due
since 2026-10-08 10:15 UTC) - see "Next session: after Stage 4". **Form, unchanged:** one question at
a time with a recommendation (AskUserQuestion); the user questions side effects before agreeing and
wants them stated plainly (PR 7's plan was re-cut twice on their questions: retries bounded,
one installation schedules, a real queue).

Previous handoff, 2026-10-08 ~11:45 UTC - **The UI/UX sprint is complete: UX1-UX6 merged as #189, #191,
#192, #193, #194, #195. Handoff by count (five merged PRs) and at the sprint's end. Nothing is in
flight.** What it built is under "The UI/UX sprint is complete" in "Where to go next"; the argued
choices are decisions 119-123. **Neither environment is redeployed:** compose and kind both run
migration **0045** - UX4's **0046** (`user_settings.digest_seen_at`) and every UI change since #185
wait for `git pull && bash scripts/dev-docker.sh && bash scripts/k8s-up.sh`. After that deploy, the
digest sent 2026-10-08 08:42 UTC shows its banner once, by design (0046 has no default). **Merged by
other sessions since the last handoff:** #185 (task 18, reset account, 0045), #186 (Stage 4 PR 5b,
Telegram trade approval, D60-D63), #188 (Stage 4 PR 6, the Decisions tab and Run a scan, D64-D66),
#190 (D67: read-only broker sync is in scope; plan in `docs/PROPOSAL-IBI-SYNC.md`, its migration
renumbered to **0047** in this handoff because UX4 took 0046). The "Next session: Stage 4 PR 5b"
heading below predates #186 and #188; read `docs/PROPOSAL-MULTI-AGENT.md` for where Stage 4 stands.
**Two things about GitHub that cost time today:** (1) a repository ruleset, **"protect main"**
(created 2026-10-08), restricts updates on *every* branch to the admin role, so `gh pr merge`
is refused with green CI ("base branch policy prohibits the merge") - the user says **"admin
merge"** per PR and the merge uses `--admin`; GitHub auto-merge is off for the repo. (2) That
morning GitHub Actions refused every job in 2 s ("recent account payments have failed") - six red
checks that ran nothing; the user fixed billing and a rerun went through. **Form, unchanged:** one
question at a time with a recommendation (AskUserQuestion); the session runs on the user's Mac and
reads compose's DB itself; the user's Chrome is signed in to localhost (cookies are per host, not
per port, so a worktree's dev server on :5175 shares the session).

Previous handoff, 2026-10-07 ~15:00 UTC - **Multi-agent Stage 4: the agent proposes and the user approves.
Handoff at the user's request after two merged PRs (#182, #183; not a count trigger). Nothing is in
flight. The next session builds PR 5b - Telegram's Approve/Confirm and the consolidated view's
pending proposals** - see "Next session: Stage 4 PR 5b". Merged this session: **#182** (PR 5a,
migration **0044**: a `trade` scan becomes a `buy`/`sell` proposal; Approve = preview at the live
price, refused beyond 300 bps of the agent's; Confirm fills through `executeFill` in the approval's
transaction; refused attempts recorded; D55-D58), **#183** (news on demand from Yahoo via
`yfinance.Search`, hourly per symbol, D59). **Both environments run `main` as of #182, with
0044** - the user redeployed after #182 and verified by grep; **#183 (`a25ed1b`) is not yet
redeployed** (`git pull && bash scripts/dev-docker.sh && bash scripts/k8s-up.sh`; no migration).
**The account is funded** ($10, 2026-10-07): agents' model = Sonnet 5.5 (chosen on Admin);
narration deliberately still on the free route so task 17 measures it. **Real scans cost $0.036 on
average** (§14.3), a tenth of §14.1's guess. **Proven live on a copy:** a real scan proposed buy 2
NVDA, Approve previewed at $238.68, Confirm filled, cash 10,000.00 -> 9,521.14, a repeated Confirm
returned the same fill. A "Test agent" (cautious large-cap persona, $10,000) exists on compose.
**This session ran in the desktop app on the user's Mac**, so it read compose and kind directly
(`docker exec traders-postgres-1 ...`, `kubectl -n traders exec postgres-0 -- ...`) and ran every
rehearsal itself - the user prefers that to pasting. **The auto-mode safety classifier went
silent ("no verdict") for every command for a stretch**; the user merged #182 on GitHub and
verified by grep. **Form the user asked for, unchanged:** one question at a time, short, with a
recommendation (AskUserQuestion works well); explain plainly; the user says "merge" per PR.

Previous handoff, 2026-10-07 ~10:15 UTC - **Multi-agent Stage 4 is four PRs in: the agent can scan, and
proposes nothing yet. This is a handoff by count (#172, #173, #177, #178, #179, #180 merged since
#169), not at a stage boundary. Nothing is in flight. The next session builds Stage 4 PR 5 - the
trade proposal and its approval** - see "Next session: Stage 4 PR 5". Merged this session (one
cloud session took over a CLI session that hit its usage limit mid-PR 3): #177 the scan's inputs
(0042; tool calling, Yahoo movers, seven read-only tools, the briefing - its tests found money
reaching the model as "1E+3"); #178 planning notes; #179 narration fixes (task 17: thresholds read
as ratios, money shown as decimals, "0.03%" for 3% refused); #180 the scan (0043, D53, D54). **Both
environments:** the user redeployed after #177 (the live DB was at `0042` when 0043 was rehearsed);
**#179 and #180 are not yet deployed** - `git pull && bash scripts/dev-docker.sh && bash
scripts/k8s-up.sh` on the Mac. **The model account is still unfunded** (OpenRouter free tier, $0):
real scans and their cost are unmeasured, and that measurement comes before PR 5 is merged.
**Decided with the user this session, each recorded below:** plain Python and no agent framework for
every model call (D53; the assistant milestone moves the client to the `openai` package); CLAUDE.md
convention 5 - **ask before hand-writing what a package already does**; the assistant milestone
(`/ask` with tools); tasks 16 (scan frequency on the Admin page), 17 (narration re-measurement only)
and 18 (reset account, by group); a research agent as a tool, measured before it is built. **The
grant continues** for Stage 4: the user says "merge" per PR; verify on `main` by content; the user
redeploys on the Mac; every migration rehearsed on a live copy - the user runs the rehearsal block
on the Mac (cloud sessions cannot reach it) and pastes the output. **Form the user asked for:** one
question at a time, short, with a recommendation; explain from first principles when asked "why".

Previous handoff, 2026-10-05 ~17:30 UTC - **Multi-agent Stage 3 is half done: five PRs merged (#161-#165),
which is CLAUDE.md's handoff trigger; this is that handoff (#166). Nothing is in flight. The next
session continues Stage 3 with PR 6 (the consolidated holdings view) and PR 7 (performance against
a shadow SPY, and the 30/60/90 score)** - see "Next session: multi-agent Stage 3, continued". The
user answered every open question before each PR (D21-D31, all recommendations except the calendar,
which they re-cut). Built: #161 spec (D21-D26, §13 measurements and tasks); #162 the exchange
calendar (`data/calendar/xnys.json` from our own NYSE-rules generator, `GET /market/calendar`);
#163 the ledger, migration **0040** (`agent_cash`, `cash_movements`, `fills`, every invariant a
trigger); #164 manual trades (`services/fills.ts` - the one fill path, preview then confirm,
D27-D30); #165 the agent page (account, Trade panel, Activity timeline, Add cash; en/he, D31).
Both environments run `main` at `793a4c3`, migration `0040_ledger`; neither holds a simulated agent
yet - the user can now create one at `/agents` and trade into it. **The grant continues** (PR, merge
when the user says "merge" - they have said it per PR all session - verify by content, redeploy;
every migration rehearsed on a live copy).

Previous handoff, 2026-10-05 ~15:30 UTC - **Multi-agent Stage 2 (agent management) is complete (#158-#159),
and Mastra is retired (#157); this is the Stage 2 handoff (#160). Nothing is in flight. The next
session starts Stage 3** - see "Next session: multi-agent Stage 3" in "Where to go next". Stage 2 as
the user re-cut it (D17-D20, asked and answered 2026-10-05): **management only** - `/agents` API and
an Agents page, a page per agent with settings, persona, pause/resume/archive/restore, and Holdings /
Activity tabs that are empty until Stage 3/4; the consolidated holdings view moved to Stage 3. Both
environments run `main` at `600b116`, migration `0039_retire_mastra`.

Previous handoff, 2026-10-05 ~10:30 UTC - **Multi-agent Stage 1 (isolation) is complete (#151-#155); this
is its closing handoff (#156). Nothing is in flight. The next session starts Stage 2** - see "Next
session: multi-agent Stage 2" in "Where to go next". **The grant continues across the feature's
stages** (the user, 2026-10-04: PR, merge on green, verify on `main` by content, rebuild compose and
kind; **every migration rehearsed on a copy of the live database first, strictly**); ask again only
if the work leaves the feature. Read `docs/PROPOSAL-MULTI-AGENT.md` §10-§12 before anything: its
decisions D1-D16 are the user's, argued in a long planning conversation, and they **override** the
spec's earlier sections where they disagree. The ones that change what gets built:
- **D14-D16: the agent decides by persona + tools (an LLM, non-deterministic); the code enforces
  limits only.** No deterministic strategies: Stage 2 = agents exist and decide nothing; Stage 3 =
  the ledger (cash, fees, fills, approval, scoring) proven with *manual* trades; Stage 4 = the
  deciding agent (a code-built briefing, then read-only tools the model picks, step limit 12, the
  transcript stored as the decision log).
- **D1: "Main portfolio" (the primary agent, the real imported portfolio) is passive** - never a
  trade proposal; `rebalance` (an acknowledgement) stays. Three layers now enforce it (#155).
- **D11: Mastra is retired** (reverses decision 11; done 2026-10-05, migration 0039 - the
  `proposals` row, `applyDecision` and `proposal_sweep` are the whole lifecycle); **D10: Stage 4
  builds one scan both as a hand-written loop and as core-only LangGraph, keeps the smaller; no
  checkpointer either way.**
- The user is learning; when they ask in Hebrew, explain in Hebrew, from first principles.
Stage 1 as built: #151 the spec amendment (D1-D16, measurements, Stage 1 tasks); #152 migration
0036 (`agents`, a primary per user by trigger, `agent_id` on nine tables, expand); #153 every read
agent-scoped + `test/agentScopeContract.test.ts`; #154 migration 0037 (per-user uniques dropped,
`ON CONFLICT` per agent); #155 migration 0038 (the passive-primary trigger). Each migration was
rehearsed on a copy of the live database (counts, downgrade, then this branch's orchestrator running
a snapshot and a scan against the copy) before merge. Compose and kind run `main` with migration
`0038` (deployed and checked 2026-10-05) - check `alembic_version` before assuming it still is.

Previous handoff, 2026-10-04 ~08:45 UTC - **Hebrew for server-generated text is complete (#147-#148); this
is its closing handoff (#149). Nothing is in flight. The next session starts by asking the user what
comes next** - see "Next session: after Hebrew server text" in "Where to go next". The user chose
this over the multi-agent sandbox because **the sandbox "is much bigger and should involve some
planning on our side"** - so it starts as a planning conversation, not as a measurement-then-PR.
This session (grant: PR, merge on green, verify on `main` by content, rebuild compose and kind -
**it ends here; ask again**) measured first, brought four decisions (all accepted), then built:
- #147 (decision 98): migration 0035 `observations.localized` jsonb, the Hebrew templates
  (`app/narration/hebrew_templates.py`), rendered when an observation is written and backfilled
  for the 78 live rows; the web picks the page language's text (`lib/observationText.ts`);
- #148 (decision 99): Telegram and the digest in `user_settings.language` through a typed
  catalogue, `apps/orchestrator/src/notify/messages.ts`.
Both environments run `main` at `42e927e`, migration `0035_observation_localized`. **The live
account's language is `he`** - the user switched it. A startup warning seen while rebuilding,
`proposal.lifecycle_close_failed` / "permission denied for schema mastra", turned out to be a real
outage of the proposal workflow since 0033 - fixed in #150 (see the first entry under "Bugs that
cost real time").

Previous handoff, 2026-10-02 ~06:45 UTC - **Hebrew and RTL is complete (#142-#144); this is its closing
handoff. Nothing is in flight. The next session starts by asking the user what comes next** - see
"Next session: after Hebrew" in "Where to go next". This session (grant: PR, merge on green, verify
on `main` by content, rebuild compose and kind - **it ends here; ask again**) measured first,
brought four decisions (all accepted; the library changed once, on the user's question), then built
three slices:
- #142 (decision 94): the layout in logical directions - 120 physical Tailwind classes converted,
  a test that refuses them, back arrows mirrored, charts pinned left-to-right, server English
  marked; and CLAUDE.md guideline 1 amended. Found by looking, not by tests: `text-start` on a
  header row centred every `<th>` (see the bug list);
- #143 (decision 95): every UI string in a react-i18next catalogue (759 keys), figures through
  `Intl`; the English text of every page was compared line by line with `main`'s and matched;
- #144 (decisions 96-97): migration 0034 `user_settings.language`, delivered with the session;
  `he.json` (775 keys with Hebrew's dual plurals); he-IL formatting; Unicode isolates for signed
  figures and English fragments. Checked page by page in Hebrew against a **copy** of the live
  database before merging; the user asked to merge.
Both environments run `main` at `7dcaf0a`, migration `0034_user_language`. The live account's
language is still `en` - the user switches it in Settings.

Previous handoff, 2026-10-01 ~13:27 UTC - **Post-M8 queue complete (#137-#140 after the #136 handoff). The
independent-tasks queue is empty; the next session starts Hebrew and RTL** - see "Next session:
Hebrew and RTL" in "Where to go next". The user re-granted (PR, merge on green, verify by content,
rebuild compose and kind) right after #136 and chose to continue in the same session; **that grant
ends here - ask again**:
- #137 (task 12): a dead rescreen held its day's key and the one-running index refused every later
  day's - button and CronJob alike - until the row was edited. `claimRun` now closes out runs dead
  by its own reclaim test and claims again; the shared fetch cache makes the new run resume;
- #138 (task 13): `k8s-up.sh` recovers a missing `secrets.env` from the Secret the running Postgres
  reads, and refuses when a database exists with no Secret - checked identical to the real file;
- #139 (task 14): the proposal sweep closes workflows left suspended on a decided proposal, by
  `refresh`, which reads and never writes;
- #140 (task 15): `queries.ts` split into 21 modules under `src/db/queries/` behind an index; a pure
  move checked line by line; CLAUDE.md's rule amended as the user decided.
Both environments run `main` at `1a12eac`.

Previous handoff, 2026-10-01 - **Post-M8 queue handoff at CLAUDE.md's five-merged-PR trigger
(#131-#135). There is no milestone in flight: the user chose a debt sweep after M8, approved it as
independent tasks 8-15, and tasks 8-11 are done. The next session starts task 12** - see "Next
session: the post-M8 queue, continued" in "Where to go next". This session (grant: one PR per task,
merge on green, verify on `main` by content, rebuild compose and kind - **it ends here; ask
again**):
- #131: the queue, measured on compose before it was written;
- #132 (decision 92): one question per standing finding - the queued fix (one open proposal per
  subject) was measured to stop 1 of 7 repeats, so the user chose episodes with hysteresis instead.
  Live: the first scan closed the AAPL and SPY seeds as resolved and held VOO (-0.124, notable);
- #133 (decision 93): the services connect as `traders_app`; only `migrate` is the owner. Live on
  compose and kind (kind's `secrets.env` upgraded in place, owner password kept); an audit UPDATE
  as the app role is refused by privilege;
- #134: cost per unit editable on screen, and a latent bug - a bare `costBasis` was read at USD's
  exponent (1500 JPY -> 150000); no stored row was affected;
- #135: a closed market's quote is dated at its last close (48 Sunday rows measured, then deleted
  from compose at the user's request); a crypto day ends at midnight UTC.
**Next after the queue: Hebrew and RTL** (the user's request, 2026-10-01) - CLAUDE.md guideline 1
says "English only" including UI copy, so it starts by amending that rule with the user. **The
user has no Docker/Kubernetes background** - keep explaining infrastructure from first principles.

Previous handoff, 2026-10-01 ~06:40 UTC - **M8's closing handoff (milestone boundary). M8 is complete, and
it was the last milestone in `docs/MILESTONES.md`; the next session starts by choosing what follows
it** - see "Next session: after M8" in "Where to go next". This session (grant: PR, merge on green,
rebuild compose, create/delete the kind cluster - **it ends here; ask again**):
- #126 (decision 88): the LLM panel - per agent, and narration's fallback reasons reconciled
  against the calls behind them; shown on compose with real narration calls;
- #127 (decision 89): on-demand profiles - described, never members; four readers, not one, had
  to be filtered;
- #128 (decision 90): the rescreen as a heartbeating background run into a volume (a
  PersistentVolumeClaim in kind) the loader reads newest-first. **The first real rescreen found
  three bugs no test had** - a rate limit a sample hid, a weight that rounds to zero, a snapshot
  published before its load - plus a reconciliation gap; all in "Bugs";
- #129 (decision 91): the CronJob asks hourly and rescreens when the loaded snapshot is a quarter
  old; the button and the CronJob are one run;
- CI was refused for a while by a GitHub billing block (jobs "not started" in 3 s - not a code
  failure; it cleared at the 1 Oct 00:00 UTC monthly reset). Read the annotation before the log.
**The compose universe has not been rescreened** (the user was asked; it rewrites the real
universe); it falls due by itself on 2026-12-24. **The user has no Docker/Kubernetes background** -
keep explaining infrastructure from first principles.

Previous handoff, 2026-09-30 ~22:40 UTC - **M8 handoff at CLAUDE.md's five-merged-PR trigger (#120-#124).
M8 is in progress: the admin surface exists and is guarded, audited, and shows runs, universe gaps
and the universe's status; every model call is recorded. The next session starts PR 6, the LLM
panel** - see "Next session: M8, continued" in "Where to go next". This session (grant: PR, merge
on green, rebuild compose, create/delete the kind cluster; **ask again**):
- **the #98 crypto check passed** (21:27 UTC): the first backfill after the local date rolled
  over replaced both 06:45 prices (BTC-USD $82,987.53 -> $83,701.02, ETH-USD $2,659.27 ->
  $2,683.26); nothing future-dated, no 1 Oct row. The 30 Sep close is a 21:27 price until the
  next night's backfill, as the debt table says;
- measured read-only first, and **six findings changed the milestone plan** (all in "Next
  session: M8, continued"); the user accepted all eight recommendations;
- #120 (decision 83): `users.role`, one guard on every `/admin/*` route, a test that enumerates
  `app.routes`; the kind CI job demotes the admin with psql and sees the same cookie go 403;
- #121 (decision 84): `admin_audit`, append-only **by trigger** - the app's role is a superuser,
  so the planned `REVOKE` would have done nothing (new debt row);
- #122 (decision 85): universe gaps as counted `ops_events` - the resolver now says whether the
  universe holds a symbol; a missing ticker was already *priceable*, it lacks a *profile*;
- #123 (decision 86): the universe status, reconciled against the loader's own stored counts -
  and **a silent drop found by measuring** (14 holding rows counted nowhere; "Bugs");
- #124 (decision 87): `llm_calls`, written by a wrapper the factory builds; call sites add only
  a verdict. Shown on compose with a real call (free route: 14.3 s, 487+1,370 tokens, $0).
**The user has no Docker/Kubernetes background** - keep explaining new infrastructure (PR 8's
PersistentVolumeClaim, PR 9's CronJob) from first principles when proposing and when writing it.

Previous handoff, 2026-09-30 ~14:45 UTC - **M7's closing handoff (milestone boundary). M7 is complete; the
next session starts M8, admin operations and observability** - see "Next session: M8" in "Where
to go next". After the five-PR handoff below (#114), the user asked to continue in the same
session:
- #115 (decision 82): the AI service's autoscaler, and metrics-server for kind;
- #116: the `kubernetes (kind)` CI job - `k8s-up.sh` on a fresh runner on every PR;
- #117: the autoscaler waits a minute before adding a copy - **found by measuring**: a 4-second
  scheduled scan was adding a copy that started after the scan ended, every half hour;
- #118: README (Kubernetes, architecture, costs), `docs/RUNBOOK.md`, `docs/DECISIONS.md`
  (generated, CI-checked) - and the stranger test from a fresh clone.
**M7's exit was checked** (see "M7 is complete, and how it was verified"). The session's grant -
PR, merge on green, rebuild compose, create/delete the kind cluster - **ends here; ask again for
M8**. The user has no Docker/Kubernetes background: every object was explained from first
principles as it was written, and that is worth keeping for M8's new pieces too.

Previous handoff, 2026-09-30 ~12:30 UTC - **M7 handoff at CLAUDE.md's five-merged-PR trigger (#109-#113).
M7 is in progress: the app deploys to a local kind cluster with one command, sits behind an
Ingress at http://traders.localhost, and nine CronJobs fire real runs - the milestone's first two
exit conditions are met. The next session starts PR 6 (the AI service's autoscaler), then PR 7
(docs a stranger can follow)** - see "Next session: M7, continued" in "Where to go next". This
session (grant: PR, merge on green, rebuild compose, create/delete the kind cluster; **ask again**):
- #109: production images; the web image serves `/api` on the page's own origin (decision 78);
- #110: the kind cluster, Postgres/Redis, the migrate/corpus/universe Jobs (decisions 75, 76, 79);
- #111: the three services and probes that cannot cascade (decision 77) - five problems found by
  deploying, each in "Bugs";
- #112: the Ingress, Traefik as plain YAML (decision 80) - and one reset nobody explained;
- #113: a CronJob per run kind, and a contract test against `scheduler.ts` (decision 81).
**The user has no Docker/Kubernetes background**: every object was explained from first
principles when proposed and again when written (what it is, why this app needs it, what breaks
without it). Keep doing that in PR 6 and PR 7.

Previous handoff, 2026-09-30 ~11:30 UTC - **M6's closing handoff (milestone boundary). M6 is complete; the
next session starts M7, Kubernetes and documentation** - see "Next session: M7" in "Where to go
next". After the five-PR handoff below (#103), the user asked to continue to the milestone's end in
the same session:
- #104 (decision 71): the feed paged and filtered in its address - and every scan's high finding
  had sorted *last* (severity tie-break on the text);
- #105 (decision 72): the mobile pass - every page measured at 375 px, only the dashboard needed it;
- #106 (decision 73): every time in the user's timezone with the zone named; an Account card;
- #107 (decision 74): **the daily digest in the UI** - the one FR the exit check found missing.
**M6's exit was checked** (see "M6 is complete, and how it was verified"). The M6 grant - merge,
rebuild, decide without asking - **ends here**; ask again for M7. **The user has no Docker or
Kubernetes background** (user memory): M7 is where that matters most - explain each object from
first principles as it is written, not after.

Previous handoff, 2026-09-30 ~09:30 UTC - **M6 handoff at CLAUDE.md's five-merged-PR trigger (#98-#102).
M6 is in progress; PR 11 (the feed) was then done in the same session at the user's request, then PRs 12 and 13 as well, so the next session starts PR 14, M6's closing handoff** - see "Next session: M6,
continued" in "Where to go next". This session:
- #98: **the backfill stored a day still trading as its close**, permanently (`DO NOTHING`) - found
  measuring history for the holding page; a manual run corrected 18 rows (AAPL 16 Sep to $332.41);
- #99 (decision 68): per-holding page `/holdings/$holdingId` - a chart of the rules' own series
  (a new AI-service endpoint), position, findings, news;
- #100 (decision 69): the proposals inbox - readable evidence, a history with expiries (dated by
  deadline: the sweep recorded them a median 52 h late), `/proposals/$proposalId`, optional
  `WEB_BASE_URL` for a Telegram "Open in app" link;
- #101: **a looping model answer passed the evidence validator** - found measuring `/ask`;
- #102 (decision 70): the `/ask` screen; queue task 6 closed, **the independent-tasks queue is empty**.
The user gave this session standing permission to merge each PR once CI was green, rebuild the
stack, and check each screen in the in-app browser, **not** to click Approve/Reject/Snooze or save
settings. **Ask again** - permissions do not carry over.

Previous handoff, 2026-09-30 ~07:00 UTC - **M6 mid-milestone handoff, at the user's request (context full).
M6 is in progress: 9 PRs merged (#88-#96); the next session starts PR 8, per-holding detail** - see
"Next session: M6, continued" in "Where to go next". The five-merged-PR trigger fired at #92; the
user asked to continue to the milestone's end, then chose to hand off here. This session:
- measured the running app at 1280 and 375 px before building (the plan in "Next session" came
  from that), and agreed the M6 order with the user: **TanStack Query first**;
- #88: dashboard fixes found by looking - a donut blank on every return, a header that scrolled
  away, "-15.5% below";
- #89 (decision 63): **the evidence validator approved cents written as dollars** ("fell to
  4016") - 4 of 11 stored model narrations; the 4 were rewritten by templates;
- #90-#93 (decisions 64): **all server state in TanStack Query**; queue task 7 closed;
- #94 (decision 65): every view has an address (TanStack Router, code routes);
- #95 (decision 66): the equity curve, stored snapshots only - and a DATE printed through
  `toISOString()` that made every snapshot a day early east of UTC;
- #96 (decision 67): **fixture prices had been standing in for real ones** in this installation's
  chain and produced a false high finding ("NVDA -48.6%"), which the user had deleted.
Merging, rebuilding and deciding were delegated by the user for M6 in this session; **ask again**.

Previous handoff, 2026-09-29 ~13:40 UTC - **M5's closing handoff (milestone boundary). M5 is complete;
the next session starts M6** - see "Next session: M6, continued" in "Where to go next". This session:
- designed the broader news feed with the user, every one of six decisions measured read-only on
  raw GDELT files first (three 24 h samples, then all 672 slots of 2026-09-22..29);
- #83: discovery indexed (69 s -> 2.8 s on a real week, identical output) - it would have timed
  out at the orchestrator's 30 s on the market feed's first full week;
- #84: the market feed (decision 60) - same GDELT files, second filter, `articles.feed`;
- #85: one foreign country's press is local news (decision 61) - `data/outlets`;
- #86: weak proposals in their own band and cap, behind a toggle (decision 62).
**M5's exit, shown on live data 2026-09-29:** discovery proposed "data center" (DLR, APLD, CIFR,
GDS, CORZ, KEEL, BXDC) and "bond yields" from real stored headlines; "canadian imports" was
rejected in the UI and the next run (`topic_discovery:manual:rejection-check-1790688549`) said
*matches rejected topic "canadian imports" by words*. The free-text half (resolve -> confirm ->
topic observations) was shown in #53-#57. The user asked this session's Claude to merge each PR
once CI was green and rebuild the stack, and it did; **Option B** (Claude rejecting a proposal
through the UI) was chosen by the user for the rejection check - ask again next time.

Previous handoff, 2026-09-29 ~08:30 UTC (at a natural boundary, at the user's request: three PRs
merged, #79-#81). **The next session starts with the design of a broader news feed** - see
"Next session" in "Where to go next". This session worked M5's exit proof and found that the
feed, not discovery, is what stands between it and a real theme:
- #79: wordings of one story are one candidate (`VARIANT_SHARE`, decision 55) - one Nvidia
  launch had spent 7 of 8 resolve slots;
- #80: one company's news is not a theme (decision 59): a phrase at 0.75+ of one followed
  instrument's headlines is dropped with its reason; `PHRASES_REQUESTED` 20 -> 100;
- #81: `face`, `ceo`, `keep` are generic words.
The manual run after #80 dropped 82 of 100 phrases as one company's news and resolved 8 that
were not themes ("short interest", "jim cramer"...). Every PR was measured read-only against the
stored headlines before it was built, at the user's request - keep doing that.

Previous handoff, 2026-09-29 05:30 UTC (at CLAUDE.md's five-merged-PR trigger: #73-#77): **the
next session starts with M5's exit proof, which is now due** - see "Next session" in "Where to go
next" - and then the two queue tasks left (6 and 7, both M6-sized). This session took tasks 1-5
of the "Independent tasks queue", one PR each, all merged and the stack rebuilt:
- #73: money at the currency's exponent - in the templates *and* the evidence validator, which
  had approved the same hundredfold-wrong yen figure;
- #74: a Telegram notice when explanations switch between the model and templates (decision 58),
  verified with a real message the user received;
- #75: the Topics page looked at in a browser; two phone-width faults fixed (the dashboard header
  made the page 721 px wide and sent a tap on "Topics" to Settings);
- #76: **the `postgres (integration)` CI job** - migrations round-tripped over data covering every
  enumerated value, retrieval/topic SQL, `queries.ts`. Its first run found that 0019 could not
  follow its own downgrade (fixed in 0019);
- #77: quotes carry each instrument's asset class and exchange (`market_sessions.py`).

Merging: the user asked this session's Claude to merge its PRs once CI was green, and it did.
Replies pasted as quoted text were confirmed with the user before being acted on, at their
choice each time ("just this once") - keep asking.

Second handoff of 2026-09-28 (after #71): #71 made unanswered auto-proposals expire (decision
57), and #72 created the queue.

Earlier the same day (handoff at CLAUDE.md's five-merged-PR trigger: #62-#66 merged since the
last one): **M5 is feature-complete and its exit criterion is not yet shown.** Topic resolution,
confirmation, topic observations, topic news, per-topic sentiment, the digest's topic section,
auto-discovery with rejection memory (decisions 55-56) and topic cards are all built and live.
**What is missing is evidence:** auto-discovery has never been seen proposing a real theme, and
M5's exit criterion needs one. It needs 24-48 hours of title-matched headlines first (the user's
call, 2026-09-28) - see "Next session" in "Where to go next". This session shipped:
- #62: auto-discovery with rejection memory - recurring headline phrases become proposals;
  rejection is a 90-day cooldown by the user's decision, matched by words OR instruments
  (decisions 55-56);
- #63 (a parallel session): the search API's 429 diagnosed as load-shedding, retries added;
- #64: topic cards - a topic's news and tone, and which empty an empty list is;
- #65: discovery counts stories, not articles, and reads only linked headlines;
- #66: **GDELT read from its raw 15-minute files**, the search API deleted (decision 52);
- #67: MEMORY: the raw feed live, debt for everyday-word names;
- #68: discovery ranks multi-word phrases first; six more everyday words;
- #69: `sendDigest` takes `now` - its test had started failing on `main` when the date changed.

**Real news arrives, from GDELT's raw files (#66, decision 52), since 2026-09-27 19:35 UTC.** The
search API it replaced refused most requests and, when it answered, stored mostly unlinked noise
(1 of 17 linked on its last success). The first raw-file run read 8 files and stored 18 articles,
**all 18 linked** to followed instruments; the overnight runs stored 24-47 linked articles each.
Two known gaps, both in the debt table: company names that are everyday words ("Apple" the fruit)
link falsely, and auto-discovery has run once on real headlines and proposed nothing - correctly,
but it has not yet been shown finding a theme, which is M5's exit criterion.

The resolver still finds **14 of 35** expected tickers on the user's held-out batch, and nobody
changed its thresholds. The add-a-ticker box is how a confirmed set closes that gap (decision 46).
`docs/TOPIC_RESOLUTION.md` holds the measurements and the backlog.

The M3 closing summary (PRs #42–#47) is kept below in "Where to go next" and the decisions list.

**One-line state:** the product imports a portfolio, fetches six months of real daily prices, scans
it every 30 minutes for four kinds of finding, explains each one in sentences whose every figure is
checked against the evidence, **links every term in those sentences to an explanation of it**,
**answers a question phrased in the user's own words with the passages that bear on it —
by meaning, not by shared vocabulary — and says so when it is not sure**, lets
the user state the allocation they meant to hold, and turns the drift from it into a proposal with
a deadline that an approval writes to a paper ledger. No order is ever placed. The explanations are
currently written by templates rather than a model, and the app says so on its own dashboard.

**Telegram now works end to end locally** (2026-09-24). A chat is bound, and taps reach the ledger
through `TelegramPoller`, which long-polls `getUpdates` because the webhook still needs M7's public
HTTPS URL. Verified live: approve → undo → approve → undo from a real chat, each landing as an audit
row and a ledger row marked revoked. What remains unproven is only the *webhook* transport.

---

## Independent tasks queue

Work that depends on nothing in flight, so it can be taken while M5's exit proof waits on real
headlines (or at any other time). Created 2026-09-28 at the user's request, from a sweep of the
debt table and MILESTONES.md.

**The rule, set by the user:** when a task here is completed, **remove it from this queue**, and if
it is also part of a milestone, **remove it from that milestone's list in `docs/MILESTONES.md`**
too, in the same PR. The PR number is the record; neither document keeps a struck-through line.
Where the task also has a row in "Current technical debt", resolve that row in the same PR, as
that table already does. One task, one branch off `main`, one PR (no stacked PRs).

Ordered by the recommendation made when the queue was written: small correctness first, then the
unblocked feature, then structure. Numbers are kept when a task leaves, because other text refers to
them; task 1 (money at the currency's exponent) was done in #73, task 2 (the narration notice,
decision 58) in #74, task 3 (the Topics page in a browser) in #75, and task 4 (the Postgres CI
job, approved by the user 2026-09-28) in #76, and task 5 (quotes carry asset class and exchange) in
the PR after that. Task 7 (server state in TanStack Query) was done across #90-#92 and the topics PR
that closed it, and task 6 (a screen for `/ask`) in M6 PR 10. That queue emptied at M8's close.

**The post-M8 sweep (2026-10-01)** refilled it as tasks 8-15 - **all done by #140**; tasks 16-18 were added 2026-10-07, and task 18 (reset account) left it in the PR that added migration 0045; task 16 (scan frequency) was dropped 2026-10-08 by decision 130, and tasks 19-21 added by decisions 132-134 (task 8, one question per standing
finding, became decision 92 when measured; task 9 is decision 93; task 10 found a latent cost-currency bug), approved by the user in that order,
with the same grant as M8 (PR, merge on green, verify on `main` by content, rebuild compose and
kind). It was measured on compose before it was written: the BTC-USD drift was proposed **7 days
running** (25 Sep-1 Oct; approved once, 5 expired unanswered), only 2 low-confidence gap events
exist (both hand-made), only 2 profiles are `on_demand`, and no run was stuck. **Next after the
queue: Hebrew and RTL** - which needs CLAUDE.md guideline 1 amended first (the proposal: code and
docs stay English, UI copy becomes localizable with English the default); measure hard-coded
strings and left-to-right assumptions before designing it.

| # | Task | Milestone | Size | Where, and what "done" means |
|---|---|---|---|---|
| 17 | **Narration: why two of three model texts are rejected, fixed on the free model** (the user, 2026-10-07) | — | S | **Measured 2026-10-07** over the 38 `unsourced_figures` rejections on compose (all `nvidia/nemotron-3.5-lightning:free`, the validator re-run on each): **34 of 38 mention a threshold** ("crossed the 25% high threshold") that is true but refused, because `thresholds_pct` / `thresholds_weight` are nested and their keys (`info`, `notable`, `high`) carry no ratio marker - **5 were refused for that alone**; **30 of 38 copy a price in minor units** ("fell to 790" for $7.90), rightly refused, but the evidence invites it by handing the model `*_minor` integers; **3 are real inventions** ("$10.14M" for $101,427.80). **One error passed:** "the 0.03% information threshold" for 0.03 = 3%, accepted because the bare digits are in the evidence. **Fixes, one PR:** (1) the validator reads values under a `thresholds_*` key as ratios; (2) narration's evidence gives money as decimal strings ("7.90"), as the agent tools do since #177; (3) a ratio's bare digits followed by `%` are refused ("0.03%" for 0.03), while "0.03%" for a true 0.0003 stays accepted. **Then measure again on the free model** - the user's choice, because a paid model costs money and the fixes may make it unnecessary for narration (estimated at $0.03-0.07 a week on Flash-Lite or Haiku, against the agents' $0.04-0.38 a scan; the Admin page already sets narration's model separately). **The three fixes landed in the PR after #178; what remains is the re-measurement** on the free model once compose and kind run it - re-run the 2026-10-07 export (`llm_calls` where `purpose = 'narration'`) over the narrations written after the deploy. Done when that rate is recorded here, and this row is then removed |

**Not in the queue, and why** - so they are not added back by the next sweep:
- *Everyday-word company names* ("Apple" the fruit): the user deferred it to a dedicated PR after
  more data.
- *Names ending in ", LP"*: fixing it moves topic resolution, which cannot be measured honestly
  without a new held-out batch (batch 3) written by the user.
- *Citing news in observations* (`articles=()`): would cite the fruit headlines as evidence; after
  the everyday-word fix.
- *The 0.007 topic gate*: 2 low-confidence events exist, both hand-made; wait for real ones.
- *ReadWriteOnce snapshot volume, Telegram's webhook leg*: belong to a real deployment.
- *The `:free`-suffix cost rule*: matters once the workspace is funded.
- *On-demand profiles never refreshed*: 2 rows; revisit when gap events show real use.

---

## Milestone status

| Milestone | Status | Notes |
|---|---|---|
| **M0 — Repo skeleton & contracts** | ✅ Complete | monorepo, compose stack, CI, OpenAPI contract + generated client |
| **M1 — Vertical slice** | ✅ Complete | portfolio in, valued portfolio out |
| **M1.5 — Trustworthy quote path** | ✅ Complete | **unplanned**; inserted after an audit found data problems M2 would have built on |
| **M2 — Analysis engine & observations** | ✅ Complete | PRs #12–#22 |
| **M2.5 — Real price history** | ✅ Complete | **unplanned**; PR #23. Finished M1's provider layer, 18 PRs late |
| **M3 — RAG & educational engine** | ✅ Complete | #42: corpus, schema, ingestion, live concept links. Slice 2: `vector(1536)`, `BaseEmbedder`, `VectorStore`, hybrid retrieval and `GET /concepts/search`. #45: the paid embedder. #46: `POST /ask`, intent routing, citations, a three-state relevance floor. #47: the 35-case eval set in two CI tiers. **The relevance floor is measured to be in the wrong place — see the debt table** |
| **M4 — Scheduling, HITL & Telegram** | ✅ Complete | PRs #26–#33. Mastra adopted for `proposalLifecycle` only |
| **M5 — Market discovery & topics** | ✅ Complete | #50–#51: eval set, universe, resolver. #53–#55: resolve, CRUD + confirm, Topics screen. #57: topic observations. #58–#59: news collection, GDELT. #60: topic sentiment. Digest topic section (this handoff's PR). **Recall on held-out topics: 14/35.** Auto-discovery with rejection memory (decisions 55-56). Topic cards: news and tone on the topic's card, with the last collection's state so an empty list is never called a quiet week. #79-#81: discovery collapses wordings of one story and drops one company's news (decision 59). #83-#86: indexed discovery, the market feed, the one-country rule, weak proposals (decisions 60-62). **Exit shown live 2026-09-29** ("data center" proposed; a rejection held) |
| M6 — Frontend completion & polish | ✅ Complete | #88-#107. TanStack Query and Router; equity curve; holding pages; proposals inbox with history and pages; `/ask`; feed paging and filters; mobile pass; times in the user's zone; the digest in the UI. Four correctness bugs found by measuring on the way (#89, #96, #98, #101) plus the feed ordering (#104). Exit checked 2026-09-30 - see "M6 is complete" |
| M7 — Kubernetes & documentation | ✅ Complete | #109-#118: production images, the kind cluster with one command, services with probes that cannot cascade, Traefik Ingress at traders.localhost, a CronJob per run kind, the AI autoscaler, a kind job in CI, README/runbook/decision index. Five faults found only by deploying (#111), one by measuring (#117). Exit checked 2026-09-30 - see "M7 is complete". **Telegram's webhook leg is still unproven** (optional, user's go-ahead) |
| **Database sprint** (no M-number; agreed 2026-10-09) | 🚧 In progress | DB1 ✅ #208; DB2 ✅ #210 (instrument_profiles 155 -> 96 MB); DB3 ✅ #213 (window from 2026-10-11 07:56 UTC); DB4 split (decision 143): first half 2026-10-11 (#218, decisions 143-147), second half 2026-10-18 (decisions 151-154: migrations 0053-0055 in three PRs). DB1 backup and restore, DB2 the universe loader writes only what changed, DB3 query statistics, DB4 the review a week later. Decisions 137-147, 151-154. See "Planned: the database sprint" |
| **The assistant - `/ask` with tools** (no M-number; the user's request, 2026-10-07) | ✅ Built (checks owed) | Test set #212; #220-#223 deployed 2026-10-12 - core, Admin picker and limit, replay and universe tools, the `/ask` chat screen. **Live.** PR 4 (eval runner, measured limit, old `/ask` removed) done. #225 PR 4, #226 PR 4b, #227 PR 5 (`openai` package) merged 2026-10-14 - **all planned PRs built**; #232 (prompt lines) measured 166/258 and merged 2026-10-18, not yet redeployed. Post-milestone candidates in "Next session: after the assistant milestone". See "Planned: the assistant" and "Next session: the assistant's PR 4b" |
| Hebrew & RTL (no M-number; the user's request after M8) | ✅ Complete | #142 layout (logical classes, guard test), #143 react-i18next catalogue + `Intl` formatting, #144 `user_settings.language` (0034), `he.json`, he-IL. UI only: server-generated text stays English (decision 96). See "Hebrew and RTL is complete" |
| Hebrew server text (no M-number; the user's choice after Hebrew & RTL) | ✅ Complete | #147 `observations.localized` (0035) + Hebrew templates, backfilled 78/78; #148 Telegram and digest catalogue. `/ask`, news and the corpus stay English (decision 96 as amended). See "Hebrew server text is complete" |
| Multi-agent sandbox, Stage 4 — the agent that decides | ✅ Complete | #172 spec D43-D52 + §14; #173 models on the Admin page (0041, D43-D44); #177 the scan's inputs - tool calling, movers, seven read-only tools, the briefing (0042); #180 the scan - one hand-written loop (D53), the per-agent budget, the step limit, `agent_scans` (0043), `POST /agents/:id/scans`, built on a scripted model (**real scans not yet measured: the account is unfunded**). Then #182/#183 PR 5 (the trade proposal and its approval), #186 PR 5b, #188 PR 6, #197, #199 - see "Stage 4 is complete" |
| Multi-agent sandbox, Stage 3 — the ledger | ✅ Complete | #161 spec D21-D26 + §13; #162 exchange calendar; #163 ledger (0040); #164 manual trades (D27-D30); #165 the agent page (D31); #167 the consolidated holdings view (D32-D35); #168 performance against a shadow SPY and the score (D36-D42). Trade proposals and their approval moved to Stage 4 (D26). Handoff #169 |
| Multi-agent sandbox, Stage 2 — agent management | ✅ Complete | #158 `/agents` API + the every-route-behind-a-session test; #159 the Agents page and a page per agent (en/he). D17-D20. The consolidated view moved to Stage 3 (D17) |
| Mastra retired (D11) | ✅ Complete | #157, migration 0039: proposals are the row, `applyDecision` and `proposal_sweep` |
| Multi-agent sandbox, Stage 1 — isolation (no M-number; `docs/PROPOSAL-MULTI-AGENT.md`) | ✅ Complete | #151 spec amendment D1-D16; #152 `agents` + `agent_id` (0036); #153 agent-scoped reads + contract; #154 per-agent uniques (0037); #155 passive primary (0038). Nothing user-visible, by design. Stages 2-4 to come - see "Next session: multi-agent Stage 2" |
| M8 — Admin operations & observability | ✅ Complete | #120-#124, #126-#130: the admin role and guard, `admin_audit`, universe gaps (`ops_events`), the universe status, `llm_calls`, the LLM panel, on-demand profiles, the rescreen run and its CronJob. **Exit so far:** 403 on every `/admin/*` route, enumerated ✅ (test + kind CI); real calls recorded and shown per agent ✅ (#126, the LLM panel); missing ticker as a gap event and profiled within one background fetch ✅ (#127, decision 89); rescreen button ✅ (#128, decision 90; shown in kind); button and CronJob are one run ✅ (#129, decision 91; shown in kind). Checked live 2026-10-01 - see "M8 is complete, and how it was verified" |
| Agent template creator (no M-number; the user's request, 2026-10-18) | ✅ Complete | #252 taxonomy (0056), #254 mandate + code check + retry (0057), #257 the form, Downshift picker, settings-alone readiness, #258 save-time contradiction check (0059). Decisions 164-178. Not yet checked in a browser or against a real model; undeployed |
| M9 — Multiple users | ✅ Complete (exit test passes; PR after #287, 2026-10-21) | Schema 0058 (#249-#255), login #260, signup #264, cap #277, own key #278, then one PR for scheduling per user (D238), the user's own zone (D163), the admin's user list and own reset (D239) and the exit test (D240). Earlier: PR 1 (measurement, `docs/M9-MEASUREMENT.md`) merged as #240, 2026-10-15. Added to the plan at the user's request, 2026-10-14; not ordered against the database sprint or the assistant's owed checks. PR 1 is a read-only measurement of every single-user assumption; the decisions (who the users are, login, sessions, scheduling, shared costs) come after it. See `docs/MILESTONES.md` |

**Why the two unplanned milestones exist, and the pattern behind them.** Both were gaps the plan did
not anticipate, found by running the thing rather than by reading it. M1.5 came from auditing the
quote path and finding timestamps that made the price series unusable. M2.5 came from asking "can I
get real data out of this?" and discovering the answer was no. Expect more of these: the milestone
plan describes features, and the gaps have all been in the layers underneath them.

---

## Orientation: running and verifying

```bash
bash scripts/dev-docker.sh          # everything in containers; prints URLs (and the admin password, first start only)
bash scripts/dev-local.sh           # app processes native, Postgres+Redis in containers
bash scripts/smoke-test.sh          # end-to-end against a running stack
```

Full gate, which every PR must pass. **The compose smoke test is part of it and is easy to skip**
— it is the only gate that starts the services the way they are actually deployed, and in M4 it
caught a config bug that every one of 700 unit tests missed: an optional secret declared
`z.string().min(1).optional()` is fine when the variable is *absent* and refuses to boot when it is
*present and empty*, which is exactly what compose passes through for every key listed in
`.env.example`. If you do not run it locally, read CI before merging rather than after.

In a worktree, see "Local environment" for why the Python line below is not the one to use.

```bash
pnpm -r typecheck && pnpm -r test
cd services/ai && .venv/bin/python -m pytest -q
.venv/bin/ruff check . && .venv/bin/ruff format --check .
```

The corpus is a derived copy and is not covered by any of those. `cd services/ai &&
DATABASE_URL=postgresql://traders:traders@127.0.0.1:55432/traders .venv/bin/python
scripts/ingest_corpus.py --dry-run` answers whether the database is in step with `data/corpus/`.

Test counts (2026-09-30, after M8 PR 5): **1,791** — 872 Python, 600 orchestrator, 302 web, 17 shared - plus
**37 Postgres integration tests** (23 Python, 14 orchestrator) that skip without `TEST_DATABASE_URL`. Plus two
eval sets, which are not test counts: `/ask`'s **35 cases** (16 keyless on every PR, all 35 when
keyed), and the topic eval's **31 cases** (`scripts/run_topic_eval.py`, keyed only, **not in CI**).

**The SQL has its own CI job: `postgres (integration)`** (independent task 4). The ordinary suites
stay hermetic - the Python suite has no Postgres and the orchestrator's tests substitute
`db/queries.ts` - and the SQL runs in a job with a real one, opt-in by `TEST_DATABASE_URL`
(never `.env`), refusing any database whose name does not end in `_ci` or `_test`:
- `services/ai/tests/integration/test_migrations.py`: every revision round-trips (down, up over
  what the downgrade left, down) from head to base over `seed_head.sql`, which must hold a row
  for **every value any CHECK enumerates** - read from `pg_constraint`, so a migration that adds
  a value fails CI until the seed carries it. Deliberate refusals (0014's) are listed in
  `KNOWN_REFUSALS` and must keep happening;
- `test_retrieval_sql.py`: hybrid search, the ORed/ANDed lexical half, the model filter and topic
  resolution over data loaded by the real ingest scripts;
- `apps/orchestrator/test/queries.postgres.test.ts`: the narration ledger's lock, notification
  and observation dedupe.
Each was shown to fail against the bug it pins (0021's constraint order, 0006-style upgrade over
rows, the untyped `:model` parameter, a removed row lock). Locally:
`docker exec traders-postgres-1 psql -U traders -d traders -c 'CREATE DATABASE traders_ci'`,
then `TEST_DATABASE_URL=postgresql://traders:traders@127.0.0.1:55432/traders_ci` in front of
pytest (Python first: it migrates) and `vitest run test/queries.postgres.test.ts`.

Useful endpoints (all need the session cookie except `/internal/*`, which needs `x-internal-key`):

| | |
|---|---|
| `POST /internal/runs` | `{kind: snapshot \| portfolio_scan \| backfill \| proposal_sweep \| daily_digest \| instrument_metadata}` — the single entrypoint for all scheduled work |
| `GET /runs` | run history: *did the work actually happen?* |
| `GET /observations` | the feed, with full evidence |
| `GET /proposals?state=open` | the approvals inbox; `POST /proposals/:id/decision` answers one |
| `GET /notifications` | *what was the user told, and what were they deliberately not told* |
| `GET`/`PUT /settings` | severity floors, TTL, quiet hours, mute |
| `PUT /targets` | set allocation targets; the **Targets page** writes it (#35) |
| `GET /narration` | is a model writing the explanations, and if not, why not (#38) |
| `POST /telegram/bind-token` | the **Settings page** mints the connect link (#38) |
| `POST /telegram/bind-token` | mints the signed connect link; `POST /telegram/webhook` is public |
| `GET /concepts/:slug` | the explanation behind a concept chip (#M3). 404 means the corpus is not ingested, not that the app is broken |
| `POST /ask` | a question in, a checkable answer out. **A refusal is a 200** with `answered: false` — declining an out-of-index question is an outcome, and a 4xx would make it look like a broken corpus. `answer_source` is `extractive` \| `llm` \| `computed` \| `none`; `computed` is arithmetic over holdings and is *never* a model |
| `POST /topics/resolve` | `{topic}` → candidates with band, quoted rationale and `held_by`. **`verdict` has four values**; `unavailable` (with `universe.state`) means the universe was *not searched*, and is never the same as `none` (decision 47). Stores nothing |
| `GET`/`POST /topics`, `GET`/`PUT`/`DELETE /topics/:id` | the user's topics. `POST`/`PUT` take `{label, symbols}` and **re-resolve on the server** to decide which symbols carry reasons (decision 48). 422 `topic_limit_reached` / `unresolved_symbols` (with `details.symbols`), 409 `duplicate_topic` |
| `POST /topics/:id/reject` | decline an auto-proposal; it becomes rejection memory for `TOPIC_REJECTION_COOLDOWN_DAYS`. `DELETE` on a proposal is a 409 `topic_is_proposal`, because deleting would erase the memory |
| `GET /runs?kind=topic_discovery` | why nothing was proposed: every phrase examined has a reason in `notProposed` |
| `GET /concepts/search?q=` | hybrid retrieval: the half of `/ask` that finds things. A diagnostic surface with no relevance floor and no refusal — those are `/ask`'s judgements. Every match reports `vector_rank` and `text_rank`, so *which half found this* is answerable; `vector_is_semantic: false` says the embedder ranks by shared words alone |

---

## What exists, by area

**`services/ai`** (Python, FastAPI) — market data providers behind a chain with caching, rate
limiting and per-provider daily budgets; four deterministic analysis rules; news ingestion with
entity extraction; an LLM provider factory with a daily spend guard; narration behind an evidence
validator; **the concept corpus: structure-aware chunking, hash-compared ingestion and slug
lookup, and **hybrid retrieval over it: an embedder behind `BaseEmbedder`, a `VectorStore` over
pgvector, and reciprocal-rank fusion of the vector and full-text halves**; **topic resolution
(M5): a committed, rule-screened instrument universe (`data/universe/`, `app/universe/`), profiles
embedded with the company's own name stripped, ETF holdings, and `app/topics/resolution.py`, served as `POST /topics/resolve`**; the Alembic schema (17
migrations) that both services share.

**`apps/orchestrator`** (Node, Hono) — sessions, holdings CRUD, CSV/JSON import with per-row
validation, valuation with FX, target weights, the scan workflow, run claims, the observations feed,
the local scheduler, **the proposal state machine and its audit trail, the notification fan-out, the
Telegram adapter, per-user settings, and topics with confirmed instruments (`services/topics.ts`)**.

**`apps/web`** (React, MobX, Tailwind, Recharts) — login, portfolio dashboard, import wizard,
observations feed with an evidence drawer, the approvals inbox, a settings page, the concept
dialog behind the feed's chips, **and the Topics page with its confirm screen (`TopicsStore`)**.

**`packages/shared`** — wire types, money helpers, and the AI-service client whose zod schemas are
pinned to the generated OpenAPI types so Python drift becomes a compile error. That mechanism has
caught four real mismatches; trust it.

---

## Decisions that were argued, not obvious

The code shows *what*; these are the *why*. Several look like over-engineering until you know the
failure they prevent.

1. **No market-status API on the pricing path.** Evaluated and rejected. The quota saving is near
   zero because fetching is demand-driven; an external check cannot replace the offline calendar it
   would need as an outage fallback, so you maintain both and the fallback rots; and a wrongly
   cached "market closed" halts pricing for a day — failing in the expensive direction where the
   current design fails in the cheap one. If scheduled scans ever make holidays material, the answer
   is a **static calendar applied at the scheduler**, not a network call per quote.

2. **Partial snapshots are stored and marked, not refused.** A day where 9 of 10 holdings priced is
   recorded with `degraded`, `priced_count` and `holdings_count`. Refusing would leave a silent hole
   in the equity curve, which is just as misleading as an understated total. Rows predating the
   columns are backfilled `degraded = true`: unknown provenance is closer to degraded than to
   trustworthy.

3. **Identity is decided before narration, not after.** The caller sends the dedupe keys it already
   holds and the pipeline skips those before calling a model. Narrating and then discarding on
   insert was ~370 throwaway completions a day at a 30-minute cadence. A repeat costs a hash.

4. **A price series is never stitched across providers.** The chain takes the first provider with
   *any* history rather than merging partial answers, because a daily return measured across the
   seam compares two definitions of a close rather than a move. (Quotes *are* merged across
   providers — different question, no continuity to break.)

5. **`auto_adjust=False` on the Yahoo history read.** An adjusted series rewrites history after
   every dividend and split, so yesterday's closing price would change under us — and an observation
   citing a price the user can no longer find is worse than no observation.

6. **The run-key bucket decides what counts as a repeat, and lives server-side.** `snapshot` and
   `backfill` bucket by day, `portfolio_scan` by half hour. The policy is in `/internal/runs` rather
   than in the caller so a Kubernetes CronJob inherits it unchanged. The timers deliberately fire
   *more often* than the work is allowed to happen (15 min against a 30-min bucket): a timer firing
   exactly once per period skips that period entirely if the process restarts at the wrong moment,
   and a silently skipped run looks exactly like a quiet market.

7. **pgvector inside Postgres**, not a separate vector database, behind a `VectorStore` interface.
   One fewer container, transactional writes with the rest of the domain.

8. **REST + OpenAPI, not gRPC**, with routes shaped so SSE can be added without changing payloads.

9. **One trigger path for scheduled work.** Locally a timer calls `POST /internal/runs`; in
   Kubernetes a CronJob will, with `SCHEDULER_ENABLED=false` on the Deployment. Two schedulers would
   double-fire.

10. **Cost basis is stored per unit, not as a position total.** Editing quantity would otherwise
    leave a total nobody paid, and the system could not tell a correction from a purchase.

11. **Mastra is adopted for `proposalLifecycle` only** (**retired 2026-10-05, decision D11 /
    migration 0039**: every entry point already fell back to the direct path, and nothing it ran
    after a resume was needed; kept here for the reasoning) — and this **diverges from MILESTONES.md
    M4**, which lists four workflows (`portfolioScan`, `topicScan`, `dailyDigest`,
    `proposalLifecycle`). The scheduling half already works: run kinds, run keys, the half-hour
    bucket and the claim in the `runs` table. Porting it would buy a different spelling of the
    same behaviour and risk a regression in the one subsystem whose failure mode is *silence* —
    and Mastra's scheduler would want to own the trigger, while DESIGN.md §2 has exactly one
    (`POST /internal/runs`) precisely so a CronJob and a local timer cannot both fire. What the
    existing scheduler genuinely cannot express is a **suspension**: a run that pauses for hours
    waiting on a person and is still there after a restart. That is the whole reason the
    dependency earns its place, and it is the only thing it is used for. If a later milestone
    wants `dailyDigest` as a workflow, the argument to re-examine is that one, not this
    precedent.

    Two rules keep the adoption from rotting, both stated in
    `apps/orchestrator/src/mastra/README.md`: **nothing under `mastra/` decides anything** (every
    transition goes through `applyDecision`, or F3's invariants stop being properties of the
    system), and **every entry point degrades to the service when the runtime is absent** — a
    coordinator that can block a decision the user made would be worse than no coordinator.

12. **Session auth is a signed self-describing cookie**, no session table. Only `http/auth.ts` and
    the login route change when real multi-user auth arrives.

13. **Misconfiguration fails at boot in production, degrades in development.** An unknown LLM
    provider or a missing key raises in production and returns a null provider elsewhere.
    `LLM_PROVIDER=null` is always honoured: the distinction that matters is *deliberately off* versus
    *broken*.

14. **Unpriced is `null`, never `0`.** A zero is indistinguishable from a real value, so an
    infrastructure failure would render as a financial fact. The same argument rejects a `1.0` FX
    fallback: it collides with the legitimate same-currency rate, destroying the evidence that
    anything went wrong.

15. **The milestone order was changed from the original brief** to ship a vertical slice first.

16. **A proposal's expiry is computed on every read, never trusted from the row.** `effectiveState`
    recomputes it, and the stored value is a cache. Trusting the column would leave a window between
    a deadline passing and the sweep noticing in which a dead proposal is still answerable — and
    that window widens to the whole sweep interval after a restart, which is exactly when a user is
    most likely to be retrying something. The sweep is therefore *housekeeping*, not correctness: it
    exists so the inbox can filter on a column and the audit trail can say when each proposal died.

17. **Idempotency is an outcome, not an exception.** A decision returns `applied`, `unchanged` or
    `refused`. `unchanged` is a **success**: it means the proposal was already in the state asked
    for, which is what a second tap produces — usually because the first reply was lost, and that
    user did nothing wrong. Collapsing it into an error punishes them; collapsing it into `applied`
    writes a second audit row and a second ledger entry for one act.

18. **Nothing is ever dropped on the notification path.** Quiet hours, a severity floor and an
    explicit mute all change *when* the user hears, never *whether* — everything suppressed is
    deferred into the digest. A notification that vanishes is indistinguishable from a market that
    did nothing. For the same reason `notifications` is a **ledger, not a queue**: a suppressed
    message gets a row with its reason, so "we chose not to tell you" and "we failed to tell you"
    can never look the same afterwards. That is the question actually asked after an incident.

19. **Claim, then send, then settle.** The `notifications` insert *is* the claim (`dedupe_key` is
    unique). Sending first and recording after is the obvious alternative and it is wrong: a crash
    between them loses the record of a message the user has already read, and the retry sends it
    again. Claiming first fails the other way — a `pending` row for a message that never went out,
    which the digest picks up. **A missing alert is recoverable; a duplicated one is not.**

20. **Two Telegram secrets, and only one of them ever signs anything.**
    `TELEGRAM_WEBHOOK_SECRET` answers "is this really Telegram?" and nothing else: Telegram holds a
    copy, it rides in every inbound header, and it is plaintext wherever TLS terminates.
    `TELEGRAM_SIGNING_SECRET` signs the inline buttons and the connect links and never leaves the
    process. The first implementation signed connect links with the *webhook* secret, which was a
    real hole — `SINGLE_USER_ID` defaults to a value published in this repository, so anyone who
    read that header out of a proxy log could mint a link, bind their own chat and approve
    proposals. Both token types are signed over a domain tag so one key cannot mint the other kind.

21. **Reasoning effort is a property of the task, not of the installation.** It was one
    process-wide setting baked into the provider at construction. Narration has no judgement to
    improve — it restates figures it may not alter, and the evidence validator is what makes the
    sentence trustworthy — so it wants thinking off; `/ask` deciding whether its retrieved context
    supports an answer at all genuinely wants it on. One setting forces one answer on both, and the
    caller that never considered it silently inherits the choice made by the one that did. So it is
    a per-call argument: `None` means "no opinion, use the deployment default", the string `"none"`
    is an opinion and overrules it, and the two are deliberately not collapsed.

22. **The evidence validator is not made redundant by a better model.** It was asked directly, and
    the answer matters: a capable model changes the *rate* of unsourced figures, never the
    possibility, and guideline 7 is categorical. Better models also fail more dangerously — a weak
    model's invention is clumsy, a strong one's is plausible and stylistically identical to the true
    sentences around it. The validator is also what makes the evidence drawer an actual check rather
    than decoration, and it is the detector that makes the template fallback possible at all: you
    cannot degrade from a bad narration you cannot identify. It costs nothing, and its rejection
    rate doubles as a measurement of whether a model is fit for the job — which is how we learned
    the free one is not, without shipping a single bad sentence.

23. **The acting user comes from the chat binding, never from the callback payload.** There is
    nowhere in a forged token to name a victim. A forwarded Telegram message keeps working buttons,
    so this is the property that makes forwarding harmless.

24. **M3 was sliced so that no embedding dimension is guessed.** Slice 1 ships the corpus, the
    schema, ingestion and live concept links with **no `vector(n)` column at all**. That column is
    a commitment to one embedding model: `n` is fixed at creation, pgvector's HNSW index is built
    per dimension, and correcting a guess costs a migration plus a full re-embed. Nothing in slice
    1 needs one — a concept link is an exact slug lookup, and the full-text index covers keyword
    search — so the choice is deferred to slice 2, which can make it on evidence. The remaining
    slices are (2) `VectorStore`, an embeddings provider and hybrid retrieval, with a deterministic
    fixture embedder so CI stays hermetic and keyless; (3) `POST /ask` with intent routing,
    citations and a relevance floor; (4) the ~30 Q/A eval set in CI.

25. **A chunk id is what a citation points at, so ingestion compares before it writes.** The
    obvious implementation — delete a document's chunks and re-insert them — is cheap to write and
    wrong in a way that only appears later: an id replaced on every run cannot be cited by anything
    that outlives the run. So a content hash over every chunk's text, heading and position decides
    whether the document is touched at all, and when it has changed, chunks are upserted on
    `(document_id, ord)` so only the sections that actually changed are rewritten. The hash
    deliberately excludes title, source, uri and licence: correcting a typo in a title must update
    the row without churning ids. The consequence worth knowing is that **re-ingesting an unchanged
    corpus performs no writes at all**, which is what makes it safe to run on every stack start and
    on every file edit.

26. **Definitions and article text never share a namespace, and every query says so.** The
    `namespace` column was in the schema from the start; what was *not* obvious is that every
    statement touching `kb_documents` has to filter on it. A `news` document carries a null
    `concept_slug` by design, so a query that forgets the filter reads ingested articles as
    orphaned concepts — and the ingester's `--prune` would then delete them as a side effect of
    loading definitions. See the bug below; the lesson is that a nullable discriminator is only
    safe if every reader knows about it.

27. **The concept endpoint lives in the AI service, and the orchestrator only proxies.** The corpus
    belongs to the service that owns the schema, the ingester, and — when `/ask` lands — the
    retrieval that will read these same tables. A second reader of `kb_chunks` in another process
    would be a second place that has to agree about section ordering and namespace filtering. It is
    the same argument `app/routers/narration.py` makes in its own docstring for serving the LLM
    configuration from there, and it is why `GET /concepts/:slug` on the orchestrator contains no
    logic but error mapping.

28. **An upstream status is translated, never forwarded.** `upstreamFailure` passes 503 and 504
    through and rewrites everything else to 502. Forwarding blindly looks more honest and is worse:
    a 401 from the AI service means *our* internal key is wrong, and passing it to the browser
    tells the reader their session expired and sends them to log in again over a server
    misconfiguration they cannot affect. A 404 is the one genuine exception and is mapped to a
    named 404, because a corpus nobody has ingested is a real state rather than a fault.

29. **Corpus text is parsed into React elements, never rendered as markdown.** The documents reach
    the browser through two services from a database anyone with a shell can write to, so a
    markdown library would mean either `dangerouslySetInnerHTML` or a sanitiser to maintain.
    `conceptText.ts` understands exactly four constructs — paragraphs, four-space formula blocks,
    `**bold**` and `*italic*` — and anything else degrades to plain text, so no HTML is ever built
    from that text at all. The cost is real and accepted: adding a list or a link to a document
    means changing the parser, and a test over the shipped corpus fails until someone does.

30. **The reranker was moved from slice 2 to slice 3, and the embedding width
    was not guessed.** DESIGN.md specifies "vector + FTS + RRF + rerank", and the
    rerank is the one piece of that sentence that could not be built here: it
    reorders a candidate list, and until slice 4's eval set exists there is no
    way to tell a good reordering from a bad one. A component nothing can
    measure, sitting on the path where being subtly wrong looks exactly like
    being right, is worse than an absent one. **`n` = 1536 is the width of
    `openai/text-embedding-3-small`**, the model the owed migration targets, and
    the migration says so in prose — decision 24 deferred the number so it could
    be chosen on evidence, and a fixture embedder exerts no pressure on it at
    all, which is precisely what makes a convenient guess so easy. 1536 also
    keeps the cheap upgrade open: `text-embedding-3-large` truncates to 1536 via
    the `dimensions` parameter, so moving up later is a re-embed and not a
    migration.

31. **The fixture embedder is lexical rather than random, and that was the
    argument.** Hashing the whole text into a pseudo-random vector is simpler
    and was rejected: random vectors make the vector half of retrieval
    *untestable*, because there is no input for which a correct implementation
    returns a particular row — so the ranking SQL, the fusion and the ordering
    could all be wrong in CI and look exactly like working code. A hashing-trick
    embedder over word tokens has checkable behaviour, so the retrieval path is
    exercised by tests rather than merely executed by them. The honest cost is
    that it correlates with the full-text half, so fusing the two adds less than
    fusing independent rankers would — a property of the placeholder that
    disappears with the real model. It has **no semantic knowledge whatsoever**,
    and every search response says so on the wire (`vector_is_semantic: false`)
    rather than in a log, because a ranking produced by shared words is
    indistinguishable from one produced by understanding.

32. **`/ask` refuses in three different ways, and they are kept apart.** Below the
    relevance floor means the corpus does not cover it; `no_holdings` means the caller
    did not send a portfolio; `not_computable` means the question is outside the short
    list of things arithmetic can answer. Collapsing them would tell someone their
    question was out of scope when the truth was that their portfolio had not loaded —
    the same class of error as a notification that vanishes (decision 18).

33. **The relevance floor has three states because the measurement supported three.**
    Eight in-domain and eight out-of-domain questions separated by **0.0289** of cosine
    (lowest in-domain 0.2498, highest out-of-domain 0.2208). That is enough to tell
    clearly-relevant from clearly-irrelevant and **not enough to draw a line**, so
    between the bounds an answer is given and *labelled weak* rather than a coin-flip
    being reported as a decision. Same instinct as `null` for an unpriced holding: the
    uncertain case gets its own value instead of being rounded into a confident one.
    The floor is on **cosine** and not on the fused RRF score, because RRF is a function
    of how many halves returned a chunk and where — the same number means different
    things for different queries. Cosine is bounded and behaves the same way across
    queries, which is the only property that makes a fixed threshold meaningful.
    **The floor abstains entirely when the embedder is the fixture** (CI's path): those
    similarities measure shared words and are not on the scale the thresholds were
    measured against, so applying it there would refuse or admit at random while looking
    like a considered decision.

34. **A portfolio answer is never written by a model, and the wire says so.**
    `answer_source: "computed"` is arithmetic over what the caller supplied, checked by
    the same evidence validator narration uses. A plausible wrong number about someone's
    money is the worst output this product could produce, and the set of computable
    questions is therefore short, explicit and listed — the `PROPOSABLE_KINDS` argument
    applied to questions.

35. **The eval set is held out from the thresholds, and a test enforces it.** `relevance.py`'s
    numbers were fitted to sixteen questions and the lexical switch to six more. An eval that
    reused any of them would test the thresholds on the data that picked them — which measures
    nothing and looks exactly like a pass. The fitting questions are recorded in
    `data/eval/ask.json` and `test_eval_set_contract.py` fails if a case repeats one (confirmed
    by planting one with different casing and whitespace). The disclosure that goes with it: every
    case was written by the session that had read the whole corpus. Held-out from the thresholds
    is not the same as held-out from the author, and **questions from someone who has never read
    the corpus would be worth more than any number of these**.

36. **At the relevance boundary, the answer hedges instead of the threshold moving.** The first
    keyed run found "what is the current price of gold" (out of domain) at **0.2502** and "why
    does my mix keep changing on its own" (legitimate) at **0.2498**. They overlap; no threshold
    classifies both. Raising the floor would have swapped a wrong answer for a wrong refusal *and*
    turned the held-out set into a training set. So a weak match now opens with
    `WEAK_MATCH_PREFIX` — "I'm not sure the reference corpus covers this. The closest match I
    found is:" — applied by the service from the verdict, never by a model, so whether an answer
    admits uncertainty cannot depend on how a model phrased it. `relevance: weak` had been on the
    wire from the start, but the *text* of a weak answer was identical to a confident one, so a
    reader of the reply alone got no signal at all. Decided by the user, 2026-09-24.

37. **The keyed eval tier is opt-in by the presence of a secret, and skips visibly.** CI stays
    hermetic for anyone without `OPENROUTER_API_KEY` — forks, fresh clones, a spent budget —
    because the job then prints a `::notice` and succeeds, instead of turning every PR red for a
    reason unrelated to the change. A notice rather than silence, because a green job that did
    nothing looks exactly like a green job that tested the refusal path. It is the *only*
    automated test of the `not_in_corpus` refusal, because the floor abstains on the fixture.

38. **The topic eval was written by the user, before the resolver existed, and its second batch was
    sealed.** `data/eval/topics.json`. A contract test fails if a user case differs from what they
    wrote except through a named correction (SQ → XYZ is the only one), and threshold-fitting topics
    are written down *before* measuring and kept disjoint by test. Batch 2 was handed over after the
    first run and not run until slice 2 was final — and it is what showed slice 2 did not
    generalise. **It is now spent**; the file says so.

39. **The universe is screened by rule, never assembled from the answers.** Primary US exchanges,
    stocks ≥ $1B, ETFs ≥ $100M (thematic funds are small); preferred series dropped; one listing
    per company (most traded). All of the user's tickers are in it and none was added by hand — a
    universe built from the eval's answers would make every case a choice among correct answers.

40. **Yahoo's descriptions are not committed; membership, facts and holdings are.** The prose is
    licensed from Yahoo's vendors, so it lives in `data/universe/descriptions.local.jsonl`
    (gitignored) and the database, with a `license` column. Consequence: a fresh machine must run
    the build script (~1 h, rate-limited) before topics can resolve. Holdings are fund composition —
    facts — and are committed.

41. **`instrument_profiles` is its own table, not a third `kb_chunks` namespace.** pgvector's HNSW
    returns at most `ef_search` (40) rows *before* the WHERE clause; 3,600+ instrument vectors in
    the concept index could leave `/ask` with nothing and no error. Same reason
    `search_profiles` raises `hnsw.ef_search` to its LIMIT: otherwise "top 50" silently means 40.

42. **Profiles are embedded with the company's own name removed** (`app/universe/matching_text.py`).
    "fast food" admitted Fastenal and "mount everest" found Everest Group. Stripping moved the
    nothing/something separation on the fitting topics from **0.018 to 0.120**. The stored
    description stays verbatim because rationales quote it; the hash is over the embedded text plus
    a rule version, so changing the rule re-embeds exactly once. Holdings matching uses a
    *stricter* name rule than news (`legal_core` keeps "Group"): the news rule matched Compass
    Group to Compass, Inc.

43. **Similarity decides whether; size decides the order.** Specialists outranked the companies
    people mean (Newmont 15th for "gold mining"). The gate (band + floor + cap 30) is what stops a
    giant climbing a list it barely belongs to. **Rejected with measurements:** a size-scaled gate
    (put NVDA/MSFT at #1–2 for "video game publishers"), query-expansion dictionaries, raising the
    candidate limit, consensus of ≥ 2 source ETFs. The table is in `docs/TOPIC_RESOLUTION.md` §5.

44. **ETF holdings bypass the gate, but only from coherent funds.** A fund is a source if it is near
    the topic *and* its holdings are (mean similarity within 0.13 of the best match). Without the
    second test, broad funds brought Amgen into "gene editing" and Home Depot into "home builders",
    and size ordering put them first. Holdings with weight outside (0, 1] (cash lines, wrappers, one
    reported at 66,880%) are skipped and counted, not stored.

45. **Rationales are quoted, never written; confidence is a band, never a percentage.** The same
    argument as the evidence validator: a model can write a plausible false sentence about a real
    company, and a cosine is not a probability. `held_by` ("SHLD 10.8%") is the second, checkable
    reason.

46. **The resolver stops at 14/35 on held-out topics, and the next step is product, not tuning.**
    The M5 exit criterion is a *confirmed* set. A confirmation screen where the user adds what the
    resolver missed closes the gap regardless of recall; further resolver work needs a new held-out
    batch first, or it can only be measured on data that shaped it.

47. **An unloaded universe is `verdict: unavailable`, never `none`** (`POST /topics/resolve`).
    `none` says the universe was searched and holds nothing about the topic. `unavailable` says
    nothing was searched, and `universe.state` names the missing step. The coverage count runs
    *before* the resolver, because over an empty table `judge(None)` grades the missing evidence
    `weak` with no candidates. A 200, like `/ask`'s refusal, so it is a typed state and not a
    status code a caller can misread.

48. **Confirming re-resolves on the server; the browser never supplies a reason.** A confirm
    sends `{label, symbols}` only. A symbol is stored as `resolver` with its band, quoted rationale
    and `held_by` only if re-resolving the label offers it *now*; otherwise it is a bare `user` row,
    checked through the same instrument lookup as a new holding. The rejected alternative (posting
    back what the browser was shown) lets any client write text the topic card presents as a
    quotation. Consequence, seen live: relabelling "uranium" to "nuclear fuel" turned BWXT into a
    resolver row and CCJ into a user row. That is correct, because provenance belongs to the label
    that was confirmed.

49. **There is no unconfirmed user topic.** A topic exists from the moment its set is confirmed
    (`POST /topics`). DESIGN.md's `confirmed_by_user` flag was dropped: only confirmed instruments
    are stored, because an unticked suggestion kept as a row is data nobody chose. It would also
    need filtering by every later reader (topicScan, the news matcher, the digest). `proposed` exists
    for auto-discovery only. **The cap (10 active topics) is enforced under a lock on the user's
    row**. It was raced live with three simultaneous confirms for one free slot, and exactly one
    won.


50. **A topic observation is one finding about the basket, never a list of member findings.**
    `topic_move` measures the confirmed set as an equal-weighted basket and z-scores its move
    against the same basket's own recent days, reusing `sigma_move`'s thresholds and guards.
    Equal weight because a confirmed set has no weights; market-cap weight would make every topic
    containing a giant a statement about that giant. Two refusals are its own: fewer than
    `TOPIC_MIN_MEMBERS` priced, or less than `TOPIC_MIN_COVERAGE` of the set priced on the session
    (the same floor filters which historical days enter the sample). Both are reported by label in
    `runs.stats.skipped`, and the run is `degraded`. It raises no proposals and carries no news,
    because none is collected (see the debt table). Replayed over 120 real sessions for
    UGA+VLO: 9 findings, all `info`, 0 unsourced figures.

51. **A topic's news is derived through its instruments; no `topic_id` in the news tables**
    (migration 0018, which also settles 0004's deferred promise). Articles and their links are
    shared market data with no `user_id`; a topic is one user's choice, so a key from a shared
    row to a user-owned one would make the corpus per-user by the back door.
    `GET /topics/:id/news` joins `topic_instruments` → `article_entities` → `articles` at read
    time. `topic_ref` stays unused for GDELT's query-found articles that name no instrument.
    The `news_collect` matcher sees held and topic instruments only, never the universe.

52. **GDELT is read from its raw 15-minute files, filtered by headline; the search API is gone.**
    (User's decision, 2026-09-27, after a day of measurements.) The DOC search API refused most
    requests (load-shedding; no retry schedule got through reliably), and the one batch that got
    through was mostly noise: it matches a name anywhere in the body but returns only the headline,
    so 68 of 77 stored articles named nothing followed, and titles came back re-spaced ("U . S .").
    `app/news/gdelt.py` now downloads each slot's GKG file
    (`data.gdeltproject.org/gdeltv2/YYYYMMDDHHMMSS.gkg.csv.zip`, ~3 MB, several hundred English
    articles; answered in 0.6 s while the API refused) and keeps a row only when its
    `<PAGE_TITLE>` names a followed instrument by the matcher's own spellings (`names`) -
    **headline-only, by the user's decision**: GKG's organisation list would find more, but the
    headline shown and read for themes would then not mention what it was kept for. The headline
    is still the body, and `published_at` is the slot time. **Which files: a cursor**
    (`news_feed_cursors`, migration 0020), written in the collection's transaction so a file is
    marked read only if its articles are stored; oldest first, at most 16 files a run, 2 hours
    back when there is no cursor, never older than the run's `since`. A 404 within 45 minutes of
    its slot is late (stop, retry next run); later, it is missing (counted, passed over).
    Rejected: no cursor and re-reading the last hour each run (double the downloads; an outage
    longer than the overlap loses news silently). A failure partway still raises with the files
    read so far on `NewsProviderError.partial`. **Deleted with the API:** request spacing, the
    8-name OR batching, `query_terms`, the 10 s / 30 s retries, the throttle-sentence parsing.

53. **A topic's sentiment is a magnitude-weighted mean from one model, or a null with a reason.**
    `GET /topics/:id/sentiment` (FR-12), computed in `services/topicSentiment.ts` from rows the SQL
    returns unaggregated, so the arithmetic is unit-tested and the article set is exactly
    `/news`'s. Weighted because a lexicon score is a balance: one "record" scores +1 like an article
    of nothing but good news, and a headline with no polar words expressed no tone rather than a
    neutral one, so it gets no weight. **Never a 0 for "unknown"**: `gap` is `no_articles`,
    `not_scored` or `too_few_polarised` (< 3). Scores from different models are never averaged
    together (`lexicon-v1` is comparable only with itself); others are named in `otherModels`.
    Days bucket in the user's timezone. Computed at read time rather than stored, because a
    stored per-topic score would be per-user derived data that goes stale the moment a late article
    arrives; a sentiment *observation* (a shift worth announcing) is the digest slice's decision.

54. **The digest's topic section quotes headlines, keeps three states apart, and never makes a quiet
    day loud.** `services/topicDigest.ts`. A topic move is quoted by its stored headline (already
    evidence-checked), never re-rendered. "No unusual move" is said only of a topic the last
    `topic_scan` measured; a topic in that run's `stats.skipped` is "not measured (reason)", and one
    confirmed after the run is "not scanned yet". The section exists only when some topic moved or
    had an article *today* (user's timezone); a day on which every topic was quiet still sends no
    digest, which was the existing rule and is kept - a daily "all quiet" message trains the user
    to mute the channel. The deferred entries' all-or-nothing settlement is unchanged; the topic
    section has nothing to settle.

55. **Auto-discovery proposes from phrases recurring in headlines, filtered before it is resolved.**
    `app/topics/discovery.py` finds 1-3-word phrases in at least 3 distinct **stories** from at least
    2 outlets over 7 days (`POST /topics/discover`, reads only, no embedding), reading **only
    headlines linked to a followed instrument**. Both were added after the first real headlines
    (2026-09-27): counted by article, one AI-safety wire story republished by three outlets under
    slightly different headlines made "alarm", "controlled" and "openai sound" themes; and 68 of
    77 stored articles linked to nothing (the search API matches body text) and read as themes
    they were noise ("fiber" from a recipe). Headlines are one story when 80% of the shorter one's
    words, followed names excluded, are in the longer one; phrases found in exactly the same
    stories are one candidate, and so are wordings nested in each other when the longer is in at
    least `VARIANT_SHARE` (0.75) of the shorter's stories - transitively, so "open agent safety"
    and "agent safety platform" join through "agent safety". 0.75 sits in a measured gap
    (2026-09-29 headlines: rewordings of one story at 0.75-0.92, a word with a life of its own at
    0.71 and below); before it, one Nvidia launch took 7 of the 8 resolve slots. Followed instruments'
    names are cut out of each headline *before* phrases are built, or "NuScale Power" would count
    towards "power". The orchestrator (`services/topicDiscovery.ts`, run kind `topic_discovery`,
    daily) drops phrases matching a known theme **by words first**, then resolves at most 8
    through the ordinary `/topics/resolve`, proposes only a `confident` verdict with at least 2
    confident instruments, and checks **instruments** after. Filtering before resolving is not a
    cost trick only: a rejected theme recurring daily at the top of the list would otherwise hold
    a resolve slot forever. At most 3 proposals open at once, counted under the topic-cap lock.
    A proposal is a question, not a subscription: not scanned, no news, not counted against the
    cap; accepted through `PUT /topics/:id` with nothing pre-ticked. **Limit, stated rather than
    hidden:** news is collected only for followed instruments (decision 51), so discovery finds
    themes *next to* the user's interests, never in a corner of the market they never looked at.

56. **Rejection memory: words OR instruments, inside a cooldown - and the instruments are every
    candidate offered, not the confident few.** Matching is `services/topicMatching.ts`: suppressed
    if every word of the known label is in the new one (case, plurals, filler ignored; one-way, so
    "energy" is not blocked by a rejected "nuclear energy"), or if at least half of the new
    proposal's instruments are in the known set. The same rule decides "already followed" and
    "already pending", so those can never disagree with "rejected". **Cooldown, not forever**, by
    the user's decision on 2026-09-27: `TOPIC_REJECTION_COOLDOWN_DAYS` (default 90). This amends
    MILESTONES' exit criterion; the rejected row is kept after the window (decision 18). The
    fingerprint is frozen on the row at proposal time (`match_words`, `proposed_instruments`,
    migration 0019), so a universe change cannot un-reject anything. **Measured on the real
    resolver before merging:** confident sets are 2-4 instruments and "nuclear fuel" shared *none*
    with "uranium"; over every offered candidate it shares 57% and "uranium miners" 100%, while
    "data centre" and "lithium" share 0%. The first version fingerprinted confident candidates only
    and would have let "nuclear fuel" straight back. "nuclear energy" sits exactly at 50% and is
    suppressed - the rule errs towards suppressing, because showing a rejected theme again is the
    failure memory exists to prevent, and a missed suggestion is the cheap one.

57. **An unanswered proposal expires into its own status, not a deletion and not a rejection.**
    Migration 0021, `expireProposals`. Without it, three ignored proposals held every slot and
    stopped discovery for good. After `TOPIC_PROPOSAL_TTL_DAYS` (default 14; it and the 7-day hold approved by the user
    on 2026-09-28 as defaults, not measured) the
    row becomes `expired` with `expired_at`: kept for decision 18's reason, and not `rejected`
    because silence is not a "no". An expired theme is held back for **one discovery window**
    (`EXPIRED_HOLD_DAYS`), so it can return, but only on headlines that all postdate the silence -
    never the next morning. **The sweep runs only at the start of a discovery run**, before the
    no-headlines early return, rather than on every read as proposals' expiry does (decision 16):
    here a past-deadline proposal that is still visible is harmless (accepting it is the user
    choosing a topic), and the slot only matters to discovery. Every reader filters on
    `LIVE_TOPIC` (`status IN ('active','proposed')`) rather than excluding one dead status, so a
    third cannot leak into a list. The downgrade turns expired rows into rejections, which errs
    towards suppressing; its first version failed over a real expired row because the UPDATE ran
    while the new CHECK still existed - the constraint-meets-data lesson again, found by running
    it with a row present.
58. **Narration's state is a ledger of transitions, judged over the last three explanations, and only
    the model/template boundary is announced.** `services/narrationWatch.ts`, migration 0022.
    `GET /narration` recomputes the state per read, which cannot say what *changed*, so
    `narration_transitions` stores a row only when the state differs from the last one; its newest
    row is the current state, the first row (`from_state` null) is a baseline, **announced only
    when it is a break** (amended 2026-10-14: until then no baseline was announced, and an outage
    already under way when the first row was written - OpenRouter refusing narration's reasoning
    setting, 10-07..14 - became the baseline and was found a week later in `llm_calls`; a working
    or deliberately `off` first state is still silent), and a lock on the user's row stops a portfolio and a topic
    scan finishing together from both recording it (raced live: one row). **Judged over
    `NARRATION_WINDOW` = 3 explanations across scans, not one scan:** replayed over this
    installation's history 2026-09-17..28, a per-scan rule announced a break fifteen minutes after
    a recovery, over two refused sentences; the window gives two breaks in five days, both real
    streaks. **A break is `high` and pushes; a recovery or `off` is `info` and waits for the
    digest** (the user's decision, 2026-09-28). A move between two template states
    (`unavailable` -> `rejected`) is recorded and not announced. Delivered through `fanOut` with
    `ref_kind = 'narration'`, so quiet hours, a mute and the dedupe key apply unchanged; the digest
    names where explanations ended rather than counting the notice as a finding. The badge and the
    notice can disagree for a scan: the badge reads the latest scan, the notice the window.

59. **A phrase that is one company's news is not a theme, and is not resolved.** The AI service
    reports each phrase's lead instrument and how many of its articles link to it
    (`lead_instrument`, `lead_instrument_articles` on `/topics/discover`) and judges nothing; the
    orchestrator drops a phrase at `SINGLE_INSTRUMENT_SHARE` (0.75) or more, *after* rejection
    memory (so a rejected theme still says "rejected", which the exit check reads) and *before*
    the resolve budget. The reason names it: "100% of its headlines are NVDA news". **Measured
    before building** (2026-09-29, 648 headlines, 12 followed instruments; the feed was NVDA 35%,
    AAPL 34%, BTC-USD 14%, MSFT 12%): multi-word phrases' lead shares ran 0.60, 0.67 (x4), then
    0.80 and up, 49 of 58 at 1.0, and all ten top-ranked phrases were NVDA or AAPL news. The gap is
    real but thin - everything under it had 3-5 articles, one about another company. **Drop, not
    rank-last, by the user's decision:** on that data both spent the budget identically (170
    single words sit below the bar), and only drop records the true reason. Nothing that survived
    was a real theme, which is the source's limit (decision 51), not the rule's. **Built to outlive
    that limit:** articles linked to no followed instrument count in the denominator, so when a
    market/sector feed arrives (planned by the user, with the UI split into "Portfolio Impact" and
    "New Opportunities") a real theme reads as spread and only the headline loader changes.
    `nasdaq`, `us`, `release(s)` went into `GENERIC_WORDS` in the same PR. **Found after
    agreeing on drop, and corrected in the same PR:** the orchestrator asked for only the top 20
    phrases, and 19 of them were company news - the run would have resolved one phrase and left
    seven slots unused. `PHRASES_REQUESTED` is now 100 (the service's maximum; asking costs no
    embedding). The lesson: simulate the whole pipeline, including the caps before a filter, not
    only the filter.

60. **A market feed rides on the same GDELT files, for discovery only.** `app/news/market_feed.py`,
    migration 0023 (`articles.feed` = `followed` | `market`). A row is market news when GDELT
    tagged it with a market theme (`MARKET_TAGS`, column 8) **and** its headline uses market
    vocabulary (`MARKET_WORDS`/`MARKET_PHRASES`); either alone was too wide (law-firm releases;
    "MasterChef star shares"). Decided with the user 2026-09-29, each measured read-only on raw
    GKG files first (three 24 h samples, then every slot of 2026-09-22..29):
    - **Volume:** ~4,000/day averaged over a week (5,400-5,600 on weekdays, 1,600-2,000 on
      weekend days) of GDELT's ~112k; one download serves both filters, so the cursor stays one.
    - **Outlets named, not detected:** `TICKER_NETWORKS` (88-95% of headlines carry "(TICK)";
      the next real newsroom, seekingalpha, is 0.63-0.77 - too thin a gap to automate) and
      `PRESS_RELEASE_WIRES` (their "class action" releases topped the list once the networks were
      out). Constants, not a table: a change is a reviewed PR with a measurement, like
      `GENERIC_WORDS`. Each `news_collect` run reports `suspected_networks` (unlisted outlet, 20+
      market headlines in a day, 0.85+ templated); it found `financialcontent.com` on its first
      data, which was then listed. The exclusion applies to the market filter only: a followed
      name in a network headline is still collected, as before.
    - **An unlinked market article reaches discovery and nothing else**, by construction: topic
      news, sentiment and evidence all join through `article_entities`. `feed` exists because 553
      old unlinked rows (the search API's noise, decision 55) must stay out of discovery.
    - **Retention = discovery window + proposal lifetime** (21 days), derived in
      `marketRetentionDays` and sent by the orchestrator, so every headline behind an open
      proposal is still readable. Only unlinked market rows are pruned. Size was not the reason
      (~110 MB at 30 days is nothing to Postgres here).
    - **Window stays 7 days.** 1-, 3- and 7-day windows found the same core themes; a 1-day
      Saturday run put "crore ipo" and "files draft papers" in its top 8. 7 days cost 69 s until
      #83 indexed discovery (2.8 s, identical output) - it would have timed out at the
      orchestrator's 30 s.
    - **No US-only filter at ingestion:** it lost "crude oil" (mostly non-US outlets) from the top
      8. Local news is left to a discovery-side rule (next PR: one non-US country's outlets at
      0.75+ of a phrase's articles is that country's news, mirroring decision 59).
    - **Portfolio Impact vs New Opportunities is derived at read time** (an article is Portfolio
      Impact for a user when linked to what they follow), so `feed` is the only stored
      distinction. The screen is M6.
    Result on the committed filter: the resolver returns `confident` for "data center" (DLR,
    APLD, CIFR...), "bond yields", "mortgage rates" and "crude oil". **Limit:** `news_collect`
    still skips when the user follows nothing, so the market feed stops with it.
    **Live after #84 (2026-09-29):** the first collection stored 151 market articles (none from an
    excluded outlet), and the first discovery run over them proposed **"data center"** (DLR,
    APLD, CIFR, GDS, CORZ, KEEL, BXDC) and **"bond yields"** - M5's exit criterion, first half -
    and one false "launches ai" (one Nvidia launch plus one other company's; newsroom verbs went
    into `GENERIC_WORDS` in the next PR). The false proposal was left for the user to answer.

61. **One foreign country's press is local news, not a theme.** The AI service reports each
    phrase's `lead_country` (the outlet's home country, from GDELT's own table committed as
    `data/outlets/countries.tsv.gz`, 2018, 98% coverage of feed rows) and judges nothing; the
    orchestrator drops a phrase at `SINGLE_COUNTRY_SHARE` (0.75) unless the country is
    `HOME_COUNTRY` ('US': the user trades US listings only, stated 2026-09-29), after the
    one-company rule and before the resolve budget. **The outlet's country, not the article's:**
    GDELT's per-article locations name places a story mentions, so oil-and-Iran stories are
    "Iran" wherever published. **Measured** over the week's top 100 phrases: local ones 0.78 and
    up (Indian IPOs, "sensex nifty" 0.97, RBA "cash rate" 0.95), then 0.67, and global
    commodities far below ("brent crude" 0.52, "gold silver" 0.51) - so crude and gold stay even
    though Indian outlets carry most of them. It frees 17 of the week's top 100; on the live
    window it drops exactly "cash rate", "reserve bank rate" and "fourth hike". **Rejected:** a
    US-only filter at ingestion (loses "crude oil"), and per-article country (above). Unlisted
    outlets count against the lead, which errs towards keeping a phrase.

62. **Weak proposals: their own band, their own cap, hidden until asked for.** Migration 0024
    (`topics.proposal_band`, required on every auto-proposal, kept after it is answered),
    `proposalVerdict` in `services/topicDiscovery.ts`, the "Show N weak matches" toggle on the
    Topics page. Decided by the user 2026-09-29: a weak proposal needs
    `MIN_WEAK_PROPOSAL_INSTRUMENTS` = 3 candidates (one more than a confident one's 2, because
    each is less evidence), and `MAX_OPEN_WEAK_PROPOSALS` (3) is separate from
    `MAX_OPEN_PROPOSALS` - a shared cap would let three weak ones block every confident one,
    the failure decision 57 fixed. **Also weak, by Claude's recommendation when the user said
    to continue without answering:** a `confident` verdict with fewer than 2 confident
    instruments but 3+ offered ("treasury yields": GOVI, then six weak) - otherwise it fell
    between the rules and was proposed nowhere. A weak proposal shows every candidate offered;
    a confident one only the confident. Rejection memory, expiry and the words/instruments
    match ignore the band, so a rejected weak theme is remembered exactly as a confident one.
    A band is judged only after resolving, so the run stops early only when **both** caps are
    full, and a phrase whose band has no room says so ("no open weak proposal slot left").

63. **The validator accepts a `_minor` figure only in its major form** (#89). It used to accept the
    raw integer too, so "fell to 4016 from a high of 4750" passed for a $40.16 price. Measured
    over every stored model narration: **4 of 11** carried cents as dollars, all approved. **The
    4 stored rows were rewritten by the templates** (`narration_source='template'`,
    `fallback_reason='unsourced_figures'` - what the validator would have done at the time),
    decided by Claude under the user's M6 delegation: leaving them kept hundredfold-wrong figures
    on the dashboard, and withdrawing them would have hidden real findings. Notifications already
    sent with those texts cannot be recalled.

64. **Server state lives in TanStack Query; MobX reads it through `CacheMirror`, never a copy.**
    `apps/web/src/queries/`: `queryClient.ts` (30 s stale time; retries only a network error or a
    5xx, at most 2 - a 4xx is an answer), `queryKeys.ts` (every key, once), one module per
    resource with its `queryOptions` and mutations. A write invalidates the query it changed
    rather than patching the cached response, because totals, weights and FX are the server's
    arithmetic. `RootStore` owns the client, so a store can invalidate (`ImportStore`) and
    sign-out `clear()`s it - cleared, not invalidated, which would refetch as nobody and keep the
    last account's numbers up until it failed. **`CacheMirror` exists for stores whose client logic
    is computed from server state** (`TargetsStore.rows` compares the draft with held weights): a
    MobX-observable, read-only view of one cache entry. It subscribes to the **query cache**, not a
    `QueryObserver`, because `clear()` removes the query object itself and an observer stays bound
    to the removed one - it would never see the next account's portfolio
    (`serverState.test.ts` pins this). A component's hook is still what fetches. Rejected: copying
    the response into the store (the exact debt being removed), and passing the portfolio into
    every `TargetsStore` getter (eight getters, and every caller would have to remember to).
    **Decisions on proposals stay in `ProposalsStore`** (the list does not): a decision needs a
    synchronous one-per-proposal guard - a double click lands before the re-render, so a
    per-card `useMutation` cannot give it - and an in-flight label two card components share.
    `decide()` cancels a read in flight, posts, writes the *server's* answer into the cache, and
    re-reads after every decision (the old store re-read only after an approve). **Gotcha that
    cost a test run:** a *function* `refetchInterval` is evaluated only when the query updates, so
    "pause while deciding" silently did nothing; `useProposalsQuery` reads the in-flight count
    during render and must be called from an `observer` (`inboxRefresh.test.tsx`). **Deliberate
    change:** TanStack skips interval re-reads while the page is hidden and re-reads on return;
    the old store polled a hidden tab. The in-app browser pane counts as hidden when not in
    front, so an interval cannot be observed there - it is pinned by that test instead.
    **Forms keep only their edits.** `SettingsStore.edits` and `TargetsStore.edits` hold what was
    typed; `saved` is a `CacheMirror` read, and the form shows edit-or-saved. So a background
    re-read never overwrites a half-typed form, Discard is "drop the edits", and a save writes
    the server's response into the cache. `PUT /targets` returns no names, so the save merges the
    known names into the cached set rather than blanking them.
    **Topics and concepts closed it.** Topics are keyed per topic (`['topics', id, 'news']`...), which
    replaced the store's hand-written "drop a late answer for another topic" check; `TopicsStore`
    keeps `openTopicId`, the composer and the weak toggle, and reads the list through
    `topicsCache` because the composer's cap rules need it. Concepts are a query with
    `staleTime: Infinity` (a definition does not move with the market) that resolves a 404 as
    `null` - "not ingested here" is a state, never retried, never an error.

65. **Every view has an address: TanStack Router, routes in code** (`apps/web/src/router.tsx`). The
    user chose TanStack Router or React Router, Claude's pick (2026-09-29): TanStack Router, because
    it sits beside TanStack Query and is typed end to end. **Code-based routes, not file-based**: six
    routes do not need the Vite plugin's build step, and one file shows them all. `NavigationStore`
    is gone - the URL is the navigation state. The router renders only once the session is known,
    so a signed-out visit to `/settings` shows sign-in *at* `/settings` and lands there after. An
    unknown path renders the portfolio. Header and "Back" controls are `<Link>`s styled by
    `buttonClass()`, so they are real anchors (new tab, read as links). Both web servers already
    fall back to `index.html` - Vite in dev, nginx `try_files` in the prod image - so a reload deep
    in the app is served. **FR-21's link:** Telegram refuses a `127.0.0.1` URL button, so PR 9 added
    `/proposals/:id` and an optional `WEB_BASE_URL` (decision 69); it stays unset until M7 gives a
    public https address, and then messages carry the link. Tests render
    pages with `renderPage()` (a one-route router) because a page with a `Link` needs one.

66. **The equity curve draws stored snapshots only** (the user's decision, 2026-09-29):
    `lib/equityCurve.ts` makes one point per calendar day between the first and last snapshot,
    and a day with none is a gap, never interpolated or synthesised from quotes (which would be
    "today's holdings, backdated", not the account's history). A degraded snapshot is drawn hollow
    and named in the caption and tooltip, not hidden. Two series on one money axis: value in the
    accent `#6d8bff`, cost basis in olive `#8f9b2f` *and* dashed - the pair passed every check of
    the dataviz palette validator against the card surface `#131a2e`, where the app's grey failed
    (reads as no data) and its green/red are reserved for gain/loss. Every point has a dot,
    because a day between two gaps is otherwise a zero-length line. A table view carries the same
    figures. The data as of 2026-09-29: 9 snapshots over 16 days; the 14 Sep one is degraded
    (0 of 0 priced, yet a total), and value jumps 30% on 16 Sep, most likely real prices arriving
    (M2.5) - drawn as stored.

67. **A fixture price never stands in for a real one** (`app/providers/price_provenance.py`, found
    2026-09-29 while measuring history for the holding page). This machine's `.env` chain is
    `yfinance,fixture`, so whenever Yahoo failed the fixture provider answered - and the backfill
    stored its constant prices among real closes: 31 NVDA rows and 17 SAP.DE rows, e.g. $134.08 on
    Sat 12 Sep between real ~$218 closes. **On 2026-09-23 the drawdown rule reported "NVDA is -48.6%
    from its 30-day high" (high severity) from a fixture $118.45**; its Telegram send failed, so it
    was never pushed, but it is in the feed. Guideline 7 says an unavailable price is null. Now: a
    chain that does not *start* with `fixture` is a real installation, and it (a) never builds the
    fixture provider (`admissible_chain`, logged `providers.fixture_fallback_dropped` at startup),
    and (b) never reads stored fixture rows (`excluded_price_sources` -> `load_price_series`). A
    demo chain (`fixture,...`, `.env.example`, CI) is unchanged. The 48 rows were **filtered, not
    deleted**. The false finding and its failed notification row were **deleted at the user's
    request (2026-09-30)**, after #96 was live, and a manual `portfolio_scan` confirmed it did not
    return. Redis was checked: no fixture quote was cached.

68. **A holding's chart draws the rules' own series** (`/holdings/$holdingId`, PR 8, 2026-09-30).
    `GET /market/history/{instrument_id}` on the AI service returns `load_daily_closes` =
    `load_price_series` (fixture rows excluded, bounded above by now) + `normalise`; the orchestrator's
    `GET /holdings/:id/history` checks the holding is the user's and passes it through. Rejected:
    SQL in `queries.ts`, which would have been a second definition of "a day's close" and of "which
    sources are real", and the orchestrator does not know the provider chain. So the line a reader
    sees is the series a finding was computed from, by construction. Chart rules (`lib/priceChart.ts`):
    closed-market days are not gaps - a break only where closes are more than `MAX_CLOSED_DAYS` (5)
    apart, measured max was 4 (5 once on XETRA); today's point is labelled "so far today", because
    before the close it is the latest observation, not a close; the cost-per-unit line (olive, dashed,
    decision 66's pair) is drawn only when it falls inside the price range, else the legend says
    "below/above this range" - stretching the axis to NVDA's $98.75 under a $227 price flattened
    every move. Position figures are the cached portfolio row (no second request, so the page and
    the dashboard cannot disagree); findings come from `/observations?symbol=`, which matches both
    `instrument:X` and `portfolio:allocation:X`; news is `GET /holdings/:id/news`, newest 20 of the
    week with `total` ("newest 20 of 333") and the collection state, each article saying how it was
    matched ("matched by name “Nvidia”") because a name match is weaker evidence than a ticker.
    A stale link renders "No such holding" and asks for none of the three.

69. **The inbox shows every outcome, and each proposal has an address** (PR 9, 2026-09-30).
    `GET /proposals?state=history` lists approved, rejected **and expired**, newest decision
    first (20); "Just approved" above it holds only approvals Undo can still reach, and one moves to
    the history when its window closes. `/proposals/$proposalId` reads the unused `GET /proposals/:id`:
    an open proposal is decided there through the same `ProposalsStore` (one guard, one refusal
    path), a decided one shows its outcome, evidence and **audit trail in words**, and a 404 is
    "No such proposal" (resolved as `null`, never retried). Evidence goes through `readEvidence`
    (`EvidenceDrawer`, always open, before the buttons) instead of raw keys. **Weights are now a
    `share` unit - unsigned** ("Actual 35.16%", not "+35.16%", which read as a move); `drift` and
    `*_pct` stay signed changes; `target_weight_sum` is "All targets together". Outcome badges are
    accent / warn / muted, never green and red (decision 66 reserves those for gain and loss).
    **An expiry is dated by its deadline (`expiresAt`), never by `decidedAt`**: that is when the
    sweep recorded it, and measured over the 12 expired proposals the lag had a **median of 52 h**
    and a maximum of 4 d 15 h, because the sweep runs only while the stack is up. The trail says
    "recorded after its deadline passed" for the same reason. **FR-21:** optional `WEB_BASE_URL`
    adds an "Open in app" URL row to every Telegram proposal keyboard, decided ones included (the
    page is where the trail is). Only a public https origin is used (`proposalLinkBase`): Telegram
    refuses the *whole message* over an `http://` or private-host URL button, so a bad value is
    dropped with one startup warning rather than failing every alert. Unset here until M7.

70. **`/ask` has a screen, and every kind of reply looks different** (PR 10, queue task 6).
    `/ask`: a question box (Enter sends), three example questions that fill it but never send, and
    this session's questions newest first in `AskStore` - a reply is a one-off action's answer
    (decision 64's exception), not a resource to re-read, and re-asking can cost a minute. One
    question at a time. Kept apart on screen (decisions 32, 36): an answer; **a weak match**, with
    a page-level banner and the relevance score as well as the service's own hedge in the text; a
    computed answer with its figures (`EvidenceDrawer`); and **four refusals, each titled** -
    "Not in the reference corpus" (with the closest score), "No holdings to compute from" (with a
    way to add them), "No personal investment advice", "Not something I can compute" (with what
    can be) - and an unknown reason named as unknown, never folded into one of those. A failure to
    get any reply is an error with a retry, never a refusal. Every answer says who wrote it:
    quoted passages, a model's paragraph checked against them, or arithmetic no model touched -
    and, when a model's draft was set aside, why (`askPresentation.ts`). The "matched on shared
    words" note shows only for a concept answer on the fixture embedder; a portfolio answer
    searched nothing. Passages are shown verbatim through `ConceptText` (the corpus's markdown
    subset parsed into elements, now shared with the concept dialog). **The wait is part of the
    design:** the free route takes 18-69 s, so the waiting line counts seconds and says a model
    may take a minute or more. `readEvidence` reads a bare `weight` key as a share.

71. **The feed is a page, filtered in the address** (PR 11, 2026-09-30). `GET /observations` takes
    `severity` (at least: `notable` = notable and high), `symbol`, `before` (a cursor) and `limit`,
    and returns `total` (the filter's count) and `nextCursor` (null when there is no more - said by
    the server, from one row more than a page, never guessed from a short page). **The cursor is the
    id of the last finding shown**, and the next page continues after that row's `(created_at,
    severity rank, id)`, looked up in SQL: a timestamp cursor would fail, because `created_at` has
    microseconds a JavaScript `Date` drops and one scan's findings differ only there. **Ordering
    fix:** the tie-break was `severity DESC` on the *text*, so every multi-finding scan listed its
    high finding **last** ("notable" > "info" > "high") - measured on every tied scan in the data;
    now a rank CASE on `SEVERITY_RANK`'s scale (`notificationPolicy.ts`). The dashboard shows 10
    (`FEED_PAGE_SIZE`) with "Show N more"; filters live in its URL (`/?severity=high&symbol=NVDA`,
    `replace: true` - a filter is a view, not a place for Back), read loosely with `useSearch({
    strict: false })` and validated by `feedFiltersFrom`, because the same page renders for unknown
    addresses. A filter that matches nothing says so ("No findings match these filters"), never
    "Nothing to report". Refresh invalidates every filtered view (`['observations']` prefix).
    Measured effect: the dashboard **9,557 -> 3,284 px** at 1280 and **13,727 -> 5,043 px** at 375.

72. **On a phone the holdings are cards, chosen in JavaScript** (PR 12, 2026-09-30). Measured
    first, every page at 375 px: nothing overflowed the page, and only the dashboard had a problem -
    the holdings table was **880 px inside a 341 px box** (symbol, quantity and half a price
    visible) with **16 px** edit/remove icons, and the four summary cards stacked to ~390 px. Now
    `useNarrowViewport()` (`lib/viewport.ts`, Tailwind's `sm`) renders `HoldingCard`s below 640 px:
    value and P&L first, then quantity x price, today, weight and price age, then **40 px**
    "Quantity" and "Remove" buttons sharing `useHoldingEditor` with the table row, so the two cannot
    differ in what Save or Remove does. **Rejected: render both and hide one with CSS** - every
    holding twice in the DOM, and jsdom applies no Tailwind, so tests would find two of every link.
    Without `matchMedia` (jsdom) the answer is "not narrow" - the desktop layout the older tests
    describe; `holdingsNarrow.test.tsx` stubs it (and deletes it after, or every later test is a
    phone). Summary cards are 2x2 at every width below `lg`, the percentage on its own line.
    Measured after: summary 390 -> 192 px; the dashboard is **5,679 px** at 375 (5,043 before -
    readable cards are taller than a sideways-scrolling strip, deliberately); 1280 unchanged.

73. **Every time is shown in the user's timezone, with the zone named** (PR 13, 2026-09-30).
    `formatExactTime` printed `toLocaleString()` - the browser's zone and US order ("9/28/2026,
    1:18:01 PM"), right on this Mac only because it sits in Asia/Jerusalem. Now `relativeTime.ts`
    holds a display zone set from the signed-in user's `timezone` by a MobX **reaction** in
    `AuthStore` (so a direct assignment - which tests do - also sets it; sign-out falls back to
    UTC, which is *named*), and formats `en-GB`, day first, 24-hour, `timeZoneName: 'short'`:
    "28 Sept 2026, 13:18:01 GMT+3". Four stray `toLocale*` calls now use it (`formatClockTime`
    for "saved 13:18"). Module state rather than a React context: thirty call sites, none
    otherwise a component concern, and the router renders nothing until the session is known.
    Calendar dates (equity curve, price chart) stay UTC-formatted on purpose - a date is not an
    instant. Settings gained a read-only **Account** card (base currency USD, fixed; the
    timezone and what "today" means - quiet hours, digest and snapshots all use `users.timezone`,
    checked). The severity table now says **default** bands: `severityScale.ts` restates the AI
    service's defaults and cannot see an operator's retuning (checked equal to `config.py`, and
    this `.env` overrides none). **The disclaimer was already on all nine pages** - that part of
    the planned PR needed nothing.

74. **The daily digest has a place in the UI** (found by M6's exit check, 2026-09-30). FR-13
    says the digest goes "to UI and Telegram"; only Telegram had it. **Rejected: counting the
    dashboard and Topics page as the digest** - they show its content, but not what was *held
    back* from an interruption and why, which is the digest's point. A digest is not stored as a
    message: it is the `notifications` rows (`channel = 'digest'`) one daily run settles as
    `sent`, measured to land within 0.06 s of each other - so `GET /notifications/digest`
    returns the pending rows (the next digest) and the rows sent within a minute of the latest
    `sent_at` (the last one), each joined to its finding. `DigestCard` on the dashboard says
    "Next digest: 2 findings - 1 held during quiet hours, 1 below your alert threshold", lists up
    to five, and folds the last delivered digest under its time. Reason wording is the Telegram
    digest's own (`summariseDigest`), so both surfaces say it the same way. A narration notice
    rides in a digest but is not counted as a finding (as in Telegram).

75. **Kubernetes manifests are plain YAML with Kustomize: a cluster-agnostic `base/` and a kind
    `overlays/kind/`** (M7, user's choice among recommendations). **Rejected: Helm** - a template
    language and a second tool, for a user learning Kubernetes; `kubectl kustomize` prints exactly
    what is applied. The ConfigMap and Secret are *generated* with a content hash in the name, so
    a changed setting rolls every pod that reads it (a pod reads its environment once). **The
    Secret is declared, empty, in the base and merged by the overlay**: Kustomize rewrites
    references to a hash-suffixed name only for generators at or below the resources using them,
    so declared only in the overlay every pod looked for `traders-secrets` while the Secret was
    `traders-secrets-<hash>` (seen by rendering, before any deploy). Image tags are not in any
    committed file: `k8s-up.sh` writes a git-ignored `infra/k8s/.deploy/kustomization.yaml` per
    deploy (Kustomize refuses absolute resource paths, so it must sit inside the repo).

76. **Ordering in the cluster is a check each pod makes, not a sequence the deploy enforces.**
    Kubernetes has no `depends_on`. `migrate` waits for `pg_isready` in an init container; the
    loaders *and both services* wait in an init container running `scripts/wait_for_schema.py`,
    which passes only when the database is at exactly this image's Alembic head(s)
    (`app/schema_revision.py`) and names a database *ahead* of the image rather than waiting
    silently. **Rejected: relying on the Job finishing first** - a pod restarted a week later
    never saw that Job. The orchestrator's image has no Alembic, so its init container borrows
    the AI service's image. Jobs are deleted and re-created on every deploy (their pod template
    is immutable, and "once per deploy" is what compose's one-shot containers meant).

77. **Readiness gates on a service's own store only; the body reports everything else** (#111).
    A probe reads only the status code. The AI service's `/readyz` answered 200 with "degraded"
    in the body - a probe that could never fail - and now answers 503 without Redis. The
    orchestrator's answered 503 whenever the AI service was down, which in a cluster takes the
    whole API out of rotation (sign-in, every stored page) during an AI outage; it now answers 503
    only without Postgres and reports the AI service in the body. Its AI check has its own
    `HEALTH_TIMEOUT_MS` (2 s) instead of the client's 30 s, or a *hung* AI service would time out
    the orchestrator's probe and bring the cascade back. Liveness is `/healthz` everywhere, which
    depends on nothing: restarting never fixes a dependency. Seen live: Redis stopped -> AI pod
    not-ready with 0 restarts, its Service empty, orchestrator ready and `degraded`; both
    recovered alone. The orchestrator's Deployment is `strategy: Recreate` - two overlapping
    copies would split the in-memory import previews.

78. **One origin: the web image's nginx serves the page and forwards `/api/*` to the
    orchestrator, prefix removed; `/api/internal/*` is 404 there** (#109, #111). A prefix is
    required - `/holdings`, `/proposals`, `/topics`, `/ask`, `/settings` are both pages and API
    routes. The bundle is built with `VITE_API_BASE_URL=/api` (relative, so one image works at
    any address). nginx's 60 s read timeout and 1 MiB body limit are raised (330 s over
    `SCAN_TIMEOUT_MS`; 3 MiB over the 2 MiB import). `/internal/*` is reached by CronJobs at the
    orchestrator Service inside the cluster, never through the front door.
    `scripts/check-web-image.sh` checks each of these in CI.

79. **The cluster shares nothing with the compose stack, and needs no `.env`** (#110, #111). Its
    Secret comes from `infra/k8s/overlays/kind/secrets.env`, generated on the first
    `k8s-up.sh` (random keys, random DB password, **its own passphrase**, printed once) and never
    rewritten: Postgres reads its password only when it creates the data directory. Its settings
    are keyless (`base/config.env`: Yahoo prices, fixture news and embeddings, templates,
    Telegram off, `SCHEDULER_ENABLED=false`), so a stranger needs no key, and GDELT is not
    downloaded twice while compose runs. `enableServiceLinks: false` on every pod (one Kustomize
    patch per pod-spec depth): Kubernetes' Docker-links variables turned the Service `ai-service`
    into `AI_SERVICE_PORT=tcp://...`, which stopped the migration.

80. **The front door is a standard Ingress served by Traefik, written as plain YAML**
    (`infra/k8s/kind/traefik.yaml`, #112). ingress-nginx is retired upstream; kind's own docs
    now point to `cloud-provider-kind`, a host process that needs extra setup on macOS. Traefik's
    usual install is a Helm chart; its Ingress-only subset is ~150 readable lines: namespace,
    RBAC, a default IngressClass (so the app's Ingress names no controller and stays portable),
    a non-root read-only Deployment with an explicit 340 s write timeout (over nginx's 330 s), a
    NodePort Service. kind maps **127.0.0.1**:80 to node port 30080 - never the LAN.
    `traders.localhost` needs no hosts entry and is its own cookie host, so signing in there
    never replaces the compose app's cookie on 127.0.0.1 (a browser keys cookies by host, not
    port - which is why the PR 3 browser check waited for this).

81. **CronJobs "ask often" and let the run key decide, exactly like `scheduler.ts`** (#113).
    Nine CronJobs, every 15 minutes or hourly, minute offsets preserving the start order
    (backfill :01 ... digest :16). **Rejected: "once a day at a set time"** - a trigger that fires
    once per period is silently lost if the cluster is down at that minute. No `timeZone`: the
    schedules are minutes past the hour, and which *day* a run belongs to is the orchestrator's
    decision in the user's timezone. `startingDeadlineSeconds: 300` drops stale ticks after a
    sleep instead of replaying a burst; `--fail-with-body` fails the Job on 4xx/5xx and keeps
    the message. `test/cronJobContract.test.ts` fails if a scheduler kind has no CronJob, asks at
    another rhythm, or breaks the order.

82. **The AI service autoscales 1-3 copies on CPU; the orchestrator never does** (M7 PR 6, the
    user's choice among recommendations). **The Deployment declares no `replicas`**: a number
    there is re-applied by every deploy and resets what the autoscaler added. 70% of the `100m`
    request leaves headroom for the ~15-20 s a new copy spends in its schema check and startup
    probe; scale-down waits five minutes so a scan pausing between holdings does not flap the
    count. **Scale-up waits a minute** (added after PR 6, measured): a 4-second scheduled
    portfolio scan pushed one 15 s reading over target and added a copy that started after the
    scan had ended, then idled five minutes - every half hour. A burst from one batch job is not
    load a second copy can take. metrics-server is used as released (pinned v0.9.0, referenced by URL from a
    kustomization), because nothing in it needed trimming - unlike Traefik (decision 80); the one
    change is `--kubelet-insecure-tls`, needed only because kind's kubelets self-sign. Checked
    before scaling: the AI service's only per-process state is read-only (settings, engine,
    outlet table) and a log-once set.
83. **The admin role is read from `users` on every `/admin/*` request, never carried in the
    cookie** (M8 PR 1, the user's choice among recommendations). The session is a signed,
    self-describing cookie holding only the user id (`http/auth.ts`) - there is no server-side
    session for a role to live in, whatever `docs/MILESTONES.md` says. A role copied into the
    cookie would survive a demotion for up to `SESSION_TTL_HOURS`; one indexed read per admin
    request costs nothing at this scale. **One guard in `app.ts` covers every path under
    `/admin`**, including ones with no route (a signed-out probe learns nothing); no admin route
    checks the role itself, and `adminGuard.test.ts` reads `app.routes` rather than a list, so a
    new route is guarded by being registered. 401 without a session, 403 for a non-admin *or* a
    session whose user no longer exists. The kind CI job proves it on the real stack by demoting
    the seeded admin with `psql` and watching the same cookie go 200 -> 403 -> 200.
84. **`admin_audit` is append-only by trigger, and each row is written *before* its action runs**
    (M8 PR 2, the user's choice among recommendations). The app connects as `traders`, a
    superuser that owns every table, so `REVOKE UPDATE, DELETE` - the milestone's plan - would
    have been silently meaningless; triggers fire for a superuser too, and refuse UPDATE/DELETE
    per row and TRUNCATE per statement (`test_admin_audit_sql.py` proves each, and proves the
    superuser premise so it fails when separate roles arrive). What is left open is a deliberate
    `DISABLE TRIGGER`, which is DDL, never an accident of app code - separate roles are in the
    debt table. **Written by the admin gate, not by routes**, for every non-GET admin request,
    for the same reason as decision 83. **Before, not after:** writing after leaves a window
    where the action happened and the audit write fails; before, a failed write means a 500 and
    no action. The price is that the row records the request, not its outcome - outcomes live
    with their actions (a rescreen's in `runs`). `ip_address` is the **last** `X-Forwarded-For`
    hop (nginx appends what it saw; earlier hops are client claims, kept in `detail`); behind
    Traefik that is Traefik's pod - honest, not useful. The FK to `users` has no ON DELETE: an
    admin who has acted cannot be deleted. 0026's downgrade refuses while rows exist.
85. **A universe gap is decided by the AI service and recorded by the orchestrator, and only where
    a user named something** (M8 PR 3). Measured first: symbol lookup already asks Yahoo live, so
    a ticker outside the universe is *priceable* at once (SAP.DE, BTC-USD, ETH-USD were held and
    priced, none in the universe). What it lacks is a profile, so it is never offered for a topic.
    `/market/instruments/resolve` now says `universe: {member, outside_screen}`, computed next to
    the screen's own rules (`snapshot.screen_exclusion`: asset class first, then primary US
    venue) - not a copy of the exchange list in TypeScript. A non-member with no rule is the
    **real gap** (below the size floor or listed since the snapshot: BYND, GPRO); one with a rule
    is expected and shown as such. **"Not checked" is never "missing":** `universe` is null when
    nothing resolved, when the database could not be asked, and when the installation has **no
    profiles at all** (a fresh clone - otherwise every symbol there is a gap). Recorded at the
    three places a user names a symbol (add holding, import preview, add-to-topic) and the one
    where they type a topic (`POST /topics/resolve`, verdict `none` only: `weak` is an answer,
    `unavailable` an installation fault). Not from the metadata run or discovery - the system's
    own searches would bury the users'. One row per thing per user per local day, **counted**
    (`occurrences`, `last_seen_at`), and a failed write is logged, never passed to the user's flow.
86. **The universe status reconciles against the loader's own account, stored per load** (M8 PR
    4). `scripts/ingest_universe.py` writes a `universe_loads` row each run: the manifest it read
    and its counts - members, profiled, undescribed, no currency; holding rows, stored,
    implausible, **of an unprofiled fund**. The page checks `members = profiled + reasons` and
    `holding_rows = stored + reasons` against *live* database counts and flags only the
    remainder. Rejected: comparing the database to the manifest directly - that shows 71 and 33
    "missing" on day one, and a panel that is always red is ignored. **Measuring it found a silent
    drop:** 14 holding rows (BULZ 10, GDXD 2, GDXU 2 - funds with no description) were skipped by
    `load_holdings` without being counted, so 14 of the 33 had no explanation anywhere; the
    loader now counts them. On-demand profiles are counted apart and never reconciled (decision 89),
    so a negative remainder means a screened profile no load accounts for. The orchestrator reads only the database:
    the manifest is a file inside the AI image, so the loader copies it into the row.
87. **Every model call is recorded by a wrapper the factory builds; call sites only add a verdict**
    (M8 PR 5, the user's choice among recommendations). `build_llm(..., call_log=)` puts
    `RecordingProvider` *outermost* - around the budget guard and around `NullProvider` alike -
    so a call refused for want of a model or of budget is a row too (`outcome`: `ok`,
    `provider_error`, `budget_exhausted`, `no_provider`). A call site cannot forget to log,
    because it never logs; what only it knows - whether the text was *usable* - it reports as
    `record_verdict(completion.call_id, ...)` on the provider it asked (`accepted`, `malformed`,
    `unsourced_figures`, `empty_completion`, `degenerate_completion`). That is a method on the
    `LLMProvider` protocol (adapters do nothing) rather than a global or a duck-typed check.
    `Caller(agent, user_id)` travels on `complete()`; a call with no caller is logged as a bug,
    not given a guessed agent. `user_id` now rides on the portfolio-scan, topic-scan and ask
    requests. **Cost is micro-USD**, the integer unit `pricing.py` already used (cents would
    round a cheap call to zero). Prompts and completions hold portfolio data: 30-day retention
    (`LLM_CALL_RETENTION_DAYS`), **pruned by the insert itself** - a separate job would be one
    more CronJob and scheduler entry for a delete that is only due when a row is written.
    Recording never fails a call: a failed write is logged and the completion is returned as is.
    `test_llm_call_log.py` checks the migration's CHECK lists equal the code's Literals.
88. **The LLM panel reconciles narration's explanations against its calls, and shows both records**
    (M8 PR 6). `GET /admin/llm?days=` (1-30, the retention; default 7) counts `llm_calls` per agent -
    outcomes, verdicts, p50/p95 over calls that *reached a provider* (a refused call's 0 ms would
    flatter the model), tokens, micro-USD - and `observations.fallback_reason` beside it. Narration
    asks exactly once per stored explanation (`_narrate_new` drops a known finding *before*
    narrating), so from the first recorded call each fallback reason has a matching count of calls,
    shown reason by reason and flagged only when they disagree - the same "name it or flag it"
    shape as decision 86, rather than trusting one record. The older observation counts stay as
    their own list because `llm_calls` began on 2026-09-30 and is pruned at 30 days. Prompts and
    completions never go on the wire (portfolio data); an error is cut to 300 characters. "Free
    route" is decided by the `:free` suffix per model (what `pricing.py` already trusts), not by
    the current config's tier, so a call made under an earlier model is labelled by its own id.
    TTFT and semantic-cache hit rate are *said* to be unmeasured on the card (no streaming, no
    cache), never shown as zero.
89. **An on-demand profile describes a listing without making it a member** (M8 PR 7, decision
    6 of the plan as built). When a user names a US equity or ETF the universe lacks (gap
    `not_in_universe`), the orchestrator fires `POST /universe/profiles` without awaiting it; the
    AI service answers 202 and, in a `BackgroundTasks` job, fetches Yahoo's `info` through
    `InstrumentProfileSource` (guideline 6), maps it with the loader's own `to_instrument`,
    inserts `membership='on_demand'` **`ON CONFLICT DO NOTHING`** (a screened profile is never
    downgraded, a second fetch adds nothing) and embeds that one row. **Measured first:** no real
    `not_in_universe` gap existed on compose (the BYND/GPRO rows were the kind cluster's test
    rows); Yahoo answered BYND ($142M) and GPRO ($266M) - both below the $1B floor, so no rescreen
    would ever add them - in 0.3-1.3 s. **Four readers**, not one, would have let such a profile
    into a topic: `search_profiles`, `profiles_by_id` (reached by being held by an ETF), the
    holdings matcher, and `coverage` - all read `screened` only, as does the eval's
    `_in_universe`. **Membership stays screened-only**, so the gap keeps being reported: a
    described listing no topic can reach has not closed it; the gaps card shows the profile's
    current membership beside the gap ("profiled on demand" / "now in the universe"). The loader
    promotes an on-demand profile to `screened` when a snapshot admits it, and never touches one
    it does not hold. **The universe status counts screened profiles against the snapshot and
    on-demand ones apart** - rejected: the plan's "a negative remainder is how on-demand shows",
    because a remainder that is always negative on a used installation reads as always wrong.
    A fixture-only chain has no profile source and answers `unavailable` (a configuration).
    Shown on compose 2026-09-30 22:50 UTC: an import preview of BYND, GPRO, SAP.DE profiled the
    first two within a second, skipped SAP.DE (outside the screen), and "plant-based meat" still
    resolved to JBS/HRL/PPC, not BYND.
90. **The rescreen is a run the orchestrator claims and the AI service finishes, on a
    heartbeat, into a volume the loader reads newest-first** (M8 PR 8; the plan's decisions
    3-5 as built). **Measured first, and then measured properly:** a sample (screener 19 s for
    5,427 rows; 100 `info` in 8.9 s, 40 holdings in 1.4 s, 4 workers, no failures) extrapolated
    to ~10 minutes; the real run was rate-limited and took 28 minutes to fail on 64 symbols (see
    "Bugs"). The heartbeat was the right call: such a run outlives `STALE_RUN_MINUTES`.
    - **One path, two triggers.** `startRescreen` (orchestrator) claims run key
      `universe-rescreen:<APP_TIMEZONE date>` with **`user_id` null** - the universe is the
      installation's - for both `POST /admin/universe/rescreen` (audited by the gate first) and
      `POST /internal/runs {kind: universe_rescreen}` (PR 9's CronJob). It hands the run id to
      `POST /universe/rescreen` (202) and answers 202 itself; the AI service builds in a
      `BackgroundTasks` thread and **finishes the run row** (`app/universe/rescreen.py`).
    - **Heartbeat** (`runs.heartbeat_at`, 0031): written every 30 s from the event loop, not the
      fetching thread, so it means "this process is alive". `claimRun` reclaims a heartbeating
      run only after `HEARTBEAT_STALE_MINUTES` (5) without a beat, and gives the reclaimed run a
      fresh beat; runs that never beat keep the started-at rule. A partial unique index allows
      one running rescreen (a run past midnight vs the next day's key); `claimRun` maps that
      unique violation to "already claimed", not an error.
    - **The volume** (`UNIVERSE_SNAPSHOT_DIR`): compose's named volume `universe-snapshots`
      (the image creates `/var/lib/traders/universe` owned by uid 10001, and a new named volume
      starts as a copy of it - otherwise root's and unwritable); kind's PersistentVolumeClaim of
      the same name, mounted in the AI Deployment and the `universe` Job. Each snapshot is built
      in `snapshots/.building-<run>` and renamed into place after its manifest is written; the
      fetch caches live in `cache/`, kept on failure (the next attempt resumes), discarded after
      24 h or on success. The fetch code moved to `app/universe/screener.py`;
      `build_instrument_universe.py` is its command line.
    - **The loader** (`app/universe/loading.py`, used by `ingest_universe.py` and the rescreen):
      the newest snapshot by `as_of`, image or volume, **and never one older than the last
      `universe_loads` row** - a lost volume would otherwise reload the image's quarter-old
      snapshot over a fresher database. Every load marks screened profiles the snapshot lacks
      `dropped` (counted in the load record and on the status card).
    - **Shown in kind 2026-10-01** after three attempts (28 min failed on rate limits; 3 min
      failed on 4 ETFs' holdings; 40 s from a complete cache): 5,289 members, 20 created, 64
      changed, **22 dropped**, 16,307 holdings, 84 embedded; four real `admin_audit` rows; a
      redeploy's `universe` Job chose the volume's snapshot and kept the drops; both
      reconciliations at 0 unexplained. See "Bugs" for what the real run found.
    - **A failed rescreen can be retried the same day** (`claimRun({retryFailed: true})`, the
      rescreen only): its cache is kept, and found necessary on the first real run in kind -
      Yahoo rate-limited it (`YFRateLimitError`) within two minutes, which the 100-symbol
      sample had not. Every other kind keeps "a failed key stays failed"; the next bucket's key
      retries a scan.
    - **Not here:** retrying a dead rescreen automatically. A run whose process died stays
      `running` until a trigger (a click, the CronJob) reclaims it - see the debt table.
91. **The quarterly rescreen asks hourly, and is due by the age of the snapshot loaded** (M8 PR
    9). Rejected: the plan's quarterly schedule (`0 3 1 1,4,7,10 *`) - the one trigger shape this
    repo's `cronjobs.yaml` exists to avoid (a once-per-period tick is lost if the cluster is
    down that minute), and `cronJobContract.test.ts` would have refused its rhythm anyway. Instead
    `run-universe-rescreen` (minute 15, before the digest) and the local timer ask hourly like
    every kind, and `startRescreen({scheduled: true})` decides: **due when
    `universe_loads.snapshot_as_of` is `RESCREEN_DUE_DAYS` (91) old**, or when nothing was ever
    loaded. The loader's own record, not the last successful run, so an installation on the
    committed snapshot falls due when that snapshot is a quarter old (compose: 2026-12-24) and
    never rescreens on its first start. A not-due ask writes no run row. **If today's key exists,
    the ask goes to `claimRun`** - so the button and the CronJob the same day are one run, and a
    failed scheduled rescreen is retried at the next hourly ask (decision 90's `retryFailed`),
    resuming from its cache. The button is never held back. Shown in kind 2026-10-01: the
    CronJob's own tick and a `kubectl create job --from=cronjob/run-universe-rescreen` both
    answered *already claimed (ok)* with the button's `universe-rescreen:2026-10-01`; a fresh key
    answered *not due ... falls due on 2026-12-31*; one rescreen row in `runs`.

92. **A standing finding is asked about once per episode, not once per observation**
    (independent task 8). Measured on compose before building: the BTC-USD drift sat at
    0.149-0.153 all week on the 0.15 `high` line and was proposed **7 days running**, once 20
    minutes after the user approved it - approval writes the virtual ledger, so it never moves the
    drift, and the line was crossed several times a day. Rejected: the queued "one open proposal
    per subject" (would have prevented 1 of the 7: they were mostly sequential, each expiring at
    24 h); "re-ask when it goes away and comes back" (the flicker re-arms it daily); a reminder
    every N days (a number to tune; the user chose without). Chosen with the user: an episode
    (`proposal_episodes`, migration 0032, one open per user/kind/subject by a partial unique
    index) is claimed before the proposal is raised, and while it is open no new proposal is
    raised whatever the answer was. It ends **resolved** when a scan in which the rule ran sees the
    subject below the band beneath the floor (`high` floor: below `notable` - a band of
    hysteresis), or is replaced when the drift is **worsened** by one band (floor threshold minus
    the one beneath, read from the finding's `thresholds_weight`) or **reversed** in sign. No
    number to tune. **Two things made it possible:** the scan's reply now carries `stats.seen`
    (every finding, known or new), because observations carry only the new and "the feed already
    has it" is not "it went away"; and a scan whose drift rule was skipped (an unpriced holding)
    resolves nothing. A kind with no episode policy, or evidence it cannot read, is asked about
    as before - over-asking is the safe failure. The migration seeds each subject's latest
    proposal as an open episode; a stale seed is closed by the next scan. The feed still says
    "still drifted" daily; only the question goes quiet. Replayed in
    `proposalEpisodes.test.ts`: the week asks once.

93. **The services connect as `traders_app`; only migrations connect as the owner**
    (independent task 9, migration 0033). Measured first: no service, loader or script issues
    DDL, `TRUNCATE`, `COPY` or an advisory lock at runtime, so a role with `SELECT, INSERT,
    UPDATE, DELETE` on `public` and `mastra` (and their sequences) is enough - and on
    `admin_audit` only `INSERT, SELECT`, so decision 84's triggers are now the second line, not
    the only one. Choices argued: **the password is never in the migration** (committed); 0033
    creates the role `NOLOGIN` and `scripts/migrate.py` sets `LOGIN PASSWORD` from
    `APP_DB_PASSWORD` after every upgrade, which also makes rotation "change the variable,
    restart". Rejected: a Postgres init script (runs only on an empty data directory, so never
    on an existing installation). **The role is never dropped**: roles are cluster-wide and the
    test databases share a cluster with the real one, so the downgrade revokes its rights in
    that database only. **Default privileges** grant future tables automatically; a future
    append-only table must `REVOKE` explicitly. Compose keeps the owner URL on `migrate` alone;
    kind overrides the `migrate` Job's `DATABASE_URL` from `MIGRATION_DATABASE_URL`, and
    `k8s-up.sh` upgrades an existing `secrets.env` in place (adds the app role, keeps the owner
    password the database already has). CI runs `scripts/migrate.py` and then
    `queries.postgres.test.ts` **as `traders_app`**, so a query the grants do not cover fails in
    CI. Locally all 22 orchestrator SQL tests passed as the app role with one expected change:
    an UPDATE on the audit is now refused by privilege, not by the trigger.

94. **The layout is written in logical directions, and guideline 1 was amended rather than
    worked around** (Hebrew slice 1, #142). The user asked for Hebrew while CLAUDE.md guideline
    1 said "English only, including UI copy"; the rule was changed with them first: the
    repository stays English, UI copy is translatable. The layout uses `ms-`/`pe-`/`text-end`
    so one `dir` on `<html>` mirrors every page; `test/textDirection.test.ts` refuses any
    physical class and any horizontal arrow or chevron without `MIRROR_IN_RTL`. **Charts stay
    left-to-right** in Hebrew (`CHART_DIRECTION`): time running backwards reads as a mirror
    image, and Recharts has no RTL mode. Rejected: converting classes later, page by page - a
    physical class looks right in English, so nothing would ever have reported one. Slice 1's
    `?dir=rtl` test switch was **removed** in slice 3: kept in `sessionStorage`, it left a
    user's tab mirrored in English and looked like a bug.

95. **react-i18next, with a CI parity test, not an in-house catalogue** (Hebrew slice 2, #143).
    First recommended in-house (~100 lines, a missing key a type error); the user asked whether
    a library existed, and the recommendation changed: the one argument against i18next - a
    missing Hebrew key silently shows English - is closed by `i18n/parity.ts`, which fails CI
    on a missing key, a missing plural form (from `Intl.PluralRules`, so Hebrew's `_two`), a
    dropped `{{placeholder}}` or `<Trans>` tag, or a stale key. `t()` is typed against
    `en.json`. A second test fails on any word written straight into JSX or a text attribute.
    Formatting is not in the catalogue: `i18n/format.ts` formats money, percents, shares and
    dates with `Intl` in the language's locale - English keeps en-US numbers with en-GB
    day-first dates, exactly as before. `t()` outside React reports a MobX dependency on the
    language, so a store's cached message is recomputed when the language changes. Rejected:
    `useTranslation` everywhere (stores and `lib/` build half the strings) and reloading the page
    on a language change.

96. **v1 translates the interface only; server-generated text stays English** (the user's
    decision, 2026-10-01). Observations, narration, `/ask` answers, news, the concept corpus,
    Telegram, the digest and API error messages are English, marked `lang="en" dir="auto"`
    (`SERVER_ENGLISH`) so they keep their own direction on a Hebrew page. Why: headlines are
    stored in English when written, the evidence validator parses only `1,234.5`-style
    numbers, the corpus is 4,253 English words ingested once, and the Ask intent rules are
    English - each is its own project. Consequences kept on purpose: the Ask example questions
    stay English (they become the question), the Topics placeholder says "in English", concept
    chips are English. The cheapest next step, if wanted, is the 198 lines of deterministic
    templates (`app/narration/templates.py`), rendered per language.

97. **The language lives on `user_settings` and travels with the session** (Hebrew slice 3,
    #144, migration 0034). `'en' | 'he'`, default `'en'`, CHECKed (`UI_LANGUAGES` in
    `packages/shared/src/language.ts` restates it for both services). On `user_settings`, not
    `users`: 0006's line - `users` resolves "today", `user_settings` holds what reaches the user
    - and it is the row Telegram and the digest already read. Required in `PUT /settings`
    (a replace: left out, it would reset to English on an unrelated save). `/auth/session` and
    `/auth/login` read it through `getOrCreateUserSettings`, so the default is written once, in
    the schema, and the first screen is already in the language - `App` draws nothing until the
    session is known. The page switches language only once the save succeeds. Rejected:
    `localStorage` (one browser, no message, and an English flash on every load). The sign-in
    page is English: the language is unknown until someone signs in.

98. **Observations are translated when written, from the templates, never from the model**
    (Hebrew server text slice 1, #147, migration 0035; the user's decision 2026-10-02).
    `observations.localized` is `{"he": {headline, explanation}}`, rendered by the AI service
    (`app/narration/localized.py`) for every finding, whoever wrote the English. Rejected:
    *rendering on read* - the feed is served by the TypeScript orchestrator, so it means a second
    copy of the templates there (free to drift) or an AI call per page load; *a column per
    language* - a language should be a catalogue and a CHECK, not a migration on the largest text
    table; *asking the model for Hebrew* - double the cost, unmeasured quality on free routes, and
    a translation nobody validated is what the evidence validator exists to prevent. Cost, kept on
    purpose: a model-written finding (~30% of a measured week, 11 of 36) reads as its plainer
    template in Hebrew. The validator was *not* the blocker decision 96 feared: Hebrew uses Western
    digits and `1,234.5`, so the regex reads a Hebrew sentence unchanged. **Every figure and Latin
    run sits in a Unicode isolate** (LRI…PDI; a topic label - the user's own text, either script -
    in FSI…PDI, since #148). Markup cannot do this in Telegram's plain text, and without it
    `-26.5%` renders `26.5%-` in a right-to-left line; `test_hebrew_templates.py` refuses any digit
    or Latin letter outside an isolate. The 0035 backfill imports the templates - safe only
    because a database created after it has no observations to backfill. Rows stored by #147 hold
    LRI around topic labels; identical on screen for the English labels they carry.

99. **The orchestrator's own sentences are a typed record, not i18next** (slice 2, #148).
    `Record<UiLanguage, Messages>` in `notify/messages.ts`: ~50 sentences, several of them
    functions of a count or a duration, so a Hebrew plural is just a function and a missing
    sentence is a compile error - the web's rule, enforced by the compiler instead of a parity
    test. The orchestrator never composes an observation's words; it chooses between stored
    versions (`observationTextIn`), falling back to English, never to a blank. The language rides
    on `NotificationSettings` and `OutboundNotification` (the policy layer already reads the
    settings row); the Telegram client labels buttons from it. A chat with no bound user is
    answered in English - nobody's language is known. `appendOutcome` recognises an outcome line
    in any language, so a user who switches between an approval and its undo still gets one block.

100. **`agent_id` is NOT NULL with no default, and the primary is a row, not a NULL** (#152, 0036).
    A nullable discriminator is one forgotten `WHERE agent_id IS NULL` from showing simulated
    shares as real; a default of "the primary" is the same trap - a writer that forgot the column
    would write to the real portfolio silently. With neither, forgetting it is an INSERT error, and
    the TypeScript input types make it a compile error first (the compiler listed every writer).
    **The one exception is `runs`**: `runs.user_id` was already nullable for the installation's
    universe rescreen (`claimRun({ userId: null })`), and an installation has no primary, so
    `runs.agent_id` follows it exactly (`runs_agent_follows_user`). A composite FK
    `(user_id, agent_id) → agents (user_id, id)` stops a row naming another user's agent. Every
    user gets a primary **by trigger on `users`** (`users_seed_primary_agent`), not by a writer
    remembering. Child rows read their agent from their parent in the same SQL (a proposal from its
    observation, an intent from its proposal, an episode from its observation) so they cannot
    disagree; root writes take it explicitly, resolved once at the edge by `primaryAgentId()`.
    Rejected from the spec: `philosophy` (D14/D16 leave it one value), and `domain`,
    `scan_cadence`, `thresholds` until a stage reads them.

101. **Expand, then contract: 0036 added the per-agent unique indexes beside the per-user
    constraints; 0037 dropped the old ones in the PR that moved every `ON CONFLICT`** (#152, #154).
    Each per-user constraint backed an `ON CONFLICT` target, and Postgres rejects an `ON CONFLICT`
    with no matching constraint at runtime - so dropping them in 0036 would have broken every
    insert in the window between the migration job and the new pods (kind rolls them seconds
    apart). The spec listed three such constraints; measuring found six (`portfolio_snapshots`,
    `target_weights`' primary key and `proposal_episodes`' open index had been added since the
    spec was written at #40).

102. **Uniqueness is per agent by a composite key, never by rewriting the key** (D13, #154).
    `observations UNIQUE (agent_id, dedupe_key)`, `runs (agent_id, run_key) NULLS NOT DISTINCT`
    (so the installation's null-agent rescreen keys stay unique among themselves), hash and key
    format unchanged. The spec's original "add agent_id to the hash" cannot be backfilled - a stored
    key is a digest whose inputs are gone - so the first scan after the deploy would have re-emitted
    the day's findings under new keys and **notified the user again**. Shown on the live copy:
    today's default run keys, claimed on live, were still refused after 0037.

103. **Every statement on an owned table names `agent_id` or argues `-- agent-blind: <why>` inside
    the SQL** (#153). `test/agentScopeContract.test.ts` reads every SQL literal under
    `src/db/queries/` and fails otherwise (the reason must be on the comment's own line; it also
    checks it found >40 statements). The rule that sorts them: **what the user sees about a
    portfolio is per agent** (holdings, the feed, snapshots, targets, episodes, and the dedupe keys
    a scan sends); **what is sent to the user is per user** (notifications, the digest, the inbox -
    one chat for every agent, §7.2), as are narration health (the provider's), shared ingestion's
    instrument list (§4.1), topic findings, and the run history (until Stage 2's views, which must
    then leave out the agent-blind run kinds, §3.3c); rows addressed by their own id and the
    installation sweeps are exempt. Rejected: an allowlist file in the test - the reason belongs
    where the next reader of the query is. The run claim was scoped in the same PR, before 0037
    made keys per agent: reclaiming by `run_key` alone would have reached another agent's run.

104. **The passive primary is an allowlist in two places, not a denylist** (D1, #155, 0038).
    `PRIMARY_PROPOSAL_KINDS = {'rebalance'}` in `services/proposals.ts` (refused before writing,
    `PrimaryAgentIsPassiveError`; a unit test fails if `PROPOSABLE_KINDS` could ever produce a kind
    outside it) and the trigger `proposals_primary_rebalance_only`, on insert or change of
    kind/agent. Added before any trade kind exists - the only moment it costs no backfill. A future
    kind is refused on the real portfolio until a migration argues otherwise.

105. **Every route is behind a session unless a test's public list says otherwise** (#158). The
    gate is `PROTECTED_PREFIXES` in `http/app.ts`, so a new route is **public by default** -
    `/agents` was written and tested without being added, and only a re-read caught it. `app.test.ts`
    now walks every route Hono registered and fails on any that answers without a session, outside
    `/healthz`, `/readyz`, `/auth/*` and `/telegram/webhook`; shown failing on `/agents` (500)
    before the prefix went in. Rejected: inverting the gate to protect-by-default in the same PR -
    the right end state, but it changes every route's middleware order, and the test already makes
    forgetting impossible to merge.

106. **A user's own text takes the direction of what is typed** (#159). An agent's name and persona
    can be in either script: their inputs are `dir="auto"` and a displayed name is isolated in
    `<bdi>` - the topic-label rule (decision 98's FSI) applied to the web. Found in the Hebrew
    preview: an English persona rendered ".Buys strength…" with its full stop on the wrong side.
    The primary's name is never the stored English: `agentName()` renders it from the catalogue.

107. **The ledger's rules are the database's, and the app may only insert a fill** (#163, 0040).
    Cash moves by trigger alone: a deposit follows `agents.budget_minor`, a trade's debit or credit
    follows its fill (`−(notional+fee)` / `notional−fee`), the balance follows the movements, and
    `CHECK (balance_minor >= 0)` refuses an overspend that slipped past the application's check
    under the row lock. Fills and movements are append-only by trigger, even for the owner.
    `traders_app` holds INSERT on `fills` and `UPDATE (updated_at)` on `agent_cash` - the latter
    only because `SELECT ... FOR UPDATE` needs an UPDATE privilege - and nothing else; the writing
    triggers are `SECURITY DEFINER` with a pinned `search_path`. Rejected: an app-maintained
    balance (one forgotten code path and cash disagrees with its history, silently).
    Consequence for tests: a committed fill can never be deleted, so it blocks a suite's cleanup -
    orchestrator tests write fills inside a transaction they roll back, and an agent that has traded
    cannot be deleted at all (FK without cascade; D18 says archive). An untraded agent still can,
    its cash row and opening deposit cascading - existing tests delete agents.

108. **The budget is the sum of deposits, always** (D22, #163/#165). Before the first fill a budget
    edit rewrites the opening deposit (the one UPDATE the movement guard allows); after it a raise
    is a dated `top_up` and a cut is refused - in the trigger, and first in the route with a 409
    `budget_decrease_after_trade`. *Add cash* is `budget_minor = budget_minor + $amount` in one
    statement, so two additions never read the same old budget. Rejected: withdrawals (they would
    also have to leave the shadow benchmark, for a case nobody asked for).

109. **One fill path, previewed then confirmed** (D26-D30, #164). `services/fills.ts:executeFill`
    is the only writer of fills; Stage 4's approval of an agent's proposal must call it, not copy
    it. The preview writes nothing; the confirm re-fetches the quote and fills only within ±50 bps
    (D3) of the price the preview showed, else 409 `price_moved` with the new price. A live quote
    may be ≤30 min old and not stale (D28) and needs the exchange open (calendar). A typed price
    (`price_source: 'user'`) skips both and warns at ≥5% from the last quote, never blocks (D29).
    The web mints the idempotency key per preview, so a double-click on Confirm is one fill.

110. **The exchange calendar is a committed file from our own generator; an unknown exchange is
    never assumed American** (D25, #162). `scripts/generate_exchange_calendar.py` writes
    `data/calendar/xnys.json` from `app/core/nyse_holiday_rules.py`, keeping `"source": "manual"`
    rows (2025-01-09, Carter). Its test pins the rules to NYSE's published 2026-2028 list and fails
    90 days before the file ends. `calendar_name_for()` returns None for an exchange
    `market_sessions` does not know, unlike `session_for()`, which falls back to US: a wrong cache
    TTL costs a request, a wrong fill is a wrong ledger. Quote caching (decision 1) still ignores
    holidays. Rejected: `exchange_calendars` (the user's no-third-party preference), bundling it
    into the universe build (Yahoo publishes no holidays; different refresh cadence).

111. **An agent's net worth and P&L are null when any holding is unpriced** (#165). P&L is net
    worth minus deposits (D6); fees already left cash and are never subtracted again. A total that
    silently skipped a position would read as complete - guideline 7 - so the card names the
    unpriced symbols instead. The same rule will govern PR 7's returns (§5.4: unavailable, not
    partial).

112. **The real portfolio has no ledger - D1's fourth layer** (#163). A trigger refuses any
    `agent_cash`, `cash_movements` or `fills` row for a primary; the trade and account routes
    answer 409 `primary_agent_is_passive` before it. With 0036's CHECK, the proposals allowlist and
    0038's trigger, that is four layers.

113. **The consolidated view values each agent with the function its own page uses, and never adds
    real to simulated** (#167, D32-D35). `GET /portfolio/consolidated` calls `valuePortfolio` for the
    real portfolio and `valueAgentAccount` for each non-archived agent, then groups by instrument
    (`services/consolidation.ts`), so the dashboard and the agent page cannot disagree about a figure.
    Every row has a `real` and a `simulated` side; the headline is two figures. The two sides keep
    different rules for a missing price **on purpose**: the real total stays partial and marked (the
    dashboard's rule since M1), the simulated total is withheld (decision 111). The filter switches
    only the holdings card and the headline; the equity curve, allocation and findings stay real, and
    a scoped headline says so - added after the preview showed an agent's figures directly above the
    real portfolio's chart. Quantities are added as exact decimal strings (`addQuantities`).

114. **Performance is computed on each request, never stored** (#168, D36). An agent's value at a
    session close = cash after the last movement made by that instant + each holding (fills replayed)
    × that day's stored close. Rejected: a nightly snapshot per agent (gaps whenever the machine is
    off - the real portfolio has 13 rows in 21 days - a midnight price rather than the close, and a
    migration). **The series ends at the last session SPY has a stored close for**: a session that
    has closed but whose close the next backfill has not fetched is *not recorded*, not *unpriced*;
    without that rule every evening would show "unavailable". The trading days and closing instants
    come from `GET /market/sessions` (AI service), never a copy of the calendar (D25).

115. **The shadow SPY buys at the first session close at or after each deposit, fractionally, with
    no fees** (#168, D37, D38). After hours or on a closed day, the next session's close; until it is
    recorded the deposit is *pending* and in neither figure. Its value is one exact fraction
    (`Σ deposit × close(day) / close(bought)`) rounded once. **No fees is a stated debt, not a
    finding** - the user will add them.

116. **The score replays the agent's own book** (#168, D39-D41). Only `source = 'agent'` fills, as
    if the user had never traded by hand; a sell scores only shares the agent itself bought, at their
    share of its cost (buy fees included); a win is a profit after fees (break-even is not); each sell
    counts once, in the 30/60/90 windows its date falls in; unrealised P&L is capped at what is still
    actually held (the book can claim shares the user sold by hand). Proven only by worked examples
    until Stage 4 writes an `agent` fill.

117. **Reset account is one `SECURITY DEFINER` function, `reset_account(user, groups)`, and the
    ledger's only way to lose a row** (task 18, migration 0045, the user's choice 2026-10-07).
    Every service connects as `traders_app`, which holds no DELETE on `fills` or `cash_movements`;
    the function runs as the owner and raises the transaction-local `traders.account_reset`, which
    the two append-only triggers accept for a DELETE only. The flag is worthless to the app role on
    its own - it still has no DELETE - and `test_account_reset_sql.py` proves that. *Rejected:*
    granting DELETE to the app (any query could then erase the ledger, what D22/D23 forbid); an
    offline script (no form). **The backup is `account_resets`**, every erased row as JSON, written
    in the same transaction - a crash between "back up" and "erase" cannot leave an account erased
    with no copy. *Rejected:* a browser download (lost download, lost data). Restore is by hand.
    **Groups split by owner, not by table:** the primary's non-topic observations are the main
    portfolio's, a simulated agent's rows are its trading, topic observations are topics'. **Always
    kept:** `runs` (the idempotency keys - erased, today's digest would be sent again),
    `llm_calls`, `ops_events`, `admin_audit`. **A reset agent has cash and budget $0** (the user's
    choice), which needed two changes the user did not see coming: `agents_simulated_has_budget`
    now allows `>= 0` (creating at $0 is still refused, by the API and by `cash_movements_sign`), and
    `agents_ledger_follows_budget` inserts the opening deposit when none exists - before it, the
    first *Add cash* after a reset would have updated no row and moved no cash, silently. On the
    Admin page, last card; the typed word is `RESET` in every language and checked by the server too.
118. **Reading holdings from a broker is in scope; trading through one never is** (D67, the user's
    choice 2026-10-08, plan in [PROPOSAL-IBI-SYNC.md](../docs/PROPOSAL-IBI-SYNC.md)). PRD P1 said
    "broker integration is out of scope", which mixed two things with opposite risks: a write
    path that can lose money, and a read path that only saves typing. Only the read path is
    allowed, and only as an **import source**: a broker's positions become `ImportRow`s and go
    through the same preview, resolution and merge-or-replace commit as a file (F1), so a sync can
    never change holdings the user did not see first. **Credentials never reach Traders:** a broker
    is connected by OAuth on the broker's own page or not at all. *Rejected:* relaying the user's
    broker password through our server (it turns us into a credential harvester, breaches broker
    terms, and Node cannot erase a string from memory). **Order:** IBI's Excel export through the
    file import first - it needs no authentication and builds the mapper the MCP path reuses;
    the MCP path waits for a read-only probe of IBI's OAuth metadata, because no public
    registration for third-party clients has been found.
119. **"Seen" for a digest is a send time, not an id** (UX4, migration 0046). A digest is not stored
    as a message: it is the batch of digest-channel `notifications` one run sent, named by its
    latest `sent_at` (`listLastDigestEntries`), so `user_settings.digest_seen_at` holds the send
    time of the last digest seen. Nullable with **no default** - `now()` would have marked the
    digest waiting at deploy time as read. `markDigestSeen` moves it only forward (`GREATEST`: a
    stale tab cannot bring a dismissed banner back) and never past the latest digest sent (`LEAST`:
    a claim from the future cannot hide tomorrow's), and records nothing when no digest exists -
    `LEAST` alone ignores a NULL and would have kept the claim. `seen` is compared as JS Dates:
    `sent_at` has microseconds, the time a client echoes back has milliseconds, and the driver
    reads both at millisecond precision. **On the server, not `localStorage`**, so a digest read on
    the phone is not announced on the laptop; opening the Digest tab marks it, once per digest (a
    failed write must not retry in a loop). *Rejected:* a dialog on entry - dismissed unread.
120. **The export's cost is a decimal, not minor units** (UX6). The plan said "money as minor
    units"; the importer reads `cost_basis` as a decimal per unit (`parseToMinor`), and the export
    is in the importer's shape so it re-imports unmapped. The stored integer is written exactly at
    the currency's exponent (`minorToDecimalString`, 15000 JPY is "15000"), which reads back to the
    same integer - the round-trip test in `apps/orchestrator/test/holdingsExport.test.ts` runs a
    file through the real `buildImportRows`. *Rejected:* adding a `cost_basis_minor` alongside -
    two spellings of one figure is one more thing to disagree. Per holding, cost per unit; built
    in the browser from the loaded portfolio, so no endpoint.
121. **Menus are disclosures, not ARIA menus; side panels are one `Drawer`** (UX2, UX5).
    `Disclosure` (a button with `aria-expanded` over a list of links and buttons) serves the app
    bar's Account and hamburger menus and the holdings card's "⋯"; it closes on Escape (focus back
    on its button), outside click, choosing an item, and address change. An ARIA `menu` would owe
    an arrow-key model nobody would test. `Drawer` moves focus to its first field and back to the
    opener, and is full screen below 448 px; `TradePanel` uses it too.
122. **A chart's box is LTR; its tooltip reads in the language's direction** (UX1). `CHART_DIRECTION`
    pins the time axis; the one `ChartTooltip` (all four charts) sets `dir` from the language,
    because inheriting the pinned LTR printed "(100.0%) $ 3,366.70" in Hebrew.
123. **The bar holds places; a page's own controls stay on the page** (UX2-UX5). Refresh and the
    price age belong to the portfolio's row; Add holding, Targets, Import and Export to the
    holdings card (Targets opens `/targets` - the user chose the page over a drawer, the editor
    needs the room); observations and the digest to `/insights` (`?tab=`, filters in the address;
    an old `/?severity=` link redirects there). Do not add cards back to the dashboard - that was
    the point of the sprint.
124. **A scheduled scan's retries are planned from Postgres; the queue only carries attempts**
    (D69, D73; PR 7b). Every 15 minutes the `agent_scans` ask works out each agent's due slot
    (`scanSchedule.ts`, from the day's session) and reads that slot's attempts from `runs`
    (`agent_scan:<agent>:<NY day>:<slot>:<n>`, 0048); the next attempt goes on BullMQ with the run
    key as its job id. The worker records every outcome on the run and never throws, so BullMQ's
    own retries never act. A failure retries >= 60 min later, at most twice, inside the window;
    any other outcome - `invalid_answer` and a spent budget included - is final. *Why not BullMQ's
    backoff:* a restart, a cleared Redis or a second process would then repeat or lose an attempt,
    and the window rule needs the calendar anyway. *Rejected (with the user):* time-capped batches
    in the request (no parallelism); RabbitMQ (a second stateful service); pg-boss (fit, but the
    user chose BullMQ); "retry hourly until the window ends" (uncontrolled cost in an outage). The
    5,000-agent arithmetic is in D73: the limit is the provider's rate, not the queue.
125. **Only one installation schedules scans: `ENABLE_SCHEDULED_SCANS`, off unless `true`** (D71).
    Compose and kind have separate databases and one OpenRouter key; an agent in both would be
    scanned and billed twice, and neither can see the other. The switch is an env var, so turning
    it on is a deliberate act per installation; when off, the ask answers "skipped" and writes no
    run row (96 a day would say nothing). *Rejected:* a per-agent opt-in (the same agent turned on
    in both); a habit.
126. **The agent limit is enforced by a trigger that locks the user's row** (D72, 0047). The
    orchestrator checks first so the page can say so, but only the database can make two
    simultaneous creates see each other: the trigger takes `FOR UPDATE` on `users`, counts
    non-archived simulated agents, and raises `agent_limit_reached` (`check_violation`); a restore
    from the archive is checked the same way. `installation_settings` is one typed row (`id =
    true`), the app role may update it but not insert or delete. *Rejected:* key/value settings
    (a wrong value read back as text); counting archived agents (an old experiment blocks a new
    one forever).
127. **A trade proposal ignores the severity floor; a sell ignores quiet hours only while the
    market is open** (D60, D70). It expires an hour after the open, so the digest delivers it dead;
    and a sell can be approved only while the exchange is open, so that is the one moment worth an
    interruption. A mute still holds. Reasons stay `above_floor`/`quiet_hours` - no CHECK changed.
128. **Telegram's Confirm carries the previewed price inside its signed callback** (D62). A varint
    after the nonce, under the same MAC: 57 of 64 bytes before, 61 up to $20,971, 63 at the 28-bit
    ceiling ($2.68M; above it the message offers Reject and "confirm in the app"). The ±50 bps band
    is centred on the price the user read; an edited button fails verification. *Rejected:* a
    callback row per button (a write per render, and its own expiry sweep).
129. **A slot that gives up is reported once, and the failed run is the Admin record** (D74). One
    Telegram message on the last failed attempt (agent, slot, cause in plain words), sent directly
    through the notifier - not the fan-out - so it is not deduplicated by `notifications` and does
    not respect quiet hours or a mute (debt, below). The `agent_scan` run's `stats.cause` is what
    the Admin runs list shows; `ops_events` was not widened.
130. **The portfolio and topic scans stay on the 30-minute bucket** (the user, 2026-10-08). Read
    the cadence correctly first: the scheduler *asks* every 15 minutes, and the run key
    (`RUN_BUCKET_MINUTES` in `http/routes/internal.ts`) runs a scan once per 30-minute bucket;
    the extra asks are what let a restart catch up instead of skipping a bucket (decision 6).
    *Rejected:* 2-3 market-anchored slots a day (pre-open, mid-day, post-close). The argument for
    them was notification fatigue and cost, and neither is caused by the cadence: a scan over
    unchanged data writes nothing (the dedupe key is rule, subject, severity and *day*) and makes
    **no LLM call** (already-known findings are counted, never narrated), so a repeat run costs
    database reads and quote requests. The fatigue is the two faults decision 132 fixes, and
    fewer scans would fix neither - they would only make an intraday crash wait hours to be seen.
    No rule needs high frequency either: every window is in days. This also **drops queue task 16**
    (a market-following frequency set on the Admin page): the user chose not to tune the cadence.
131. **No on-demand "Scan portfolio" / "Scan topic"** (the user, 2026-10-08). Considered with a
    15-minute cooldown (the run key could have been the cooldown) and a daily cap. *Rejected*
    because the 30-minute loop already answers "what is true now" within one bucket, and Yahoo's
    quotes are 15 minutes delayed, so a manual scan would mostly re-read the data the last scan
    read. Not to be confused with an **agent's** *Run a scan now* (`PROPOSAL-MULTI-AGENT.md`,
    D64-D66), which asks a model for a thesis and stays.
132. **States fire when they cross a band; an unusual move absorbs the price move** (the user,
    2026-10-08; queue task 19, first in order). Two faults found by reading the code, and they are
    where the feed's noise comes from:
    (1) **Drawdown and allocation drift are states, but are dated like events.** Both take
    `as_of` from the latest price, so the day bucket in `dedupe.py` makes a holding that sits 12%
    below its high for ten days ten observations, and a drift fires (and raises a rebalance
    proposal) every day until the user rebalances - the BTC-USD drift proposed 7 days running
    (25 Sep-1 Oct) is this fault. The fix: a state observation is written when the subject
    **enters a band higher than the one last written in the same episode**; an episode ends when
    the subject falls back below the `info` band, and the next entry is a new observation.
    (2) **One move is two observations.** A 5% move on a quiet stock writes both `price_move` and
    `sigma_move`. The fix: when both fire for the same subject and session, only `sigma_move` is
    written; `price_move` stands alone only when the z-score could not be computed (too little
    history, or another of the guards in `sigma_move.py`).
    **Settled by the user, 2026-10-08:** a merged move takes the **sigma band's** severity - that
    is the rule that knows the stock, so a 5% move that is ordinary for it is not "notable". And an
    expired rebalance proposal is **not asked again** while the drift stays in the same band: the
    user was asked once, and repeating it daily is the nagging this decision removes. A higher band,
    or a new episode, asks again.
    **Built 2026-10-09, with two more answers from the user.** (a) **The episode lives in a table**,
    `finding_episodes` (0049): open row per agent, kind and subject, holding the highest band written.
    *Rejected:* re-deriving the episode from the price history (works for drawdown only - drift
    cannot be rebuilt once holdings change) and keying on the trailing high's date (a 30-day window
    rolling past the high re-announces it, and a recovery that does not make a new high is silently
    merged). (b) **`price_move` is dropped only when `sigma_move` fired**; when the z-score is
    computed but below its band, the price move stands alone - "a 6% fall is never invisible" won
    over "sigma decides". The expired-proposal half needed no code: decision 92's
    `proposal_episodes` already holds the question until the drift resolves, worsens or turns.
    An episode is closed only when the rule *measured* the subject (drift ran; the holding had
    history) - closing re-arms the finding, so "did not look" must not count as "went away". An
    empty portfolio closes every open episode. `observation_id` cascades, so `reset_account` needed
    no change. **Before:** kind, 30 Sep-9 Oct, 14 drawdown rows for SMR and URA, 3 under the rule. **After** (measured
    2026-10-14 on kind, observations written 2026-10-11..14, 88 portfolio scans): **0** new
    drawdown rows for SMR or URA - each holds one open episode (SMR *high*, URA *notable*, both
    opened 2026-10-09) and every scan counted both as `heldInEpisode` (176 in all); ETH-USD's two
    *info* rows are two episodes (closed 2026-10-11 08:08 when it recovered, reopened 2026-10-14),
    which is the rule working. **0** `price_move` rows sharing a subject and New York day with a
    `sigma_move` (3 `price_move`, 1 `sigma_move`). Queue task 19 closed.
133. **Insights shows today, back seven days, with unread state** (the user, 2026-10-08; queue
    task 21, after tasks 19 and 20). The feed opens on **today's findings** ("today" in the user's
    timezone, guideline 10) and steps back **one day at a time, at most 7 days**; older findings
    are not shown in the primary UI but are **not deleted** - nothing deletes observations today
    except `reset_account` (0045), and retention is a separate decision. A **badge** on the
    Insights tab counts unread findings, and an unread finding is styled apart from a viewed one
    (an indicator or background that dims once seen). **"Seen" is one `last_seen` timestamp per
    user** on `user_settings` (the user, 2026-10-08), as decision 119 did for the digest - one
    column, no per-row writes, and "unread" is `created_at > last_seen` for the primary agent.
    *Rejected:* a flag per observation, which costs a write per row read and a migration every time
    a new kind of thing becomes "readable".
    **Built 2026-10-11 (migration 0051 `insights_seen_at`; written as 0050 and renumbered when DB3 took 0050 the same hour), with three answers from the user.**
    (a) **The bar's number stays the open-proposal count; unread findings are a dot beside it** -
    the number is what has a deadline; the unread number sits on the *All findings* tab. (b)
    **Opening All findings or Alerts marks seen**, to the `asOf` the page counted at (a finding
    written while the page is open stays unread), only forward, never past now. The highlight is
    judged against `seenAt` as the page found it, so it lasts the visit and is gone on the next.
    *Caveat:* that baseline is per page load - Insights left open for hours keeps its first one;
    the dot always follows the latest counts. (c) **The day stepper is on All findings only**;
    Alerts keeps paging (few alerts; days would be mostly empty). The server computes the seven
    days (`services/insightsWindow.ts`) and serves them with counts (`GET /observations/days`), so
    the browser never does timezone arithmetic; `?day=` outside the window is a 400 from the API
    and *today* in the page. An empty day points at the latest earlier day with findings -
    measured: 4 of 14 days on kind had none. Null `insights_seen_at` is "nothing seen": the first
    visit after deploy shows the whole window as new, once.
134. **Insights is split into tabs: Alerts, Proposals, Digest, All findings** (the user,
    2026-10-08; queue task 20, after task 19). Each tab answers one question, so a rebalance
    proposal waiting for an answer is never under a day of drawdowns. **Alerts** is what was
    pushed - observations whose notification was routed `push` (`notificationPolicy.ts`), i.e.
    what Telegram sent, plus what quiet hours deferred, marked as deferred. **Proposals** is what
    waits for the user, with a count badge; `/proposals` keeps working (it redirects to the tab,
    as `/?severity=` redirects today, decision 123) and `/proposals/$proposalId` stays a page.
    **Digest** is today's tab. **All findings** is today's observations feed, filters and all.
    Tab and filters stay in the address (`?tab=`). *Rejected:* keeping one feed with a filter for
    each category - the categories are different questions (was I told, what do I owe an answer
    to, what happened), and a filter left set hides the one that matters.
    **Built 2026-10-11, with the user's answers.** Alerts takes **every** pushed finding - the main
    portfolio's, topics', and the agents' trade proposals, each naming its agent - with **source
    pills (All, Portfolio, Topics, Agents)** in the address (`?tab=alerts&source=agents`): one place
    answers "what was I told?" and a pill narrows it (the user's addition). A push the channel could
    not deliver is listed as *Not delivered* - on kind every push fails (no bot), and hiding them
    would read as "nothing to tell". Below-floor and muted digest entries are not alerts. Served by
    `GET /notifications/alerts` (behind the existing `/notifications` gate; SQL in
    `db/queries/alerts.ts`). Alerts is the default tab; `?tab=observations` stays the address of
    *All findings* so links since UX3 still work. **Proposals left the bar**: its open count moved
    onto the Insights item and the Proposals tab. The narration-health notice is not an alert.
135. **No IBI work until the MCP connection is proven** (the user, 2026-10-08). The proposal put
    the Excel column mapper first ("plan B", useful on its own); the user reversed that: nothing
    IBI is built - mapper, migration, OAuth, UI - until the §0 probe of
    `docs/PROPOSAL-IBI-SYNC.md` shows a third-party MCP client can connect to IBI's server and
    list its tools. Plan B is moot anyway: the user cannot export holdings to Excel. **Probe so far
    (another session, 2026-10-08):** sign-in is Auth0 at `auth.ibi.co.il`, which advertises
    `/oidc/register` (possibly disabled); ChatGPT's resource `https://api.ibi.co/mcp` is an Auth0 API
    identifier that does not resolve; the real server URL is unknown and access is ChatGPT-only.
    Guessing IBI hosts or paths was refused as scouting - use public sources only, and ask the user
    before any client registration. The user will not contact IBI support. A one-time scheduled
    task, `ibi-mcp-support-check`, runs 2026-10-15 09:00 Israel time. *Why it matters:* a mapper
    built for a sync that never connects is code with no caller.
136. **The ledger charges IBI's published US fee: 1¢ a share, at least $7.50** (the user,
    2026-10-09; D76). From the IBI SMART terms of use, clause 2.2.3. The user ruled it *outside*
    decision 135's gate - it is a simulation price, not an IBI connection. Fees jumped fivefold on
    small trades, so fewer small proposals afterwards is expected; do not chase it as a bug.
137. **Backups are a host script on a launchd schedule, not an in-cluster CronJob** (the user,
    2026-10-09; database sprint DB1). The rule that decides it: **a backup must not share a
    failure domain with what it backs up.** On a real cluster the standard answer is a CronJob (or
    an operator) shipping dumps to object storage *outside* the cluster. Here there is no object
    storage, and kind's volumes live inside the node container, so an in-cluster CronJob writing
    to a PVC dies with the database in the one event most worth surviving - `k8s-down.sh`, or the
    Docker VM's disk. Getting a CronJob's output onto the Mac needs a new `extraMounts` entry, and
    mounts are fixed when the cluster is created: recreating it to add one destroys the very data
    that has no backup yet. The host script reaches both compose and kind (compose holds the longer
    history), writes where Time Machine can see it, and is the same command `k8s-down.sh` runs
    first. launchd, not cron, because launchd runs a missed calendar job once when the Mac wakes;
    a Mac that is off all day still misses that day, which is why the startup scripts warn on a
    stale backup. *Revisit* if this ever runs on a real cluster: then a CronJob to object storage
    is right, and this script becomes its local fallback.
138. **`intents` is never read, and is kept on purpose** (the user, 2026-10-09). It is the audit
    trail of approvals and revocations: rows are inserted and marked revoked
    (`db/queries/proposals.ts`), never selected by the app. **It is not passive, though:** the
    partial unique index `intents_one_live_per_proposal` is what refuses a second live approval of
    one proposal, and `intents -> proposals ON DELETE RESTRICT` keeps an approved proposal from
    being deleted. Do not drop the table or that index as dead code. `intents_ledger_idx (user_id,
    created_at DESC)` has no reader; whether to keep it for a future audit view is a DB4 question.
139. **`telegram_bind_tokens` needs no cleanup job** (the user proposed one 2026-10-09; dropped
    on the measurement). It is not a table of link codes: minting a code writes nothing - the code
    carries its user, expiry and nonce under an HMAC (`telegram/bindToken.ts`) - and a row is
    written only when a code is *redeemed*, as the used-nonce record that makes it single-use.
    It grows by one row each time the user connects Telegram (0 rows on 2026-10-09). If it ever
    needs bounding, delete nonces older than `BIND_TOKEN_TTL_MS` inside the redeem transaction
    (an expired code can no longer verify, so its nonce is safe to forget), as `llm_calls` prunes on
    insert - not a scheduled job, which must exist in compose, the cluster and `scheduler.ts`.
140. **Agents are never hard-deleted; the foreign keys say so and stay as they are** (2026-10-09,
    database sprint audit). Deleting an agent would cascade to `agent_cash`, `cash_movements` and
    `llm_calls` but be refused by `fills`, `runs`, `observations` and others (`NO ACTION`). That
    asymmetry is harmless because no code deletes an agent - its `state` becomes `archived` - so it
    is recorded rather than "fixed": a change to cascade would make a stray delete erase a ledger.
    Likewise the ledger tables (`fills`, `cash_movements`, `agent_scans`, `proposal_attempts`)
    refuse a user's deletion on purpose; the database function `reset_account` (0045) is the only
    path by which the ledger loses a row, and it keeps every erased row in `account_resets`.
141. **Retention and new indexes wait for a measurement** (the user, 2026-10-09). At the measured
    volumes no table needs a retention policy: `llm_calls` already prunes on insert, `ops_events`
    is bounded by its `dedupe_key`, and **`admin_audit` is never pruned** - an audit log with a
    retention window is not one. `runs` is the one table that grows (~130 rows a day) and is
    revisited in DB4. Indexes likewise come from a week of `pg_stat_statements`, not from guesses:
    at these sizes the planner ignores a composite index on a time window anyway.
142. **The schema's split stays as designed** (the user, 2026-10-09): `llm_model_choices` remains
    its own table for its change history, and the ledger, news, proposals and corpus tables keep
    their separate domains - no consolidation was found worth its migration.
143. **DB4 is split: decide from code now, from statistics after a full week** (the user,
    2026-10-11). The review was asked for 29 minutes into the window (07:56 -> 08:25 UTC), when
    35 non-unique indexes on each environment showed no scans - including both HNSW indexes,
    whose readers are searches nobody had run yet. A finding that reading the code settles
    (decision 144) does not wait; dropping an index or pruning a table does, because a weekly
    CronJob or a weekend may be its only reader. **Read the second half's numbers knowing what
    adds to them:** each nightly backup is a `pg_dump` - one sequential scan of every table and a
    `COPY ... TO stdout` per table at the top of section 1 - and so was the Insights session's
    rehearsal copy (`traders_t21`, compose, 08:14 UTC), and #216's redeploy restarted the
    services (the universe loader's startup reads show in `instrument_profiles`, `instruments`).
    Seven dumps a week is seven scans per table that are not the app's.
144. **`runs`' full scans were `IS NOT DISTINCT FROM`; rewritten, no index added** (the user,
    2026-10-11; #218). `claimRun`'s reclaim `UPDATE` and its status `SELECT` matched the agent
    null-safely, which no index can serve, so every refused claim read the whole table - the
    ~700-row scans of 2026-10-09. `agent_id = $n OR ($n IS NULL AND agent_id IS NULL)` folds to
    one branch once bound (node-pg's unnamed statements get custom plans) and
    `runs_agent_run_key` answers it: on kind, Seq Scan cost 90 -> Index Scan cost 8. A
    `runs(run_key)` index was rejected: it duplicates the unique index on every insert. *Lesson:
    `IS NOT DISTINCT FROM` in a `WHERE` is a sequential scan; the two remaining
    (`narration.ts`, `corpus/ingest.py`) are on rows already narrowed or 36 documents.*
145. **`db-report.sh` counts rows with `pg_class.reltuples`** (the user, 2026-10-11; the DB4
    record PR). `--reset` calls `pg_stat_reset()`, which zeroes `n_live_tup`, so every table
    read as empty after the window opened. `reltuples` is the planner's estimate, refreshed by
    `ANALYZE` and untouched by a reset. Dead rows stay `n_dead_tup`, relabelled
    `dead_since_reset` because that is what it then counts.
146. **`traders_m5` is dropped; a scratch copy is restored from a dump when a branch needs one**
    (the user, 2026-10-11). It was compose's copy for native branch migrations, frozen at 0022
    since 2026-09-24 - 137 MB that nobody could trust. The user runs the `DROP DATABASE`. Make a
    fresh copy as "Running a branch's orchestrator against a copy of the live DB" says (or
    `pg_restore` the newest dump into a new database), and drop it after. `traders_ci` stays:
    it is the local integration-test recipe.
147. **No backup leaves the laptop, by the user's choice** (2026-10-11, asked the third and last
    time). A lost or dead Mac loses the simulated history, which decision 137 already priced as
    one cheap failure among many. Do not ask again; revisit only if real money or a real
    broker's data ever lands in this database.
148. **A move and a drawdown on one holding, from one scan, are one Telegram message** (the user,
    2026-10-15, after OUST's 9.51% fall arrived as two messages stating the same price twice).
    Decision 132 merged the move with the sigma move but left the drawdown separate, and that
    separation is right for the **feed**: the drawdown has its own episode, and "fell today" and
    "below its 30-day high" are different questions. So the merge is in the **fan-out only**
    (`holdingAlerts.ts`, called by `fanOut`): the pair is routed once at its stronger severity,
    each half keeps its own `notifications` row and dedupe key, and both rows settle with the one
    send. *Rejected:* a merged observation kind in the AI service (episodes, dedupe and Insights
    would all have to learn it) and stitching the two stored texts into one bubble (fixes the
    count, not the repetition). **The sentence is the catalogue's** (`moveWithDrawdown` in
    `notify/messages.ts`), filled from both observations' evidence through `Intl` - the user chose
    this over the stored model-written texts. When either evidence lacks a figure the sentence
    states, the pair is sent as two messages in their stored words rather than with a figure
    missing. Only pairs from the **same scan** merge; when an earlier run already sent one half,
    the other goes out alone. Market-relative context ("the whole market was red") is a separate,
    open question: it needs benchmark prices the scan does not collect. *(Answered by 149.)*
149. **A move is framed by the market, never muted by it** (the user, 2026-10-15, after OUST alerts
    on a red day). Measured first: the move rules replayed day by day over the real portfolio on
    compose, 2026-09-15..10-14 - **136 alerts in 22 trading days**. SPY moved >= 1% the same way
    for only 31 of them, and never 2%. SPY is also the wrong index for this portfolio: on 10-14 it
    fell 1.08% while QQQ and IWM fell ~2% and SMH 4%. **Rejected: muting.** A beta-adjusted mute
    would have silenced OUST's 9.51% fall that day (QQQ -1.97% at beta 3.7 leaves a 2.2% residual),
    and EOSE's 15% and IREN's 12% with it - it fails in the expensive direction, against the
    user's "a 6% fall is never invisible" (132). **So a move gains one line:** "Same day, the
    Nasdaq-100 (QQQ) fell 1.97%." The **benchmark is chosen per holding by R²** of daily returns
    over the 90 days before the move (>= 20 pairs): SPY, QQQ or IWM for an equity, BTC-USD for a
    crypto pair, never the holding itself (`market_context.py`). It is said only when that index
    moved **>= 1% the same way on the same pair of days**; a benchmark not priced that day says
    nothing rather than a stale figure. On the replay this frames **45 of 136** (33 QQQ, 7 IWM,
    5 SPY), all 14 on 10-14. No R² floor and **no beta sentence** ("about what its sensitivity
    predicts") - the user's choice: most names fit poorly (MNDY 0.02, TWLO 0.05), so a
    prediction would be weak; the line states a fact, not a cause. **Drawdown is exempt**: it is
    a fact about the position since its high. The figures live in the move's evidence
    (`market` block), so narration and the validator see them; Telegram adds the line from the
    catalogue (`marketLine`, en + he) under a lone move and a merged pair alike. **Prices:** the
    orchestrator owns the list (`MARKET_BENCHMARK_SYMBOLS`), backfills their closes hourly and
    records a live quote on every portfolio scan, because a holding's move is often measured on
    an intraday dashboard price and the benchmark needs a price the same day. *Not done:* the web
    feed and the digest do not show the line (the evidence is there for them); thresholds are
    `ANALYSIS_MARKET_*` settings.
150. **A failed backfill is retried within its day** (the user, 2026-10-15, found while verifying
    149: compose's 05:53 UTC backfill failed right after the Mac woke, and QQQ/IWM/BTC-USD's
    10-14 closes were missing until a manual run under its own key at 08:25). Measured first:
    compose had **3 failed backfills in 25** since 2026-09-16 (10-02, 10-05, 10-15), every one
    "AI service unreachable: Internal Server Error" on the first ask after a wake, and every
    other kind ran clean within the hour - the next hourly ask would have worked, but the daily
    key was taken. Kind: 0 failed in 17. **So the route passes `retryFailed` for the kinds in
    `RETRY_FAILED_KINDS`** (`routes/internal.ts`; today only `backfill`), the same re-claim the
    rescreen already had; the scheduler's and the CronJob's hourly asks are the retry. A
    day-long outage costs at most ~24 provider passes instead of 1. *Rejected:* a capped retry
    count (an attempt counter in `claimRun` for a cost the quota absorbs) and leaving it (the
    next day's 30-day backfill does catch up, but a day of stale benchmarks once every ~10 days
    is what 149's line would read). **`degraded` is not retried** - a symbol without history
    stays so. **Not the other daily kinds:** a failed digest may already have sent part of its
    message, and discovery/metadata have not failed.
151. **`instrument_profiles_embedding_idx` (HNSW) is dropped** (the user, 2026-10-18; DB4's second
    half, 0053). A full week (2026-10-11 07:56 -> 10-18 08:12 UTC) showed it never scanned on
    either environment, and unlike 143's 29-minute reading, its reader *did* run: topic
    matching's `search_profiles`, 9 calls on compose at ~514 ms. The planner was right to refuse
    it. `EXPLAIN ANALYZE` on compose, read-only: the default exact scan answered LIMIT 200 in
    **264 ms with 200 rows**; the index, forced (`enable_seqscan`/`enable_sort` off), took **2.8 s
    and returned 199** - an HNSW scan is approximate and its `WHERE` filters after it searches.
    It was 41 MB on each environment, ~40% of `instrument_profiles`, and every embedding write
    and every restore paid for it. *Rejected:* keeping it for a larger universe - a rebuild takes
    seconds at this size and the downgrade is 0015's statement. **Revisit past ~50k screened
    profiles.** `search_profiles` keeps its `SET LOCAL hnsw.ef_search` (inert now, honest if the
    index returns). **`kb_chunks_embedding_idx` stays**: under 1 MB, /ask's retrieval ran twice on
    compose (none on kind), and the corpus is the table that grows by design.
152. **Two indexes with no reader in the code are dropped; `intents_ledger_idx` is kept** (the
    user, 2026-10-18; 0054). `articles_content_hash_idx` (6.9 MB on compose, paid on ~5k article
    inserts a day): dedupe loads the 48 h window's hashes and matches in memory
    (`news/queries.py` `load_known_hashes`), so no statement looks a hash up.
    `instrument_profiles_search_idx` (2.6 MB GIN): nothing queries `instrument_profiles.text_search`
    - the only `@@` is on `kb_chunks`; the generated column stays (dropping it rewrites the
    table). `intents_ledger_idx` (16 kB, no reader, decision 138) is kept: it costs nothing and a
    per-user audit view (M9) is its obvious reader. **Every other never-scanned index is kept on
    purpose** (~25 of 8-16 kB): each has a reader in the code - feed, digest, proposals, ledger,
    `kb_chunks` GIN - on tables of under ~100 rows per user, where the planner rightly scans;
    M9's users are what makes them selective. *Lesson: "never scanned" splits three ways - no
    reader (drop), a reader the planner rightly refuses at this size (decide on measured
    plans), a reader on a tiny table (keep). Only the first is read off the report.*
153. **`runs` is not pruned yet; revisit on a trigger** (the user, 2026-10-18). Measured: ~100
    rows a day (60-240; up from 10-11's 29-37 since `agent_scans` and `proposal_sweep` tick for
    a funded agent), kind 1,943 rows / 1.7 MB, compose 2,905 / 2.6 MB, ~0.1 MB a day - ~40 MB a
    year. Its readers use indexes (#218) or are bounded (the admin view, LIMIT 400, 22 ms). Run
    rows are the idempotency record and the "what ran when" answer, so pruning has a cost the
    size does not yet repay. **Revisit when `runs` passes 50 MB or 100k rows on either
    environment, or a `runs` statement enters the report's top 15 by total time.**
154. **`articles` gets an index for the collector's window read** (the user, 2026-10-18; 0055).
    The week's top app statement on compose was `load_known_hashes` - `SELECT url_hash,
    content_hash FROM articles WHERE fetched_at >= :since` (48 h): 133 calls, 149 ms mean, 24
    of the 117 slow-log lines, and with no index on `fetched_at` every 30-minute collect read the
    whole table (`articles` seq-read 27 M rows in the week). Nothing prunes linked articles, and
    the table grew 44k -> 86k rows since 10-09 (~4.6k a day), so the cost grows linearly - ~3 s
    a collect within a year. **Amended the same day, after measuring:** a plain
    `articles (fetched_at)` index (`articles_fetched_idx`, 0055), not the covering `INCLUDE (url_hash,
    content_hash)` first proposed. On a copy of compose restored from the 10-18 dump (D146; 85,251
    articles, a 10,708-row window): full scan 101 ms cold / 20 ms warm; covering index 8.7 / 1.6 ms
    at **15 MB**; plain 4.8 / 2.4 ms at **616 kB**. Rows arrive in `fetched_at` order, so the heap
    pages a window needs are few and adjacent. *Lesson: a covering index over hash columns is
    mostly hashes - measure the plain one first when the table is insert-ordered on the key.*
    *Rejected:* waiting for a 500 ms trigger (the growth is certain and the fix small) and articles retention instead (linked articles are evidence behind observations - its own
    question if size ever asks it). The `coalesce(published_at, fetched_at)` reads (the daily
    headline window, 705 ms; the market prune, 25 ms) are left alone. **Asked alongside, not
    decided:** news does not feed the universe - matching is a closed set by design
    (`news/entities.py`), topic discovery turns headlines into topics resolved *against* the
    universe. A possible follow-up: list discovered topics that match nothing well as
    candidates for on-demand profiling, each approved by the user.
155. **M9's users are trusted people on the self-hosted installation; the user is its one admin**
    (the user, 2026-10-18). Household members and friends, reached the way the installation is
    reached today - Tailscale, compose ports on 127.0.0.1 - never the public internet. Being on the
    tailnet is the first gate; the admin's approval (156) is the second. This sets the threat model
    for the rest of M9: mistakes (one user seeing another's rows), not attackers. *Rejected for M9:*
    invited strangers - that is internet exposure, abuse handling and other people's financial
    data, and it is **M10** (OAuth, self-signup, free-tier limits, self-service password reset)
    without changing the data layer, which M9-MEASUREMENT showed is already tenant-safe.
156. **A new user signs up and waits for the admin's approval** (the user, 2026-10-18). Signing up
    writes a `users` row in state `pending` and sends the admin a Telegram message with three
    buttons: *Approve with the default budget*, *Reject*, *Custom budget* (a reply asks for the
    amount). The Admin page can do the same. Approval sets `active` and the spend cap (157).
    **Settled alongside:**
    - **A pending user has no agent and no scans.** Today `users_seed_primary_agent` creates the
      primary agent on `INSERT`; it moves to the transition to `active`, so the scheduler never
      works for someone not yet approved.
    - **A rejected request is kept as `rejected`**, not deleted: the same email cannot ping the
      admin again, and the Admin page can undo it. *Rejected:* deleting it - every retry is a new
      Telegram message.
    - **The signup route is the one page that works signed out**, and each submission messages the
      admin, so it is limited: one pending request per email, and a small installation-wide
      ceiling on pending requests at once.
    - The Telegram callback names the request by a signed token, never a bare user id (as the
      bind token does today).
157. **Every non-admin user has a monthly LLM spend cap; the admin has none** (the user,
    2026-10-18). Integer micro-USD on the user (`users`, like `agents.llm_budget_micro_usd`),
    set at approval. The default ($10) is `installation_settings`, editable on the Admin page, not
    a constant. **The month is the user's calendar month, in the user's time zone.** Spent is
    `sum(llm_calls.cost_micro_usd)` for the user since the month began - every call already
    carries `user_id` (measured 2026-10-18 on compose: 355 of 355, all four purposes), so nothing
    new is attributed. It sits above what exists: the per-agent daily allowance and the
    per-user assistant allowance still apply underneath, and `LLM_DAILY_BUDGET_USD` still guards
    the installation, the admin included. *Rejected:* a daily cap (the period of the existing
    allowances; $10 a day is not a household budget) and a lifetime balance the admin tops up.
158. **The cap is enforced before each call, and a capped user's alerts still arrive** (the user,
    2026-10-18). "Before" is the only honest form of strict: a call's cost is known after it
    returns, so the check is `spent + the call's maximum cost (its max_tokens at the model's
    price) > cap` -> refuse. An agent scan and an `/ask` turn are refused with a reason code the
    UI explains (the user's language, guideline 1). **Narration falls back to the template**, as
    it does for the installation ceiling today: the observation is still written and sent,
    explained by its template wording. *Rejected:* refusing all model work, which would silence
    portfolio alerts for a budget reason - guideline 7 says nothing is hidden.
159. **Login is email and password, hashed with argon2id from a maintained package** (the user,
    2026-10-18). Convention 5: the user approved the dependency by choosing this; the package is
    named in the PR (`@node-rs/argon2` is the likely one - the orchestrator owns login). The
    shared `APP_PASSPHRASE` goes away; the seeded admin gets an email and password from a
    one-time script, never from a committed value. *Rejected:* a one-time code over Telegram -
    a pending user has no binding to send it to.
160. **Sessions stay a signed cookie; every request checks the user** (the user, 2026-10-18).
    The cookie gains `ver`, copied from a new `users.session_version`. Each authenticated request
    reads the user by primary key and accepts the session only if `status = 'active'` and the
    versions match. So disabling or rejecting a user ends their sessions on the next request, and
    a password change bumps the version, ending every session they hold. `users.status` gains
    `disabled` for this - the reversible removal. The admin read of `users.role` per request
    (M8) becomes this same read. *Rejected:* a sessions table (per-device sign-out and a session
    list, at the cost of a table, a cleanup job and the same per-request read - revisit in M10 if
    per-device sign-out is wanted) and a short-lived cookie (removal would take up to its
    lifetime, and everyone re-signs-in constantly). *Lesson from deciding it: "a session table"
    is the reflex, but the requirement was "end at once"; a stateless token plus one read of a
    row you already read for the role meets it.*
161. **Scheduled work names who it is for; scans interleave; shared work runs once** (the user,
    2026-10-18). Three parts, from M9-MEASUREMENT §2:
    - **Fan-out is explicit.** The timer and the 11 CronJobs send `for: "every_active_user"`;
      `POST /internal/runs` expands it into one run per `active` user, each keyed and dated in
      that user's zone (the "ask often, the run key decides" pattern already works per user). A
      body naming neither a user nor `every_active_user` is refused 400 - the `SINGLE_USER_ID`
      fallback goes. *Rejected:* "no user means everyone" - a mistyped call would quietly do
      everyone's work, the same silent default M9's exit removes.
    - **Scans are interleaved at enqueue.** Every user's due scans are planned first, then added
      round-robin (A1, B1, A2, B2...) to the one BullMQ queue. Not strict fairness, but with a
      few users bounded by `max_agents_per_user` the worst wait is a few scans. *Rejected:*
      expanding users in order (the same user always waits) and BullMQ Pro groups (D73: a paid
      licence for a problem a household does not have).
    - **Installation work runs once, with no user,** as the rescreen already does:
      `backfill` and `news_collect` over the union of every active user's instruments plus the
      benchmarks; `instrument_metadata` and `proposal_sweep` (already unscoped) as they are. Their
      run keys carry the installation's day (`APP_TIMEZONE`). The per-user kinds - `snapshot`,
      `portfolio_scan`, `topic_scan`, `topic_discovery`, `daily_digest`, `agent_scans` - fan out.
      *Rejected:* per-user runs of these - N identical fetches into shared tables.
162. **The admin sees operations, never a user's finances; each user resets their own account;
    the admin can set a one-time password** (the user, 2026-10-18).
    - **What the app shows the admin of another user:** a user list (status, cap, spent this
      month, last sign-in), and runs, gaps and LLM calls per user - cost, tokens, outcome, never
      prompt or completion (already so, `llmCalls.ts`). Holdings, proposals, observations, agents
      and `/ask` conversations are not shown. Accepted leak: a price gap names its instrument,
      which can reveal a holding - the admin needs it to fix the gap. *Rejected:* a read-only
      "view as user" (every household member's finances in the admin's view).
    - **Said plainly, so nobody believes otherwise:** the operator of a self-hosted installation
      can read the database - holdings, conversations, stored prompts. This is a promise about
      the app's interface, not a technical wall.
    - **Account reset is the user's own**, moved out from behind the admin gate
      (M9-MEASUREMENT §8); the admin cannot reset another user's account.
    - **A forgotten password:** the admin sets a one-time password, which the user must change at
      the next sign-in; setting it bumps `session_version` (160), ending their sessions.
      *Rejected:* nothing until M10's self-service reset - a forgotten password would lock a user
      out, or be fixed by hand in the database.
163. **A user's zone comes from their browser at signup; "today" is the user's, the market and
    the installation keep their own clocks** (the user, 2026-10-18).
    - **Set:** signup prefills `Intl.DateTimeFormat().resolvedOptions().timeZone`; Settings edits
      it; the server accepts only a valid IANA name. *Rejected:* the admin entering it at approval
      (one more field, and the admin may not know it) and Settings-only with the installation's
      default (a user abroad who never opens Settings gets Jerusalem's day and quiet hours).
    - **Already the user's** (M9-MEASUREMENT §6): run keys, the digest's "today", quiet hours.
      **Moved to the user's:** the AI service's two `APP_TIMEZONE` reads - the assistant's
      next-scan answer and its allowance's midnight (`routers/assistant.py`).
    - **Stays per installation, on purpose - do not "fix":** agent scan slots on the market's
      clock (`scanSchedule.ts`: read from the session, 10:00 is the open + 30 min); installation
      runs (161) and the rescreen on `APP_TIMEZONE`'s day; `LLM_DAILY_BUDGET_USD` on the UTC
      day (it models the provider's bill).
    - **Guideline 10 is amended** in the PR that moves the two reads (so the guideline never
      describes code that is not there): "today" resolves in the user's zone
      (`users.timezone`); installation clocks use `APP_TIMEZONE`.
    - **A zone change mid-day is accepted, not engineered around:** run keys are kind + user +
      local date, so on the day of the change one daily run (the digest) may run twice or not
      at all, once, for that user. *Rejected:* a pending zone applied at the next local midnight
      (a new state, and the next-scan answer and quiet hours would be wrong until then).
    **M9's decisions are complete (155-163).** Next is code, PR by PR, in MILESTONES' order.
164. **The sector/industry taxonomy is built from our own universe, not fetched from Yahoo**
    (the user, 2026-10-18; 0056, agent template creator PR 1, #252). `universe_taxonomy` is rewritten
    from screened `instrument_profiles` inside every universe load (startup loader and rescreen,
    same transaction, write-free when unchanged as DB2 requires). Measured on kind: 2,535
    equities over 11 sectors / 142 industries, 2,689 ETFs over 115 categories, 3 with neither.
    **ETFs have no sector, only a category**, so the categories about one sector are mapped onto
    the 11 equity sectors in `app/universe/taxonomy.py` (14 mapped; "Infrastructure" and
    "Miscellaneous Sector" deliberately not), and every other category is listed as sectorless;
    a contract test holds both lists to the committed snapshot. A category a rescreen brings that
    nobody has classified is stored with no sector and reported (`taxonomy_unmapped`), never
    guessed. *Rejected:* Yahoo's full `yf.Sector(...).industries` list - extra calls on every
    rescreen, and it offers industries with no member, so an agent could be restricted to
    nothing. **yfinance has no sub-industry**; two levels is what exists.
165. **An agent's position and universe rules are enforced in code; tone, horizon and risk go to
    the prompt** (the user, 2026-10-18; agent template creator PR 2). Max position, cash buffer,
    max holdings, ETF ban, market caps, sectors/industries and the ticker lists are checked
    after `price_answer`, before a proposal is saved. A rule written only into the prompt is a
    suggestion the model sometimes ignores, and a simulated portfolio compared with the real one
    would then be wrong silently. Sells are always allowed, so tightening a rule never traps a
    position. Null means no limit: existing agents behave as before until edited.
166. **No "Day Trading" horizon** (the user, 2026-10-18). A scan runs at most twice a session on
    daily closes and proposes one trade; a day-trading label would test something the agent
    cannot do. Three horizons (short, medium, long), each setting a default scan schedule the
    user can change. Real intraday is its own milestone, with its own cost.
167. **"Topics" keeps its name; the new agent field is "Sectors & industries"** (the user,
    2026-10-18). A topic is a user's theme with confirmed instruments, which crosses sectors
    (uranium is miners, utilities and ETFs); a sector is Yahoo's fixed label used as a filter.
    One name for both would make them look interchangeable. Restricting an agent to a topic is a
    possible follow-up, not part of this.
168. **Templates are presets; the settings live on the agent** (the user, 2026-10-18). The four
    built-in personas (#249) gain full parameter values and fill the whole form; the agent stores
    its own copy, so a template change never rewrites an agent. Settings stay editable and apply
    to future proposals only; a holding above a new limit is reported, never sold (there is no
    execution). *Rejected for now:* user-saved templates (a table, CRUD and a manager for a
    handful of agents) - "duplicate this agent" covers it more cheaply if it is ever needed.
169. **The 1-10 risk slider proposes rule values and gives the prompt a five-word band** (the
    user, 2026-10-18). Moving it fills max position, cash buffer and max holdings; a rule the
    user edited by hand is never overwritten (the #249 rule for persona text). The model gets
    Ultra-conservative / Conservative / Balanced / Growth / Aggressive, which it can act on,
    rather than a number it cannot tell from its neighbour. *Rejected:* a prompt-only slider,
    which can contradict the hard rules beside it.
170. **Thesis style and the persona both stay; the persona becomes "Additional instructions"**
    (the user, 2026-10-18). A contradiction with a hard rule loses to the code check; one with a
    prompt-only setting is settled by the model, inconsistently. So: the label says it cannot
    override the settings, the prompt ranks settings above it, a proposal the check rejects is
    sent back once in the same scan ("breaks rule X - propose again or pass"), and saving runs
    one model call that warns - never blocks - when the instructions contradict the settings.
171. **Position and cash limits are a share of capital at cost: cash plus holdings at cost** (the
    user, 2026-10-18; 0057, template creator PR 2). The request said "% of cash", which limits
    trade size, not position size - cash shrinks with each buy, and ten 10% buys can all land in
    one stock. Capital at cost uses only what the ledger holds exactly (cost basis is per unit),
    so no unpriced holding makes the rule unanswerable (guideline 7). The position after a buy is
    its cost so far plus the new notional; the buffer is cash after notional **and fee**.
    Compared exactly (`after * 10000 > bps * capital`), never rounded. *Rejected:* market value
    (needs a live quote for every holding at check time) and per-trade % of cash.
172. **Market-cap bands apply to equities; the selection matches by sector or industry, an ETF by
    category or its category's sector** (2026-10-18, PR 2, under 165/171's grant). Bands from
    stored `market_cap_minor`: mega >= $200B, large >= $10B, mid >= $2B, small below (the screen's
    $1B floor bounds it). An equity with no stored USD size is refused while a band is set -
    "unsized" is not assumed to fit. ETFs have no market cap, so bands never touch them; the ETF
    switch does. A sector ETF ("Equity Precious Metals") is inside its mapped sector (164); a broad
    one ("Large Blend") only by naming its category. Names are refused at the API unless
    `universe_taxonomy` holds them, so a typo cannot restrict an agent to nothing.
173. **No whitelist; the blacklist stays** (the user, 2026-10-18). An agent's job is to find ideas in
    its universe; a ticker allow-list makes it a timing bot for names already chosen, and with a
    holdings cap and a cash buffer it can leave an agent nothing to do, scan after paid scan. The
    sector selection and the blocked list cover the real needs. Revisit only on a concrete need.
174. **Settings alone are enough to scan by; the form writes the instructions from them** (the
    user, 2026-10-18; template creator PR 3). The persona became "Additional instructions", so an
    agent built from the form with no words must not sit at "Waiting for a persona". One rule now:
    ready = instructions **or** any mandate setting (`Mandate.is_set` / `agentReadiness.ts`, a
    contract test holds their column lists equal; the refusal code stays `no_persona` for the
    wire, `waitingForPersona` became `waitingForBrief`). A blank agent still never scans or bills
    (D52). The form fills the instructions from the settings in code (no model), in the UI
    language, **in words, never figures** - a limit changed later must not leave a stale "10%"
    in the text for PR 4's warning to find - and only while the text is empty or still exactly
    what it last wrote; once edited it is the user's, with "Rewrite from settings" to opt back in
    (the #249 rule). A template's own words are the user's choice, so settings changes do not
    overwrite them. *Rejected:* keeping the persona required (a form that says "optional" and
    then refuses to scan) and rewriting on every change (loses the user's edits).
175. **Downshift for the "Sectors & industries" autocomplete** (the user, 2026-10-18, under
    convention 5). `useCombobox` + `useMultipleSelection`: the WAI-ARIA combobox, keyboard and
    announcements are the library's; grouping by sector, chips and counts are ours
    (`TaxonomyPicker.tsx`). ~10 kB gzipped, headless, React 18. *Rejected:* a hand-written
    combobox (every accessibility detail ours, with no test here that would catch one) and a
    grouped checklist (not the autocomplete asked for).
176. **The contradiction check names conflicts; the catalogue writes the warning** (2026-10-19,
    template creator PR 4, under the user's go-ahead). One model call after a save whose
    instructions are the user's own words (non-empty, not the text the form generated from the
    settings, and changed - or beside changed settings). The model answers `{setting, quote}`
    pairs only; the sentence is `agents.check.conflict` in the reader's language around the quote
    (a `<q dir="auto">`). **A quote the instructions do not contain is dropped** (whitespace is the
    only thing forgiven), as the evidence validator drops unsourced figures: nothing a model
    invents is shown as the user's words. At most three. Guideline 1 keeps server text English
    and the thesis the one model text in the user's language; this keeps it that way.
177. **The check is its own purpose, on the agents' model and the agent's budget; every failure is
    a quiet skip** (the user, 2026-10-19; 0059). `mandate_check` in `llm_calls` (and in
    `llm_calls_scan_names_its_agent`, now "a scan or a check names its agent"), scope `agent`,
    summed with scans in the daily allowance (`scan_budget.AGENT_PURPOSES_SQL` /
    `agents.ts AGENT_SPEND_PURPOSES`) but never in a scan's cost (D46 reads `agent_scans`).
    Budget spent, no model, a provider error, malformed JSON or an unreachable AI service all
    answer `skipped` - the save already happened and never waits on the model. *Rejected:*
    logging it as `agent_scan` (pollutes per-scan cost) and the narration model on the
    installation budget (no per-agent limit).
178. **The result is stored on the agent with a fingerprint; shown until dismissed or changed**
    (the user, 2026-10-19; 0059). `agents.instructions_check` = `{fingerprint, conflicts,
    checked_at, dismissed}`; the fingerprint is SHA-256 of the trimmed instructions and every
    mandate column (`instructionsCheck.ts`, the one implementation). The route re-reads the
    agent after the model call and stores only if the fingerprint still matches, so a save that
    landed meanwhile is never labelled with the old text's answer. `AgentView.instructionsConflicts`
    is non-null only while the fingerprint matches and it is not dismissed; the agents list shows
    an "Instructions conflict" badge, so a warning from the create drawer (which closes) is not
    lost. *Rejected:* form-only display (gone on reload; the create drawer would have to wait).
179. **The admin's email and password come from an explicit script; `APP_PASSPHRASE` is
    retired** (the user, 2026-10-19). `pnpm --filter @traders/orchestrator admin:password`
    (`src/adminPassword.ts`) reads the password from stdin - never an argument, which lands in
    shell history and `ps` - and sets the email and argon2id hash on the one admin. Idempotent:
    re-running sets the same email and a fresh hash, and bumps `session_version`, so it is also
    the "I lost my password" path. `dev-common.sh`, `k8s-up.sh` and CI call it with a generated
    value, exactly where they generated the passphrase. **A redeploy past this PR needs one step**:
    run the script, then sign in. *Rejected:* seeding from `ADMIN_EMAIL` + `APP_PASSPHRASE` at
    startup when the admin has no hash - no manual step, but a password lives in the environment
    for good, and a startup that writes credentials is a surprise nobody looks for.
180. **Signup moves to the approval PR; this one is login, bootstrap, sessions and the one-time
    password** (the user, 2026-10-19). MILESTONES put signup with login, but nobody can answer a
    request until the approval PR: a signup shipped first creates `pending` rows only SQL can
    resolve, and the person who signed up waits with nobody told. *Rejected:* MILESTONES' order -
    harmless (a pending user has no access) but a dead end.
181. **A password is 12 to 128 characters, with no composition rules** (the user, 2026-10-19).
    Length is what resists guessing; rules about digits and symbols push people to `Password1!`.
    The ceiling bounds argon2's input, not security. The rule is `passwordProblem` in
    `packages/shared/src/password.ts`, so the server's refusal and the web form's hint are one rule.
182. **No login rate limit in M9** (the user, 2026-10-19). Users are trusted people over
    Tailscale (D155) and argon2id already costs each guess tens of milliseconds. It is debt that
    M10 (strangers) must pay before the app faces the internet.
183. **The contradiction check names a sentence by number; the server quotes it** (the user,
    2026-10-19; supersedes D176's copied quote). The instructions reach the model as numbered
    sentences (`.`/`!`/`?` + space, or a line break; a colon does not end one) and it answers
    `{setting, sentence}`; the quote is that sentence cut from the user's text, shortened at a
    word past 160 characters. **Why:** the first real check (compose, 2026-10-19) found a Hebrew
    day-trader brief contradicting a long horizon and lost it - Flash-Lite wrote Hebrew as
    `\uXXXX` escapes and its quote read מנויות for מניות, so the exact-match rule dropped it, with
    nothing logged and the call recorded `accepted`. The escapes also made it 354 output tokens
    ($0.00098, more than an average scan); by number it is 21 ($0.00014), conflict kept, and
    Warren's own words still come back clean. *Rejected:* fuzzy matching (still pays the escapes,
    and needs a tolerance someone tunes); only logging drops (Hebrew warnings keep vanishing
    meanwhile). Cost: the warning quotes a whole sentence, not a phrase. A number with no sentence
    behind it is dropped and logged (`agents.mandate_check_no_such_sentence`).

184. **Telegram's *Custom budget* offers preset amounts, not a typed reply** (the user, 2026-10-19;
    supersedes D156's "a reply asks for the amount"). The tap swaps the buttons for $5, $20 and
    $50 a month, an *Other amount* link to the Admin page, and Reject. **Why:** the bot keeps no
    conversation state - a typed reply would need a table or column saying which request it
    answers (migration 0060) and a parser for "25", "$25", "25.50" in two languages. The amount
    instead rides in the signed button, as a trade's Confirm carries its price (cap + 1 on the
    wire, so a $0 cap - approved, spending nothing - fits a varint). *Rejected:* the typed reply.
    Cost: three amounts in the chat; any other is one link away.
185. **Signup gives one answer whatever the email already is** (the user, 2026-10-19). New,
    already waiting, rejected or an existing account: all get "Request received", and only a new
    email messages the admin - a rejected person asking again pings nobody, as D156 intended. At
    the limit on waiting requests the answer is "Sign-up is closed right now", which says nothing
    about any account. The hash is computed for every email and the Telegram announcement is not
    awaited, so the time taken does not tell them apart either. *Rejected:* honest answers per
    state - friendlier, but anyone on the tailnet could test whether an email has an account, and
    login already refuses to say (D159). Someone who forgot they asked learns their state by
    signing in (D187).
186. **Signup is merged in order but redeployed only together with the cap's enforcement**
    (the user, 2026-10-19). Until the cap PR, an approved user's `llm_cap_micro_usd` is stored
    and checked by nothing; what still bounds them is the per-agent daily allowance ($0.50, up to
    3 agents), the assistant's $0.50 a day and `LLM_DAILY_BUDGET_USD` - about $2 a day at most.
    **Do not redeploy past the signup PR without the cap PR also merged.** No code enforces this:
    redeploys happen only on the user's word, so the rule is this sentence and the handoff's.
    *Rejected:* no rule (the gap reaches a running system) and the cap PR first (signup waits a
    PR for an ordering the redeploy already gives).
187. **A waiting user is told so at sign-in; nobody else's state is spelled out** (the user,
    2026-10-19). With the right password, `pending` gets its own sentence ("waiting for the
    admin's approval", code `account_pending`); `rejected` and `disabled` keep the generic "not
    active - ask the admin" - a rejection can be undone, and a household member need not read
    "declined". There is no channel to tell someone they were approved (no binding, no email
    before M10), so two sentences carry it: the Request received screen says they can sign in
    once approved, and the admin's Telegram outcome line says "Approved with $X/month. Let them
    know they can sign in." *Rejected:* a "check my status" page - it would have to answer
    without a password, undoing D185.
188. **The Admin page decides requests with the same transitions as Telegram; neither keeps
    message state** (the user, 2026-10-19). A *Sign-up requests* card first on the page: each
    waiting request with its email, zone and age, a cap field prefilled with the default, Approve
    and Reject; rejections folded below with *Undo rejection* (back to `pending`, outside the
    waiting limit, no message - the admin is the one doing it). The default cap and the waiting
    limit (0 closes sign-up) are two fields in Admin settings. A count on the Admin link and a dot
    on the closed account menu while requests wait. **Every decision is an UPDATE conditional on
    the state it starts from**, so Telegram buttons need no nonce table: a replay, a second admin
    tab or a tap on a message already decided on the page changes nothing and is answered with
    where the request is now - and the stale buttons are removed then, as a stale proposal
    message heals. Telegram decisions write `admin_audit` before applying, as the page's gate
    does. *Rejected:* listing requests inside the admin's user list now (that PR's scope, D162),
    and editing the Telegram message when the page decides (it would need the message ids
    stored).
189. **An answer whose only fault is an unsourced figure goes back to the model once** (the user,
    2026-10-19; beside D170's mandate retry, not sharing it). The message names each figure and
    asks for figures copied as given, or none; the first reply keeps its `unsourced_figures`
    verdict, a second failure is `invalid_answer` with the second answer stored. Any other fault
    (malformed, not tradable, oversold, cash) is still final. The figures and the mandate each
    get one chance: at most three answers a scan. A figure is reported without a hyphen glued
    to a letter (`_as_written`), so Hebrew's "ב-39.69" reads "39.69", not "-39.69"; matching
    was already sign-blind. **Why:** "agressive"'s first scan (compose, 2026-10-19) chose to buy
    3 IRON on a Phase 3 jump and was thrown away whole for writing 39.69% where the quote said
    39.6987 - truncated, not rounded - and the validator said "-39.69". One slipped decimal cost
    a scan's only decision. *Rejected:* accepting truncation (loosens guideline 7 for every
    narration, `/ask` included); naming the nearest evidence value in the message (an invented
    figure would be handed a plausible number to paste - one belonging to another stock or
    window - and pass a check it should fail); one retry shared with the mandate's (a fixed
    thesis that then breaks a limit would get no chance). Cost: ~$0.001 per extra answer at
    Flash-Lite rates, inside the agent's daily budget.
190. **Yahoo's taxonomy names are translated on the web, in a map keyed by the English name** (the
    user, 2026-10-19/20, after #262 left it open). `apps/web/src/i18n/taxonomy/he.json` holds all
    262 names (11 sectors, 142 industries, 115 ETF categories; six names are both a sector and a
    category and share one entry), read through `i18n/taxonomyNames.ts`. **Why:** only the web
    shows these names - Telegram, the digest and the server's sentences never name a sector - so a
    server table would be a migration and a join for text no server shows. *Rejected:* a server
    table or `localized` column (it has to come from a committed map anyway, because
    `universe_taxonomy` is rebuilt from profiles on every load); the i18next catalogue (names like
    "Foreign Small/Mid Blend" or "Trading--Inverse Debt" make poor keys, and English would carry 262
    entries that repeat their own keys). Instead of `parity.ts`, `test/taxonomyNames.test.ts` holds
    the map to `data/universe/instruments.jsonl` in both directions.
191. **The stored mandate keeps Yahoo's English names; translation is for display only** (the user,
    2026-10-20). `agents.sectors/industries/etf_categories`, `assertKnownClassifications`, the
    enforcement in `mandate.py`, the scan briefing and the contradiction check's "buys only in:"
    all keep matching English exactly, and changing the language changes no stored data. Picker
    search matches both spellings ("שבבים" and "semi" both find Semiconductors). *Rejected:* storing
    `{en, he}` pairs like `observations.localized` - a migration and a wire change for two copies
    that can drift, of names no server shows.
192. **Instructions written in Hebrew name each choice as "טכנולוגיה (Technology)"** (the user,
    2026-10-20). `describeMandate` uses `taxonomyPhrase`: the translation, with the English
    identifier in brackets. **Why:** the instructions are what the model reads beside the
    briefing's English names, and once the user edits them they are the text that the
    contradiction check (D176, D183) compares with "buys only in: Technology". With Hebrew alone, a
    loose model translation of an obscure industry ("Muni Single State Short") could become a
    false conflict warning. *Rejected:* Hebrew alone (it reads best, but costs that risk); English
    alone (what shipped until now - the one untranslated phrase on the page). The cost is longer,
    mixed-direction text in the textarea.
193. **A name the map lacks is shown in English, marked `lang="en"`, and CI makes the gap short**
    (the user, 2026-10-20). A rescreen can bring a name Yahoo added after the snapshot was
    committed: the picker shows it in English, and instructions use it with no brackets. The test
    fails when any committed name has no Hebrew name, and when the map names something the
    snapshot lacks. So the gap lasts only until the next snapshot commit. *Rejected:* hiding untranslated
    names (that hides a choice the server accepts, and leaves a stored chip with no row); a
    warning in the UI (it tells the user about a gap only a developer can fix).
194. **An agent's page is four tabs, and the scans and their history are one of them** (the user,
    2026-10-20). Holdings / Activity / Scans / Settings: *Scans* is *Run a scan now* above every
    scan the agent ran (the old *Decisions* tab); *Settings* is the mandate form, the schedule
    and model budget, and pause/archive. Only the account and performance stay above the tabs.
    `?tab=decisions` still opens Scans, for links written before. **Why:** the page stacked the
    scan controls and the whole settings form under every tab, so the page was long whichever
    tab was open. *Rejected:* five tabs keeping Decisions beside a new Scans (two tabs naming
    one list - running a scan in one, reading its result in the other). Pause/archive moved with
    the settings; the header's state badge still says when an agent is paused or archived.
195. **An agent's schedule is three parts: market hours every N hours, before the open, after the
    close** (the user, 2026-10-20; replaces D46's four named schedules, migration **0060**).
    `scan_every_hours` (1-6 from 10:00 New York, null for none), `scan_pre_open`,
    `scan_post_close`; any combination, and all off means the agent scans only when asked
    (Pause still refuses manual scans too). Settings shows the times on a regular day in the
    user's own zone, the count and the cost a day, and a suggestion from the horizon applied in
    one press. Defaults by horizon: short every 2 h, medium both edges, long pre-open. The four
    old schedules map exactly (`intraday_twice` is every 4 h, `intraday_once` every 6) and
    market-hours slots keep their names (`ny_1000`...`ny_1500`, part of each attempt's run key),
    so no agent's scans move. **Why:** the user asked for "once every ___ hours" rather than a
    fixed hourly choice, and for the edges to combine with it. *Rejected:* a free "scans a day"
    count (no obvious times for 5 a day); one text column holding a spec string (a parse at every
    read); only every-N-hours (long-horizon agents lose the pre-open scan that is their default);
    hourly as the short default (up to 6 proposals a day while the last one may still be
    pending - 2 h matches a proposal's one-hour life). The downgrade refuses a schedule 0042
    cannot name rather than silently moving an agent's scans.
196. **Run a scan now shows a scheduled scan; it never blocks on one** (the user, 2026-10-20). The
    agent view carries `runningScan` (trigger, start); while any scan runs the button waits, with
    "a scheduled scan is running now", and within 30 minutes of a scheduled scan it says when -
    two scans close together usually propose the same idea twice - but the choice stays the
    user's. The agent query re-reads every 30 s only while a scan runs or one is that close.
    *Rejected:* a manual scan covering the next slot (skips a look the user may have wanted);
    blocking manual scans near a slot (blocks the user exactly when they want a scan now).
197. **A scan may decide several trades, each its own proposal** (the user, 2026-10-20; migration
    **0061**). `agents.max_decisions` 1-10 (defaults short 1, medium 2, long 3; existing agents
    1). The answer is `{"trades": [...]}`, each trade with its own thesis; the one-trade shape
    is still read, so stored scans and a model answering the old way both work. Sells are
    reviewed before buys (`trade_review.py`), so a buy may be paid for by a sell in the same
    answer - it carries `funded_by` and its headline says "paid for by selling X: approve that
    first". Each trade stands alone: what passes is kept, a trade refused for figures (D189) or
    the mandate (D170) goes back once per kind - just those trades - and what still fails is
    stored refused with why; a trade the model does not send again is withdrawn, not refused
    (a pass after a refusal is still `no_trade`). `proposals_one_per_scan` became one per scan
    and symbol. **Why:** the user wants conservative agents that rebalance several positions in
    one look. *Rejected:* one bundle approved all-or-nothing (atomic, but Telegram's Confirm
    could no longer carry the prices - 64 bytes - reversing D62); a bundle with a checkbox per
    leg (all of that plus partial fills); a limit as a percentage of holdings (moves on its own,
    gives a new agent 1); all-or-nothing review (one slipped decimal on trade 7 loses the
    other six). Approving a funded buy before its sell is refused for cash and stays pending.
198. **A scan knows the agent's proposals still waiting, and does not repeat them** (the user,
    2026-10-20). The briefing lists them (`waiting_for_approval`); a trade on the same symbol
    and side as one is refused; the book a trade is reviewed against counts the waiting buys as
    filled (cash spent, shares held), so approving everything never fails for cash and the
    mandate's limits count them. A waiting sell is not counted - it may be rejected. **Why:**
    "buy 3 IRON" twice an hour apart (compose, 2026-10-19), and scans every two hours would
    make that the norm. *Rejected:* briefing only (the model may still repeat).
199. **The agent limit counts active agents only** (the user, 2026-10-20; migration **0062**,
    which rewrites 0047's `agents_within_limit` function - the trigger itself is unchanged).
    Checked on an insert as active and on any change of state *into* active (resume, restore);
    a pause, an archive, an edit, or an agent created paused is never refused. The per-user
    row lock stays, so a create and a resume racing for the last place cannot both win. A
    lowered limit pauses nothing: the next activation is what is refused. **Why:** cost comes
    from scans, and only an active agent scans (scheduled, `scheduledScans.ts`, and by hand,
    `agentScans.ts`), so a paused agent is free to keep. *Rejected:* keeping the count over
    live agents (charges a user for agents that cannot spend); auto-pausing the excess when the
    admin lowers the limit (changes a user's agents behind their back).
200. **At the limit a new agent starts paused, and a restore comes back paused** (the user,
    2026-10-20). `POST /agents` takes an optional `state` (`active` | `paused`, default
    active); the page sends `paused` when the limit is reached and says so in the form first.
    Restore sends `active` with room and `paused` without. Resume at the limit is disabled with
    the reason beside it; the server's 409 `agent_limit_reached` is the backstop. *Rejected:*
    refusing the create (contradicts "creating more is harmless"); an always-visible "start
    paused" switch (a control for a choice only the limit forces); refusing a restore at the
    limit, and always restoring paused (changes today's restore for users with room).
201. **The admin has no agent limit** (the user, 2026-10-20). The trigger skips `users.role =
    'admin'` after taking the row lock; the orchestrator does the same from the session's user,
    and `agentLimit.max` is `null` for the admin, which the page shows as "N active". **Why:**
    the limit protects the installation's bill from its users, and the admin pays that bill.
202. **A user keeps at most 50 agents that are not archived; the admin has no ceiling** (the user,
    2026-10-20; migration `0063`). `MAX_AGENTS_PER_USER_CEILING`, a fixed backstop rather than a
    setting, checked when an agent joins the non-archived set - a create in any state, a restore
    - and refused with `agent_total_reached` (409); a pause, a resume or an archive never is. A
    trigger of its own (`agents_within_total`) beside D199's, under the same lock on the user's
    row; `agentLimit.total` is `null` for the admin. At the ceiling the Agents page disables New
    agent and the agent page disables Restore, each saying why. **Why:** D199 stopped counting
    paused agents, and with signup live (D156) a user could create them without end - rows, a
    card each on the Agents page, a line each in the consolidated view. *Rejected:* no bound
    until M10 (signup is live now); a second Admin setting (a column, a field and copy for a
    backstop); folding it into `agents_within_limit` (two rules, two sets, two refusals).
203. **The monthly cap is a wrapper inside the recorder, keyed by `caller.user_id`** (D157/D158's
    enforcement, the user's spec of 2026-10-20; `app/llm/monthly_cap.py`). Before every call,
    tool-loop turns included, `MonthlyCapProvider` reads the user's cap and zone from `users` and
    sums `llm_calls.cost_micro_usd` since the user's calendar month began; it refuses when spent
    plus the call's ceiling would pass the cap. **The ceiling** is the prompt's characters / 4
    (system, every message and tool call, the tools' schemas) at the input price plus the
    call's own `max_output_tokens` at the output price, falling back to `LLM_MAX_OUTPUT_TOKENS`
    when the call sets none - scans ask for 1500 and the assistant 2500, so pricing them at 700
    would admit calls D158's "maximum cost" refuses. Unknown model = the pessimistic rate,
    `:free` = 0. The refusal is `MonthlyCapReachedError`, **a subclass of
    `LLMBudgetExceededError`**, so every caller that already degrades on a spent budget
    (narration to its template, the instructions check to `budget_spent`, the tool loop to
    `budget_reached`) degrades unchanged; the recorder writes it as `budget_exhausted` at cost 0.
    A cap of NULL (the admin), a call with no user, and an unmetered provider are not checked;
    **an unreadable ledger refuses** (the cap bounds a bill; unknown read as "nothing spent" is
    the expensive way to be wrong). Two concurrent calls can both pass: the overshoot is bounded
    by one call's ceiling. *Rejected:* checking at the call sites (four places to forget; the
    wrapper needs none changed); a separate refusal outcome in `llm_calls` (a migration of the
    log for a distinction the scan and reply rows already carry).
204. **The call log keeps at least 32 days** (the user, 2026-10-20). `LLM_CALL_RETENTION_DAYS`
    defaults to `MIN_RETENTION_DAYS` = 32 and config refuses less: the cap sums `llm_calls`
    since the month began, and with the old 30 days the month's first calls were pruned from
    about the 31st, so spent read low and a capped user could pass the cap. 32 = the longest
    month plus a day for the zone's offset. *Rejected:* pruning only rows older than every
    user's month start (a prune query that depends on every zone, and a variable oldest row);
    a per-user monthly counter (a second ledger that can drift from `llm_calls`, what D157 chose
    against).
205. **A refusal by the cap is its own outcome, `cap_reached`, and says when it resets** (the
    user's spec of 2026-10-20; migration **0064**). Agent scans and assistant replies gain
    `cap_reached` (their CHECKs widened; 0064 also adds `llm_calls_user_month` on `(user_id,
    started_at)` for the per-call sum). The screens say it in en + he with the reset date - the
    first day of the month **after the scan or reply was written**, in the user's zone
    (`apps/web/src/lib/monthlyCap.ts`), so an old refusal names its own month. A scheduled scan
    ending `cap_reached` finishes its run `degraded`, like `budget_reached`. Settings shows a
    capped user "This month: $X of $Y, resets on <date>" from `GET /settings/llm-spend` (the
    orchestrator's SQL, `getMonthlySpend`, the same month as the Python ledger; both are tested
    against Postgres); `spend: null` for the admin, who sees no card. The narration state's
    "daily spend ceiling" wording became "a spending limit: the installation's daily one, or your
    account's monthly one", since a capped user's fallback reads the same reason. *Rejected:*
    reusing `budget_reached` (it promises "after midnight"); a reset date computed from today
    (wrong for a refusal read back next month).
206. **A non-admin user may save their own OpenRouter key; while it works, the installation's
    limits do not apply to them** (the user, 2026-10-20; improvements item 3b; migration **0065**;
    `app/llm/own_key.py`). `OwnKeyProvider` sits inside the recorder and outside the cap:
    `Choosing(Recording(OwnKey(MonthlyCap(Budgeted(adapter)))))`. For each call with a user it
    reads a `valid` key from `user_llm_keys`, builds an adapter with it (cheap - the adapter builds
    a client per call anyway) and skips the cap and the daily guard; the completion or error is
    marked `paid_by="own_key"`. The key is checked on save with OpenRouter's free `GET /key` (401/403
    rejected, anything else unreachable - neither is saved), stored encrypted (D208), never sent to
    the browser: the routes answer with its last four only, the request model is a `SecretStr`
    with no length constraint (a failed constraint echoes the input in the 422), and the
    orchestrator's 400 carries no zod issues for the same reason. The AI service owns the table
    and its SQL, because it alone holds the encryption key; the orchestrator relays
    `GET|PUT|DELETE /settings/llm-key` and refuses the admin (no cap to escape). Only for
    `LLM_PROVIDER=openrouter`. **The user's direction (2026-10-20):** eventually every user runs
    on their own key and sets their own limits, and the installation's cap stops mattering - a
    user-set monthly limit for own-key spend is the follow-up, not this PR. *Rejected:* the key in
    the orchestrator (it would need the encryption key too: two holders of one secret); per-call
    keys passed through `Caller` (every call site would carry a secret).
207. **A saved key OpenRouter refuses is marked failed; that call fails, the next ones run under
    the cap** (the user, 2026-10-20). 401 -> `rejected`, 402 -> `no_credit`, stored with
    `failed_at`; the call raises `OwnKeyFailedError`, a kind of `LLMRequestError` (not of the
    budget error: it reached OpenRouter and was refused), so narration falls back as
    `provider_error`, the recorder writes `provider_error` on `own_key`, and a scan or `/ask`
    reply ends as the new outcome `own_key_failed` (0065 widens both CHECKs; a scheduled scan
    finishes `degraded`; the assistant does not repair it - a retry would run on the installation
    unannounced). Settings says which and since when, and that calls use the installation under
    the cap until a working key is saved. Other failures (timeouts, 5xx, 429) are the call's and
    leave the key alone. Marking matches on the stored ciphertext, so it cannot fail a key saved
    meanwhile. *Rejected:* refusing every call until the key is replaced (scans and Ask stop for a
    reason the cap already bounds); retrying silently on the installation's key (guideline 7).
208. **The encryption key is `LLM_KEY_ENCRYPTION_KEYS`: comma-separated Fernet keys, the first
    encrypts and every one decrypts** (the user, 2026-10-20; the `cryptography` package, approved
    under convention 5; `app/llm/key_vault.py`). Rotation: new key first, restart,
    `scripts/reencrypt_llm_keys.py`, drop the old key (docs/RUNBOOK.md). **Unset = the feature is
    off** (save answers 503 `own_keys_unavailable`; saved keys can be read about and removed,
    never used, so their owners are back under the cap); **set but malformed = the AI service
    refuses to start** - a typo must not read as "off" and silently move own-key users onto the
    cap. A key no configured key decrypts is logged and treated as none. *Rejected:* one key with
    no rotation (rotating would lose every saved key); deriving it from `SESSION_SECRET` (another
    service's secret, and rotating sessions would break saved keys).
209. **Every recorded call says whose key paid (`llm_calls.paid_by`), and the cap sums only the
    installation's** (the user, 2026-10-20; 0065). Without it a user who spent $20 on their own
    key and then removed it would be capped at once for money the installation never paid. The
    Settings card says, while a key works, that the monthly limit does not apply, and shows "On
    your own key this month: $X (estimated)" beside the cap whenever own-key spend exists
    (`getMonthlySpend` sums both with `FILTER`). *Rejected:* no column (the lock-out above); not
    showing own-key spend (the user's OpenRouter dashboard has it, but the estimate is what the
    agent allowances count, and saying it costs one line).
210. **Own-key calls are outside `LLM_DAILY_BUDGET_USD`; the agent and assistant daily
    allowances still apply** (the user, 2026-10-20). The daily guard bounds the installation's
    bill and these calls are not on it - counting them would let one own-key user use up the day
    for everyone. The allowances (each agent's, set by its user; the assistant's $0.50/day) sum
    `llm_calls` whoever paid, and stay: they stop a runaway loop on anyone's money. *Rejected:*
    counting own-key calls in the guard; dropping the assistant's allowance for own-key users
    (the user-set limit of D206's direction is the better place to loosen it).
211. **A limit on own-key spend is OpenRouter's, set on the key; the app has no field for it**
    (the user, 2026-10-20, choosing between three options). OpenRouter lets each key carry a credit
    limit and refuses past it with **402** (its limits reference: per-key caps are a credit
    limit), which D207 already maps to `no_credit`: that call fails, the key is marked failed, and
    later calls run on the installation's key under the monthly cap until the user saves it again.
    So the card's intro gains one sentence pointing to the key's limit, and the `no_credit` message
    names both causes (account out of credit, or the key's limit reached). It is exact (the real
    bill, not our estimate) and costs no code. Known edge: re-saving a key whose limit is spent
    passes the free `GET /key` check, so the next call fails and marks it again - the message says
    to raise the limit first. *Rejected for now:* an in-app "stop my own-key spend at $N a month"
    (a column, a wrapper summing `paid_by = 'own_key'`, a Settings field; it checks an estimate) -
    worth building when a user asks for the limit inside the app; both (two limits that disagree).
212. **Re-checking an expired trade proposal is a focused scan of that one trade, through the
    scan machinery** (the user, 2026-10-20, improvements item 4; `app/agents/recheck.py`,
    `scan.run_briefed`). Same instructions, mandate, `TradeReview`, evidence validator, budgets and
    `Caller("agent_scan", user_id, agent_id)` - so the cap and the own key apply untouched - but a
    briefing about the trade (fresh quote, its findings, cash and holdings, what was proposed and
    when it expired), one decision, `RECHECK_STEP_LIMIT` (4) tool calls. The old thesis is told in
    a preface *outside* the briefing, so none of its figures counts as evidence: a re-check must
    find each figure again today. Stored as an `agent_scans` row with trigger `refresh` (0066).
    *Rejected:* a full scan (it decides the whole portfolio, up to `max_decisions` trades, and
    costs a full scan's tokens to answer one question); no model - re-run the checks and reuse the
    old thesis (its prices are yesterday's, and the validator would be checking old text against
    new evidence).
213. **"Once per proposal" is a partial unique index on the re-check's scan row, and a re-check
    that reached no answer does not use it up** (the user, 2026-10-20; 0066
    `agent_scans_one_refresh` on `refreshes_proposal_id` WHERE outcome is NULL or not in
    failed / budget_reached / cap_reached / own_key_failed). A second press loses at the database,
    whatever surface raced it; the AI service checks first only to refuse before money is spent. A
    new proposal hangs from the re-check's scan (`proposals.scan_id`), so the lineage needs no
    column of its own. `step_limit` and `invalid_answer` count: the model answered badly, and a
    retry would bill again for the same. *Rejected:* a column on the original proposal set by a
    conditional UPDATE (a second writer, and a refused re-check would have nowhere to keep its
    outcome); counting every re-check (a cap reached mid-month would burn the only chance).
214. **A re-check that proposes nothing says why in the user's language: the catalogue's frame,
    then the agent's own reason or the check that refused it** (the user, 2026-10-20). The agent's
    reason is a pass's thesis - written in `user_settings.language` and held to the evidence
    validator like any thesis (D51). A server refusal is said from the refused trade's new `code`
    (`answer.RefusalCode`, stored beside the English `problems`, which stay for the Scans tab):
    cash, mandate, no price, already waiting, not tradable, figures, not this trade, ... each a
    sentence in `messages.ts` and the web catalogue. *Rejected:* the catalogue sentence alone
    (says less); the English `problems` strings (guideline 1).
215. **Re-check is offered on an agent buy or sell that expired unanswered, for 7 days after its
    deadline, while its agent is active** (the user, 2026-10-20; `RECHECK_WINDOW` /
    `RECHECK_WINDOW_DAYS`). A rejected proposal is not offered - the user already said no. It is
    refused up front with the agent's day's budget spent, as a manual scan is (D52). The orchestrator
    computes the same rule (`recheckStatus`) for the page and the Telegram keyboard; the AI service
    is the authority and refuses with the same codes. *Rejected:* any age (a month-old idea
    re-checked against today's price); rejected proposals too.
216. **A re-check may re-size the trade but not change it: same symbol and side, the quantity set
    again at the fresh price, or no trade** (the user, 2026-10-20; `TradeReview.focus`). Anything
    else is refused `not_this_trade`. *Rejected:* the exact same trade (a price that moved would
    leave only "yes at the old size" or "no").
217. **In Telegram, Re-check appears when a tap finds the proposal expired; the re-check runs after
    the tap is answered** (the user, 2026-10-20). We keep no Telegram message ids, so nothing can
    swap the buttons at the deadline; the stale Approve or Reject answers "expired" and is replaced
    by Re-check (callback action `k`). The poller handles updates one at a time and a re-check is
    a model call, so the tap is answered "re-checking" at once and the work runs detached; a new
    proposal arrives as its own message with Approve and Reject (`proposeFromScan` announces it),
    and the old message gains the outcome line. No nonce is burned: "once" is the index (D213).
    *Rejected:* storing message ids so the expiry sweep swaps the buttons (a column and a sweep
    that edits Telegram, for a button the user only needs when they come back to the message).
218. **A proposal a later approved proposal already carried out is not re-checked** (the user,
    2026-10-20, after the first live re-check). The expired "buy 3 IRON" (scheduled scan, 10-19)
    was proposed again an hour later and approved, so the agent held those 3 shares; the re-check
    of the expired one proposed 3 more and cited the holding as support - asking for the trade
    twice. Now refused `superseded` before any model call when the agent has a later *approved*
    proposal for the same symbol and side (a later sell, rejection or expiry does not count); the
    page links to the proposal that made the trade. *Rejected:* telling the model and letting it
    decide (a cheap model re-sized it into a doubling; the fact is the server's to apply).
219. **A re-check's briefing carries the symbol's news and the move since it was proposed, and its
    thesis must say whether the original reason still holds** (the user, 2026-10-20). The first
    live re-check made no tool call and restated yesterday's momentum (a 39%, 18-sigma move with
    no cause looked up) without comparing 78.24 then with 79.49 now. The briefing now has
    `recheck.price_now` and `change_since_proposed_percent` (computed by the server, so the thesis
    quotes rather than computes) and `get_news` for the symbol, read for the model; the preface
    asks for then/now/change, whether the reason holds and on what evidence, then the decision.
    The shape is asked, not enforced: the validator checks figures, not argument. *Rejected:*
    requiring a `get_news` tool call (a step the briefing can do for it, without a refusal path);
    rejecting a thesis without both prices (a retry kind of its own for a wording rule).
220. **The assistant answers in the language the question was asked in, on the Ask page and in
    Telegram** (the user, 2026-10-20; improvements item 5). The second exception to guideline 1's
    "server text stays English", after D51's thesis: rule 9 of `assistant/instructions.py` was
    "Write in English" and now names the latest message's language (English when it cannot tell),
    the suggestions following it. Measured first: 3 of the last 13 Ask questions on compose were
    Hebrew and got English answers. The figure check reads digits, so it holds unchanged for a
    Hebrew reply (`test_assistant_reply.py`). The web marks an answer and its suggestions with the
    language their own text is in (`writtenLanguage`), not `lang="en"`; sources (news headlines)
    stay `SERVER_ENGLISH`. *Rejected:* Telegram only, behind a flag (two prompts to keep in step,
    and the Ask page's Hebrew questions kept their English answers); `user_settings.language`
    (not what the user decided: a question in English from a Hebrew-settings user is answered in
    English).
221. **A Telegram message that is not a command is a question, sent through the Ask page's own
    call** (the user, 2026-10-20). `POST /assistant/messages` with the bound user, so the daily
    allowance, the monthly cap (D203) and the user's own key (D206) apply with no code of their
    own. It runs detached from the poller like a re-check (D217): an answer takes 5-11 s (p50-p90,
    compose) and up to `TIME_LIMIT`, and the poller handles one update at a time. "typing…" is
    renewed every 4.5 s meanwhile. One question per chat at a time, in-process (one orchestrator
    polls a bot): a second is refused `stillAnswering`, not queued, because its answer would be
    written without the first's in the conversation. Over 2000 characters is refused before any
    call; a photo or voice note gets `textOnly`. *Rejected:* a `/ask <question>` command (every
    message would need a prefix the phone keyboard makes awkward, and plain text had no other
    meaning - it only listed the commands).
222. **One rolling conversation per chat: `telegram_bindings.assistant_conversation_id` (`0067`),
    a new one after 12 quiet hours or `/new`** (the user, 2026-10-20). The conversation is an
    ordinary `assistant_conversations` row, so the Ask page lists, reads and deletes it; a delete
    sets the column null (`ON DELETE SET NULL`), and a 404 between the read and the question
    starts a fresh one. Quiet is the conversation's own `updated_at`; the lookup also joins on
    `user_id`, so a pointer can never reach another user's row. The model only ever sees the last
    six messages (`HISTORY_MESSAGES`), so length does not raise cost; the 12 hours is for the
    history list (one conversation per sitting) and for retention (90 days untouched), which a
    conversation that never ended would escape. *Rejected:* one conversation for ever with `/new`
    only (an ever-growing history entry named after its first question, never retired); a new
    one at local midnight (splits a conversation at 23:50 mid-thought).
223. **In Telegram an answer is flattened markdown, plus at most three news sources with their
    URLs; suggestions are one-time reply buttons** (the user, 2026-10-20; `telegram/plainAnswer.ts`).
    Plain text, no `parse_mode`: one escaping mistake in Telegram's markup refuses the whole
    message, and the text is a model's. A link to an app page keeps its words, with the address
    only when `WEB_BASE_URL` is a public https origin (unset on compose); app-page and data
    sources are left out. A tapped suggestion is sent as the user's next message - the next
    question. *Rejected:* Telegram HTML (a fallback path and its tests for bold text); no sources
    (a news claim the reader cannot follow).
224. **The bot's fixed sentences around a question are in the question's language, read from
    its letters** (the user, 2026-10-20; `writtenLanguage` in `packages/shared`). A Hebrew letter
    means Hebrew, otherwise English - the two languages the app ships. Covers the outcomes with
    no model reply (failed, today's limit, monthly cap, no model, own key refused - the AI
    service's English `NO_REPLY_TEXT` is the review record, never shown) and the bot's own
    refusals (too long, still answering, unreachable). `/new` and `textOnly` have no question,
    so they follow `user_settings.language`. *Rejected:* the settings language (a Hebrew question
    from an English-settings user refused in English); the AI service's text as-is (English in a
    Hebrew chat).
225. **A disabled Create agent says why, beside the button; the paper budget has no default and no
    placeholder** (2026-10-20, found in the own-key live check: a non-admin user filled a template,
    saw "1000" in the budget field and a dead button). The form lists what is missing - a name,
    the budget, or a budget that is not dollars and cents - as text the button points to
    (`aria-describedby`); the mandate's own message stays as it was. The placeholder "1000" read
    as a value, so it is gone; the hint under the field already gives the examples. *Rejected:* a
    template fills a default budget (a template is an investing style, not an amount of money -
    the budget becomes the agent's first deposit, D22, and a figure the user never chose would be
    the one every return is measured against); keeping the placeholder (it looked filled in).

226. **The product guide names only tools the assistant has, and says how an agent is created**
    (2026-10-20; `product_guide.py`, `test_the_guide_names_only_tools_the_assistant_has`).
    Measured before acting (the own-key live check's `MALFORMED_FUNCTION_CALL`, llm_calls
    448/449/455/456): every failure followed the guide's `agents` section, and the eval
    reproduced it - "why cant I create an agent?" failed 9 of 10 on Flash-Lite, two other agent
    questions 0 of 20. The section listed the agents' tools by name, `get_position` among them,
    which the assistant does not have; with nothing in the guide about *creating* an agent, the
    model reached for a tool it had just read about and Google refused the call it wrote. A/B,
    10 samples each: name removed 1/10 failed; creation sentence added, name kept 0/10; both 0/30
    across the three questions, and the product group (30 turns) had no failure. Both ship: the
    test makes the cause impossible to reintroduce, the sentence answers the question. The user's
    two questions are U12-U13 in `ASSISTANT_QUESTIONS.md` and eval cases. *Rejected:* switching
    the Ask model (the user's choice, and 0 of 20 on the other questions says the model is fine
    when the guide is); a second retry (it fails the same way: the retry read the same guide);
    leaving the tool names in with "an agent's tool only" (a name in the text is still a name to
    call - describe the tool, do not name it).

227. **A scan's figure check counts the agent's own instructions as a source; #247 is closed
    unmerged** (the user, 2026-10-21, at the scan review; `_converse` in `agents/scan.py`). The
    review (all compose scans, 2026-10-12 to 10-20: 16 model scans, 5 trade, 7 no_trade, 4
    `invalid_answer`, 0 `step_limit`; 0.31 trades a scan; 3 refused for unsourced figures; **0
    buys refused for cash**; 2.3 tool calls a scan, max 4 of 12; `search_universe` never called;
    $0.036 in all) found the invalid answers came from the agent quoting its own rule - Test
    agent's "a drop of 3% or more", refused twice, the second time after the repair turn - plus
    one Hebrew "ב-39.69" already fixed by D184 and one answer that was not JSON. Now
    `evidence["instructions"]` is the persona, as the Ask page counts the user's own question.
    The cost: an invented figure that happens to equal one in the instructions passes; the
    instructions are the user's, short, and their figures are rules, not market data. #247
    (`affordable_shares` per mover and four prompt lines) guarded against cash refusals and
    unlooked-up symbols, neither seen once, and conflicted with `main` after D197. *Rejected:*
    rebasing and merging #247 (a whole-prompt change for an unseen problem, leaving the measured
    one); both (two prompt changes measured as one); waiting for more scans (the "3%" refusal is
    certain to repeat on every Test agent pass that explains itself). **Revisit
    `affordable_shares`** the first time a buy is refused for cash.
228. **The research sub-agent and the per-agent tool picker are deferred again** (the user,
    2026-10-21). Nothing measured asks for either: scans use 2.3 of 12 tool calls, none reached
    the step limit, and every agent used the same four tools (`get_news` 14, `get_quote` 13,
    `get_price_history` 5, `get_position` 4, `get_findings` 1). **Re-measure at about 50 model
    scans**, or sooner when a scan hits `step_limit` or a thesis says it lacked information.
    *Rejected:* dropping both (a later need starts from nothing); building the tool picker
    (cheap, unasked); building the research agent (more cost a scan while scans use under a fifth
    of their tool budget).
229. **The dashboard opens on *All*, and one table shows every holding with who holds it**
    (2026-10-21, the user's dashboard redesign; supersedes D33's default). The address is
    `?holdings=real|simulated|<agent id>`; the plain address and the old `?holdings=all` are *All*.
    A segmented `[All] [Real only] [Simulated only]` sits directly above the table, with one chip
    per agent under *Simulated* when there is more than one. Under *All*, *Simulated* and one
    agent the table has the real table's columns plus *Holders* - a *Real* badge and each agent by
    name - and the quantity and value open the split by holder (hover, click or tap: a phone has
    no hover). *Real only* is the old table, unchanged. D33 rejected *All* as the default because
    "a glance at NVDA 40 must mean the real 40"; the *Holders* column answers that on the row
    itself. Without a non-archived simulated agent there is no toggle and every view is the real
    one. *Rejected:* dropping the per-agent view (the chips keep it, and old links still open it).
230. **A holding without a cost basis is left out of cost and P&L, never counted at zero cost**
    (2026-10-21; `valuation.ts`). Before: `totalCostMinor` summed `costMinor ?? 0` while
    `totalValueMinor` summed every priced holding, so an imported holding with no purchase price
    added its whole value to Unrealised P&L - and an unpriced holding with a cost subtracted its
    cost from it. Now cost and P&L cover the holdings with both a price and a cost basis;
    `pnlMinor` is null when there are none; `uncostedSymbols` names the rest, and the cards and
    rows show "—" with a *Set cost basis* warning that opens the edit. The snapshot's `costMinor`
    follows (it was already described to the assistant as covering the priced holdings).
    *Rejected:* "—" for the whole P&L while any holding lacks a cost (one forgotten import hides
    every figure); a cost of zero, which is the bug.
231. **The cards add the real portfolio and the agents together under *All*, and the split is one
    click away** (2026-10-21; supersedes D34's "never summed" for the cards - rows still keep real
    and simulated apart). Every view has the same four cards. A simulated summary is each agent's
    holdings valued exactly as the real portfolio is (`standing.summary`, `simulated.summary`),
    added by `combineSummaries` in `@traders/shared` - money summed in minor units, percentages
    computed again from the sums. When the figures add more than one source, or an agent's trade is
    waiting, each card is a button opening a drawer: every source's four figures, an agent's
    uninvested paper cash, the combined total, and the waiting trades. The user chose a click over
    a hover tooltip because a phone has no hover. *Total value* is holdings, not net worth: cash
    is shown in the drawer, so the four figures stay the same kind of number in every view.
    *Rejected:* keeping two figures (the user asked for one); the split on hover only.
232. **An agent's trade is approved from its row, through the proposal's own card** (2026-10-21).
    *Approve* in the row opens a drawer with the proposal as the inbox shows it - thesis, what the
    scan checked, the deadline - and that card's *Approve* (the live price beside the agent's,
    D47) then *Confirm*. So every refusal still applies, D218's included, and the dashboard has
    no second approval path to keep in step. A trade on a ticker nobody holds is listed under the
    table with the same button. *Rejected:* one-click approve (skips the thesis and the live
    price); a link to the proposal page only (the user asked for the action in the row).
233. **Order: the four cards, the scope toggle, the holdings table, then the charts** (2026-10-21;
    supersedes UX5's charts-before-table). The table is what the page is for. The charts stay the
    real portfolio's (D32), and under any other view a line above them says so.
234. **"Doing nothing" is right only when nothing fits, and idle cash carries the user's rule**
    (the user, 2026-10-21, after measuring the 16 model scans on compose). The prompt's "Doing
    nothing is a good answer and the most common one" - prompt wording, never a decision - became
    "Doing nothing is right when nothing fits your mandate; with cash above your buffer, say why
    in your thesis", followed, only when the briefing has `cash_above_buffer`, by the user's own
    two sentences (`scan.IDLE_CASH_RULE`, verbatim). The measurement: every one of the 13 scans
    that had cash held 75-100% of capital above its buffer, all 8 passes said "no fitting
    opportunity" and none mentioned the cash, and the 4 trades bought 15-24% of capital each.
    *Rejected:* deleting the sentence and always showing the rule (it would ask an agent at its
    buffer to justify cash it is required to hold); forcing every agent to invest everything
    (it would make a cautious mandate a fully invested one, and agents could no longer be
    compared by philosophy). A re-check (D216) is about one trade and carries neither.
235. **The briefing states idle cash as `cash_above_buffer`: the amount and the percent of
    capital, left out at or under the buffer** (the user, 2026-10-21). A justification must quote
    a figure, and the evidence validator refuses any figure the briefing lacks - without this
    entry every honest justification would be sent back. Cash is what remains after the waiting
    buys and capital is cash plus holdings at cost, the book `trade_review.load_book` gives the
    mandate checks (D171), so the prompt, the briefing and the limits agree. The amount is
    rounded down to the cent; the percent is to one place. **The key is `percent_of_capital`,
    not `..._pct_...`:** the validator reads any key with "pct" as a ratio, so "75%" would not
    match "75" - which is why a thesis quoting the mandate's `min_cash_pct_of_capital` is refused
    today (open, below). No buffer set is a buffer of zero. *Rejected:* the amount only (a person
    reads idle cash as a share, and the agent may not compute one).
236. **A pass that does not quote its idle cash goes back once** (the user, 2026-10-21). When a
    scan trades nothing, the briefing has `cash_above_buffer`, and the thesis quotes neither its
    amount nor its percent (`evidence_validator.quotes_any`), the answer goes back once with the
    reason. It shares the pass's one return with D189's figures - both in one message - so three
    answers a scan stay the most. What the code checks is that the cash was addressed; whether the
    reason is strategy-based is the user's to judge, reading it. *Rejected:* prompt only (the
    user's "in every scan" would be a request, not a rule); refusing the scan (it would add to the
    4 of 16 scans already lost as `invalid_answer`).
237. **A pass that still does not quote it is kept and flagged `cash_unjustified`**
    (the user, 2026-10-21). The flag is `"cash_unjustified": true` in `agent_scans.answer` - no
    migration, one query to count - and the Scans tab marks that row "Didn't explain idle cash".
    *Rejected:* a column (`0068`) for a flag on a row the answer already describes; storing it
    without showing it (nobody would notice between measurements).

238. **The installation's runs refuse a user; the agent-scan plan is one installation run over
    every active user** (2026-10-21, M9's completion PR; refines D161; `runKinds.ts`,
    `routes/internal.ts`). `INSTALLATION_KINDS` - `backfill`, `news_collect`,
    `instrument_metadata`, `proposal_sweep`, `agent_scans`, `universe_rescreen` - run once a bucket
    under no user and no agent (`<kind>:installation:<day in APP_TIMEZONE>`), and a body naming a
    user or `for` is refused 400 `installation_kind`. Backfill and news read the union of the
    active users' instruments (`listActiveUsers*Instruments`). None of them calls a model, so none
    can spend a user's key or cap (the user's rule of 2026-10-21: shared tasks use the system's
    key, once). `USER_KINDS` - `snapshot`, `portfolio_scan`, `topic_scan`, `topic_discovery`,
    `daily_digest` - take a `userId` (must be `active`, else 409) or `for: "every_active_user"`;
    neither is 400 `no_user`. The fan-out runs users one at a time, oldest first; a user's failure
    is recorded on their run and the next user still runs; any failure answers 500 with every
    user's result (a CronJob's Job then shows it). The scan plan reads every active user's due
    slots and enqueues them round-robin (`roundRobin`), so it is one run, not one per user.
    "Last news collection" on a holding or topic page now reads the installation's run
    (`getLatestInstallationRun`). `SINGLE_USER_ID` is gone from the config. *Rejected:* D161's
    literal "every trigger sends `for`" (accepted-and-ignored on a shared kind would hide a
    misconfigured trigger); one plan run per user (round-robin needs every user's slots in one
    place); a fan-out that stops at the first failure (one user's broken data would starve the
    rest).
239. **The admin's user list: disable/enable, a cap edit, an app-made one-time password; reset is
    each user's own** (the user, 2026-10-21, asked up front; `routes/admin.ts`,
    `db/queries/adminUsers.ts`, `routes/account.ts`). The list shows status, role, zone, cap,
    this month's installation-paid spend (the cap's own sum), own-key state and last sign-in -
    operations only (D162). **Disable** bumps `session_version` (sessions end at once, D160);
    scheduled work skips the user; data stays; **enable** restores them. **Cap** edits use the
    approval's bounds; the user asked whether a cap still matters once users bring their own key -
    it does for anyone without one (the installation pays), and an approved $5 could not be
    changed at all. **One-time password:** 120 random bits as 20 base64url characters, hashed with
    argon2id, `password_must_change` set, sessions ended, answered once with `no-store`; the audit
    records the request, which carries no password (asserted). The admin's own row has none of
    these actions (every query has `role <> 'admin'`): a locked-out admin uses
    `scripts/admin-password.sh`. **Account reset** moved from `/admin/account/reset` to
    `/account/reset` and from the Admin page to the bottom of Settings; it is no longer in
    `admin_audit` - the reset's own backup row is its record. *Rejected:* the admin typing the
    password (weaker, and it passes through the admin's hands); listing pending and rejected
    users here too (the sign-up list's); disabling by deleting (irreversible, and a household
    member coming back would lose everything).
240. **M9's exit test reads the routes from the app and asks each with the other user's ids**
    (2026-10-21; `apps/orchestrator/test/m9Exit.postgres.test.ts`, in CI's Postgres job as
    `traders_app`). Two users seeded over real SQL with marked data (agent, holding, topic,
    conversation); signed in as one, every GET route outside `/admin`, `/internal`, `/auth` and
    the probes (37 today) is asked - a route with a parameter once with each of the other user's
    ids - and no answer may contain the other's marks or ids. A user added to a route later is
    covered without editing the test. Proved to bite: with `listAgents`' `WHERE` loosened, it
    failed naming `/agents` and the leaked ids. Also: the fan-out runs for both and not for a
    disabled user; a run naming no user is refused; a disabled user's cookie is refused.
    *Rejected:* a hand-written list of routes (the next route would be untested, silently).
241. **A closed-market quote is cached until the next open at most, the TTL floor included**
    (2026-10-21; `services/ai/app/core/cache_policy.py`). A price read before the bell is the
    previous close; cached for the full hour it was served after the open dated ~17.7 hours old,
    and every approval in that window was refused `quote_too_old` (fills accept 30 minutes). The
    closed TTL is now `min(max(CLOSED_TTL_SECONDS, floor), seconds to the next open)`, rounded up,
    at least 1. The cap beats `CACHE_TTL_QUOTE`'s floor on purpose: the floor saves quota, and a
    close served after the open is a wrong answer, not an expensive one. The open is the regular
    session's (`market_sessions.py`, holidays ignored): on a holiday the cap names an open that
    does not happen and costs one extra fetch of the same price. *Rejected:* the holiday
    calendar (`exchange_calendar.py` covers XNYS only and raises outside its years - the pricing
    path must not); shortening `CLOSED_TTL_SECONDS` (more overnight requests, and still a window
    after the bell); bypassing the cache on approval (the fill path would spend quota per tap).
242. **In Telegram a refusal after a refusal replaces its line** (2026-10-21;
    `telegram/tradeApproval.ts` `withRefusal`). Each refused tap used to append another ⚠️ line, so
    a user retrying through the stale-quote window read five copies of one sentence. The last
    block is replaced when it is a refusal in the same language, recognised by the catalogue's
    own wording up to its first placeholder with BIDI isolates ignored (Telegram may strip them);
    a refusal after a preview is still appended beneath it, so the price the user read stays.
    Every attempt is still recorded by the service and listed on the web proposal page (D49).
    *Rejected:* a count ("3 attempts") - a new plural sentence in both catalogues for a number
    nobody acts on.
243. **A stranger is let in automatically once their email is verified, under a daily limit on
    new accounts; approval stays as a switch** (the user, 2026-10-22; M10 decision 1,
    docs/M10-MEASUREMENT.md). Signup has three modes, an installation setting: *automatic*
    (the account turns `active` when its email is verified), *approval* (D156 as built) and
    *closed*. A daily ceiling on new accounts bounds how fast strangers arrive. The admin can fall
    back to approval or close signup in one setting, as `max_pending_signups = 0` closes it
    today. *Rejected:* keeping approval for strangers (the admin judges people they cannot
    judge, and every request pings Telegram); invite codes (not "people the admin does not
    know", which is M10's purpose). Accepted cost: one person can open several verified
    accounts. The free tier (M10 decision 11) and the rate limits (decision 4) bound what each
    account can cost.
244. **A user on their own key chooses the model for each agent, for Ask and for explanations**
    (the user, 2026-10-22; M10 decision 16). "Rebalance" maps to the explanations scope
    (`explain`): the rebalance proposal itself is a rule over the user's own targets
    (`allocation_drift`) and uses no model, and its explanation is narration. The choice comes from
    OpenRouter's model list (already fetched for the Admin page). The models the scans were tuned
    on carry a "tested" mark, because the evidence validator and the tool calls were tuned on
    Flash-Lite (D75, D227), and another model may get more scans refused. Needs a nullable
    `agents.model` and a per-user choice for the other two scopes. *Rejected:* every user choosing
    under the cap (a capped user could pick a model 50x the price); an admin-curated list (the
    same plus a list to keep). With D245 every non-admin user is on their own key, so in practice
    every non-admin user chooses, and the admin's `llm_model_choices` governs the admin alone.
245. **A non-admin user's model calls run only on their own key; nothing falls back to the
    installation's** (the user, 2026-10-22; **supersedes D207's "the next ones run under the cap"
    and D206's "while it works"**, and answers M10 decision 11 as "own key only"). A non-admin user
    with no key, or with a key OpenRouter refused (`rejected`, `no_credit`), makes no model call.
    Their agent scans, Ask turns, instruction checks and re-checks are refused with a reason that
    says to add or replace the key. Scheduled scans for them are skipped, not run and failed.
    Narration falls back to its template, as it does for a spent budget (D158), so alerts still
    arrive. The admin stays on the installation's key and its daily ceiling. Installation work
    (D238) calls no model and is unchanged. **Assumed, low risk:** embeddings for concept and topic
    search stay on the installation (about 10 tokens a query, not a per-user model call). Revisit
    if that is wrong. **Consequence:** the monthly cap (D157, D203-D205) no longer bounds any
    non-admin call. Whether to keep it dormant or remove it is the implementing PR's question.
    *Rejected (by the user):* the fallback under the cap - an installation-paid path for
    strangers.
246. **Own-key spend is warned ahead and stopped cleanly; reading never stops** (the user,
    2026-10-22). From five days before the key's projected depletion, the UI shows a daily
    reminder to top up or replace the key. When the key is refused or spent, every model-dependent
    operation stops (agent scans, Ask, rebalance explanations) and the user is asked to update the
    key. Portfolio, holdings, agents and every table stay fully usable, because no read depends on
    a model. **Measured (OpenRouter's limits reference, 2026-10-22):** `GET /key` reports the key's
    own `limit` and `limit_remaining` and its `usage_daily`/`weekly`/`monthly`, but not the
    account's balance and not an expiry date. So a projection exists only for a key with a credit
    limit, and an invalidation is known only when a call is refused. What "budget" means is M10
    decision 22.
247. **"Budget" is the key's OpenRouter credit limit when it has one; spend is always shown as a
    ratio, in the top bar and in Settings** (the user, 2026-10-22; M10 decision 22 (c), with the
    user's UI spec).
    - **With a limit:** "$12 / $50", with a progress bar. The five-day warning comes from the
      7-day average of `usage_daily`, and the bar takes a warning color when five days or fewer
      remain.
    - **With no limit:** "$12 / ∞". There is no warning and nothing is blocked ahead; a refusal
      still stops work at once (D246).
    - **Placement:** a compact indicator in the top bar on every screen, beside the account
      menu. Opening it shows the 7-day average, the projected days left and a link to Settings.
      Full details sit in Settings, beside the key's controls.
    - **Why the limit and not an app budget:** it is the number OpenRouter enforces (D211
      stands). The average is OpenRouter's own figure, so spend by other apps on the same key
      counts.
    - **Rejected:** an app-side budget (a second number that can disagree with what OpenRouter
      refuses); the limit alone with nothing shown for a key without one.
    - **Open, as M10 decisions 23-24:** which period "$12" counts, and how fresh the figure is.
248. **The ratio counts its own period and names it** (the user, 2026-10-22; M10 decision 23 (a)).
    - **With a limit:** used = `limit - limit_remaining`, labelled with the limit's reset period
      ("$12 / $50 this month", "today", "this week"; a limit that never resets is labelled
      "in total").
    - **With no limit:** `usage_monthly`, shown as "$12 / Unlimited this month". "Unlimited" is a
      catalogue word, so every language has it; it replaces D247's "∞".
    - **Rejected:** lifetime `usage` (a key that resets reads "$80 / $50"); this app's own
      `llm_calls` (it misses other apps' spend, which OpenRouter counts against the limit).
249. **The spend figure is read when a page loads, cached 15 minutes per user on the server, and
    read again right after a refused call** (the user, 2026-10-22; M10 decision 24 (b)).
    - Every number on the indicator is OpenRouter's.
    - An idle app makes no `GET /key` calls; an active user makes at most four an hour.
    - A spent or refused key shows at once, not at the next page load.
    - **Rejected:** once a day (stale after a busy hour); a live estimate from `llm_calls` added
      to the last reading (two sources joined into one number, which jumps when the next real
      reading arrives).
250. **A user may set an optional monthly safety limit in the app, which stops their model calls
    even on an unlimited key** (the user, 2026-10-22; a circuit breaker against a runaway agent
    loop; **amends D211**, whose "the app has no field for it" held while the installation's cap
    bounded everyone).
    - **What it is:** a user's own monthly ceiling, for example $20. It is optional, and with
      none set nothing changes. It is set in Settings beside the key.
    - **How it counts:** in the user's calendar month and zone, over this app's own-key calls
      (`llm_calls`, `paid_by = 'own_key'`).
    - **How it is enforced:** before each call, like the cap (D203). It is built on
      `MonthlyCapProvider`, which already sums a user's month and filters on `paid_by`, and which
      D245 left unused for non-admin users.
    - **When it is reached:** the same stop as D246, with its own reason - "your safety limit",
      not "your key".
    - **How it shows (assumed, low risk):**
      - The indicator compares with whichever limit binds first: the key's limit (D247-D248) or
        this one.
      - The five-day warning projects against the lower of the two.
      - Settings shows both.
    - **Why it does not repeat D247's rejected app budget:** that was a replacement for
      OpenRouter's number as the warning's basis. This is a brake in addition to it. It counts
      only this app's calls, which is what a runaway loop here spends.
    - **Rejected:** relying on OpenRouter's limit alone (an unlimited key has no brake at all).
251. **The Admin page's Keys tab shows status, never values; installation keys stay in `.env` /
    Secrets** (the user, 2026-10-22; M10 decision 17 (a); guideline 9 stands).
    - **What it shows, per provider key:** set or not, the provider it serves, its last error,
      and a *Test* button that makes one free check call.
    - **Off the tab entirely:** the app's own secrets - `SESSION_SECRET`, `INTERNAL_API_KEY`,
      `LLM_KEY_ENCRYPTION_KEYS`, the Telegram signing and webhook secrets. They have nothing to
      test, and listing them only maps them for an intruder.
    - **Rotating a key** remains an edit and a redeploy.
    - **Rejected:** entering keys in the app, encrypted with D208's vault. It amends guideline 9,
      puts the installation's most valuable keys one stolen admin session from being read or
      swapped as the app faces the internet, and copies them into the unencrypted backups.
252. **An agent's quick actions live on its row on the Agents page; the dashboard keeps only
    *Approve*** (the user, 2026-10-22; M10 decision 18 (a)).
    - **The row:** icon buttons for *Run scan* (D196) and *Pause*/*Resume*, each labelled for
      screen readers, and a "⋯" menu with *Pending proposals* and *Open agent*. The agent's name
      stays the link.
    - **What changes structurally:** the row is a whole-row link today, and a button cannot sit
      inside a link, so the row becomes a container.
    - **Assumed, low risk:** *Run scan* shows a queued or running scan as the agent's page does.
      An archived agent shows no actions.
    - **Rejected:** buttons in the dashboard's "who holds it" cell (that cell is per holding, so an
      agent holding ten symbols would repeat them ten times, on a table already full on a phone).
253. **The main portfolio gets a read-only rebalance table computed from the user's own targets**
    (the user, 2026-10-22; M10 decision 19 (a); D1 and guideline 2 stand).
    - **The table:** per holding, the current weight, the target from `/targets`, the drift, and
      the quantity and money that would restore the target at the current price.
    - **How it is made:** arithmetic, with no model deciding anything. It is shown, not proposed:
      nothing is written and nothing waits for approval. The explanation of a row uses the
      user's explanations model (D244).
    - **With no targets set,** it says so and links to the targets editor. Measured 2026-10-22 on
      compose: no user had any `target_weights`, and no rebalance proposal had ever been raised,
      so this empty state is what every user sees first.
    - **Rejected:** approvable rows (reverses D1 and needs the `0038` trigger changed); a
      model's rebalance ideas without targets (personalized advice, guideline 2).
    - **Still open:** the user's items 2-3 of the same answer, agents scanning the main portfolio
      and proposing to trim, sell or accumulate. They conflict with guideline 2 and are asked
      as M10 decision 19b before anything is recorded.
254. **An assigned agent researches each main-portfolio holding and rates its sentiment, Bullish /
    Bearish / Neutral, with the rationale; the dashboard shows the latest rating** (the user,
    2026-10-22; M10 decision 19b, chosen over amending guideline 2, mandate fit and a paper copy).
    - **Research:** per holding, the agent reads recent news, articles, sector trends and market
      data. Its evidence includes the stored article sentiment (`article_sentiment`, 80,382
      lexicon-scored rows on compose, 2026-10-22).
    - **Output:** per stock, a research assessment - a sentiment rating plus the rationale and
      findings - never a buy, sell or hold instruction, a size or a target price.
    - **Who runs it:** the user assigns an active agent from `/agents`. It runs on a schedule or
      on demand, and the user can ask any agent about the main portfolio in Ask. The agent's
      persona and strategy shape the lens (its existing instructions).
    - **On the dashboard:** a *Sentiment* column with the latest rating per holding - green
      Bullish, red Bearish, gray Neutral.
    - **Guardrails that keep it within guideline 2 (part of this decision):**
      1. The rating is about the stock's outlook, not the user's position. Its wording never says
         "you", "your position", buy, sell, hold, trim or accumulate, and the assistant's
         never-do list stays as it is.
      2. Every figure in the rationale is checked by the evidence validator (guideline 7).
      3. Each rating carries its agent's name and date, and is marked stale past a set age.
      4. The color is never alone: the word is always shown (accessibility, and color-blind
         users).
      5. The disclaimer is on the research page.
    - **Cost:** about one model call per holding per run, on the user's own key (D245), bounded by
      their safety limit (D250).
    - **Assumed, low risk:** one agent is assigned to the main portfolio at a time, and the column
      shows that agent's latest rating. "Neutral" is gray rather than yellow, because yellow
      already means a warning in the app.
    - **Residual risk, recorded rather than resolved:** a per-stock Bullish/Bearish rating shown
      beside the user's real holdings reads close to a recommendation. Whether it counts as
      advice for strangers where they live is a question for a lawyer before public signup
      (decision 13), not one this decision settles.
255. **The public service runs on a small rented host under a domain the user owns, not on the
    Mac** (the user, 2026-10-22; M10 decision 2 (c)).
    - **Why:** it is up 24/7, it does not depend on the Mac, and strangers' data does not live on
      a laptop.
    - **The provider is chosen at the deployment stage** (examples named: Render, Oracle's free
      tier).
    - **What the stack requires of any host** (from the compose file and the manifests, for that
      choice):
      - Postgres 16 with `pgvector` and `pg_stat_statements`;
      - Redis with persistence (BullMQ and the caches);
      - three services: web (nginx), orchestrator, AI service;
      - one-shot jobs: Alembic `migrate`, the `corpus` ingest, the `universe` load;
      - a scheduler for the runs (kind's 11 CronJobs, or the orchestrator's own timer);
      - secrets outside the image;
      - backups off the host.
    - **TLS ends at the host's edge.** So `APP_ENV=production` and `Secure` cookies become
      possible, and which `X-Forwarded-For` hop is the client is that host's to say.
    - **Kind and compose stay the local environments.** Tailscale access (#171) is unchanged.
    - **Rejected:**
      - Tailscale Funnel: a `ts.net` name, so no domain to send mail from, and OAuth uncertain.
      - A Cloudflare Tunnel from the Mac: the service would live and die with the Mac, and
        Cloudflare decrypts the traffic.
256. **The production baseline is M10's first code PR, all five parts together** (the user,
    2026-10-22; M10 decision 3 (a)).
    - **The five parts:**
      1. `APP_ENV=production` on the public host, so cookies are `Secure`;
      2. nginx sends a CSP, HSTS, `frame-ancestors 'none'` and `nosniff`;
      3. non-GET requests with no `Origin` are refused (today only a foreign one is);
      4. only the nginx production build is ever public, never compose's Vite dev server;
      5. the client address comes from the host's proxy header, for the rate limits (decision 4).
    - **Checked locally in production mode before any host exists.** Kind and compose stay
      `development` otherwise.
    - **The PR's first step is measuring what the CSP must allow.** Whether the page needs
      inline scripts or styles was not measured.
    - **Rejected:**
      - each part landing in whichever PR first needs it (a stretch where some are missing,
        with nothing tracking which);
      - all of them in the deployment PR (first tested on the day the app goes public).
257. **Rate limits use `rate-limiter-flexible` on the existing Redis, through a small Hono
    middleware** (the user, 2026-10-22; M10 decision 4 (a); pays D182's debt; the dependency was
    approved under convention 5).
    - **Where the counts live:** in Redis, through the orchestrator's existing `ioredis`
      client, so they survive restarts and are shared across replicas.
    - **What a refusal looks like:** 429, with when to retry.
    - **What is keyed on what:**
      - login: per account and per address;
      - signup, reset and verification requests: per address and per email;
      - the routes that cost money or shared quota - scans, Ask, research (D254), symbol
        resolves and imports: per user.
    - **The address** is the one D256 takes from the host's proxy header.
    - **The limits are named constants,** and the tests assert the constants (convention 1).
    - **Rejected:**
      - `hono-rate-limiter` (its Redis store is a second package, and keying by the email in a
        body is awkward);
      - hand-written `INCR`/`EXPIRE` (we would own the atomicity and the windows);
      - limits only at the host's edge (D255's provider is not chosen yet, and an edge cannot
        see users). The edge may be added later as a second layer, never instead.
258. **Email leaves through `nodemailer` over SMTP, behind an `EmailSender` interface; the
    provider is chosen at deployment** (the user, 2026-10-22; M10 decision 5 (a); the dependency
    was approved under convention 5).
    - **The provider** is configuration: an SMTP host, user and password in `.env` / Secrets
      (guideline 9). Changing provider changes settings, not code.
    - **Mail is sent from the user's domain (D255).** It needs SPF and DKIM records there, or it
      lands in spam.
    - **Tests use a fixture sender** that records what would have been sent, so no test sends
      mail (hermetic).
    - **What it serves:** D243's verification and decision 7's reset.
    - **Rejected:**
      - a provider's SDK (`resend`, `postmark`): ties the code to one provider;
      - Telegram only: a stranger has no binding at signup, which contradicts D243.
259. **Email is verified everywhere it matters** (the user, 2026-10-22; M10 decision 6 (a)).
    - **Signup:** in *automatic* mode the account turns `active` on verification (D243). In
      *approval* mode the request reaches the admin only once the email is verified, so the
      admin never sees an unverified request.
    - **Changing the email** (`/auth/email`): the new address is stored as pending and takes
      effect only when it is verified. The old address stays active until then, and reset mail
      goes to it.
    - **Accounts that exist today:** the migration marks every `active` account verified (people
      the admin invited). A `pending` or `rejected` request is not marked.
    - **Why:** without the email-change rule, a stolen session could move the reset address to
      the thief's mailbox, turning a lost session into a lost account.
    - **Rejected:**
      - verifying at signup only (that gap stays open);
      - existing accounts verifying at their next sign-in (an extra step for addresses the
        admin already trusts).
260. **Reset and verification links are single-use tokens in one `auth_tokens` table, stored as
    SHA-256 hashes** (the user, 2026-10-22; M10 decision 7 (a); migration **0068** unless an
    earlier M10 PR takes it).
    - **A row holds:** the purpose (`verify_email`, `verify_new_email`, `reset_password`), the
      user, the hash, the expiry and the time it was used.
    - **Rules:**
      - A token works once.
      - A new request cancels the user's earlier token of the same purpose.
      - Expired rows are pruned with the installation's runs (D238).
    - **Expiries are named constants:** `RESET_TOKEN_TTL` 30 minutes, `VERIFY_TOKEN_TTL` 24 hours.
    - **A reset:**
      - answers the same whatever the email (D185);
      - bumps `session_version`, ending every session (D160);
      - is rate-limited (D257).
    - **Why the hash:** a leaked database or backup (unencrypted, M10-MEASUREMENT §6) holds no
      usable link.
    - **Rejected:** a signed token with no table (it cannot be single-use - a used or forwarded
      reset link would work until it expired).
261. **Sessions get a table; signing out ends that session, and Settings lists devices** (the
    user, 2026-10-22; M10 decision 8 (b); **supersedes D160's "no sessions table"**; migration
    **0069** after D260's 0068).
    - **The cookie** stays signed and carries a session id. Each request reads the session row
      with the user row it already reads (one indexed lookup).
    - **Ending sessions:**
      - *Sign out* deletes this session's row.
      - Settings lists the user's sessions, with *Sign out* per device and *Sign out
        everywhere*.
      - A password change, a reset (D260), a disable (D239) and an admin one-time password
        delete all of the user's rows.
    - **Expired rows** are pruned with the installation's runs.
    - **Why now:** D160 was right for a household that needed only "end everything now". With
      strangers on shared or lost devices, "sign out ends this session" is a requirement, and
      OAuth adds devices per person.
    - **Assumed, low risk:**
      - A device is shown as the browser and OS from the user agent, plus last seen.
      - **No location:** a place from the address needs a GeoIP database, which is a dependency
        to ask about under convention 5.
      - The address and user agent kept per session are personal data, and they go with the
        session row.
      - `session_version` stays as a second check until the sessions PR shows it adds nothing,
        then it is retired in its own change.
    - **Rejected:**
      - D160 plus *Sign out everywhere* (a copied cookie outlives a sign-out by up to 7 days);
      - a shorter cookie (everyone signs in more often, and sign-out still does not end a copy).
262. **OAuth uses `arctic`, with our own `user_identities` table** (the user, 2026-10-22; M10
    decision 9 (a); the dependency was approved under convention 5).
    - **`arctic` provides:** the Google and GitHub OAuth 2.0 clients, with PKCE and `state`.
    - **We own:**
      - the short-lived `state`/PKCE cookie;
      - the callback routes;
      - `user_identities` (provider, provider subject, `user_id`; unique on provider and
        subject), a migration after 0069;
      - signing in through D261's sessions.
    - **The provider apps** are registered in Google's and GitHub's consoles on the user's
      domain (D255), at deployment, by the user.
    - **`password_hash` is already nullable,** so an account that only uses OAuth fits `users`
      unchanged.
    - **The linking rule is M10 decision 10.**
    - **Rejected:**
      - `openid-client` (GitHub is not OpenID Connect, so it needs a second path);
      - `better-auth` / Auth.js (their own users, sessions and flows would replace M9's login and
        D259-D261, the layer M10 leaves alone).
263. **An OAuth sign-in links to an existing account only when the provider vouches for the email,
    and every link is announced by email** (the user, 2026-10-22; M10 decision 10 (a)).
    - **"Vouches" means:** Google's `email_verified`, or GitHub's verified primary email. Without
      it there is no automatic link; the user links from Settings while signed in.
    - **A new OAuth sign-up** with a provider-verified email counts as verified (D243, D259). In
      *automatic* mode it is `active` at once; in *approval* mode it reaches the admin.
    - **On every link:**
      - an email goes to the account ("Google was linked to your account"), so a surprise link
        is seen;
      - the account's existing sessions are untouched.
    - **Settings lists linked providers with *Unlink*.** Unlinking the account's only way to sign
      in (no password set) is refused.
    - **Accepted cost:** the rule relies on Google and GitHub verifying correctly.
    - **Rejected:**
      - linking only from Settings (the same person ends up with a second, empty account);
      - linking on any matching email (anyone who makes a provider account show your
        unverified address signs in as you).
264. **A user deletes their own account with a 7-day grace period, and can export their data as
    JSON** (the user, 2026-10-22; M10 decision 12 (b) + (d)).
    - **Deleting:**
      - It is confirmed with the password, or by signing in again for an account that only uses
        OAuth.
      - The account is closed at once (signed in nowhere, no scheduled work), with a deletion
        date, and its sessions end (D261).
      - Signing in within 7 days cancels it.
      - After the 7 days an installation run erases it.
    - **What the user is told** (the user's addition, 2026-10-22):
      1. On confirming: a screen saying the account is disabled now, will be permanently
         deleted on <date>, and that signing in before then restores it.
      2. At once, by email (D258): the deletion request confirmed, with the permanent deletion
         date.
      3. On signing in during the 7 days: a banner saying the sign-in cancelled the pending
         deletion and full access is back.
    - **A pending deletion is its own marker, not D239's `disabled`.** It is a deletion date on
      the account. Sign-in reactivates only an account with that marker, and never one the admin
      disabled - otherwise any disabled user could undo the admin by signing in. Login refuses
      `disabled` today (`account_not_active`), so this is a deliberate exception for the marker
      alone.
    - **The erase:**
      - It needs one migration that settles the seven foreign keys with no delete rule
        (M10-MEASUREMENT §6).
      - `account_resets` rows go with the user.
      - `admin_audit` keeps its rows with the user reference cleared.
      - Shared market data stays.
    - **The export:**
      - It covers the user's own rows: holdings, agents, ledgers, proposals, observations,
        conversations and settings.
      - Never the API key, sessions, tokens or password hash.
      - It is rate-limited (D257).
    - **Assumed, low risk:**
      - In *automatic* mode, rejected sign-up requests are erased after 90 days (D156 kept them
        forever, for a household).
      - The privacy page (decision 13) says backups keep a deleted account for up to 56 days.
    - **Rejected:**
      - immediate erase (a mistake or a stolen session is permanent);
      - no self-service deletion (the admin becomes the process, and a stranger cannot leave);
      - no export.
265. **The app ships `/privacy` and `/terms`, records which version each user accepted, and public
    signup stays closed until their text exists** (the user, 2026-10-22; M10 decision 13 (a)).
    - **The pages:** both are reachable signed out, rendered from one Markdown file per language.
      The Hebrew text is its own file, never machine-translated, because a translated legal text
      is a different document.
    - **The consent record:** signup stores the accepted version and a timestamp (a migration).
      A new version asks existing users to accept it at their next sign-in.
    - **The gate:** automatic or approval signup for the public is not switched on until the user
      supplies the text and the D254 question - whether per-stock sentiment ratings are advice
      where users live - has an answer.
    - **Who writes what:** the wording is the user's, or a lawyer's. The app's part is the pages,
      the record and the gate. M10-MEASUREMENT §6 lists the facts a privacy page must state.
    - **Rejected:**
      - the pages without a record (no proof of what was agreed, or when);
      - no pages (strangers' data held under no stated terms).
266. **The isolation test walks writes as well as reads, seeds every user-owned kind, and tries
    Telegram; no row-level security in M10** (the user, 2026-10-22; M10 decision 14 (a); extends
    D240).
    - **Writes:** every POST/PUT/PATCH/DELETE route is read from the app, as D240 reads the GETs,
      so a new route is covered without editing the test. Each is asked with the other user's ids.
      It must answer 404 and change nothing, checked by reading the other user's rows before and
      after.
    - **Seeds:** every user-owned kind is seeded and marked - proposals, observations,
      notifications, scans, fills, snapshots and own keys, plus M10's new sessions, identities,
      tokens, deletion markers, consent records and research ratings. Each later M10 PR adds its
      own table's seed.
    - **Telegram:** callbacks and messages from another user's chat are tried.
    - **Rejected:**
      - RLS on every table (every query would run with the user set on the connection - a
        rewrite of the data layer M10 leaves alone, which also has to let D238's cross-user
        installation runs through; a candidate for its own milestone);
      - keeping D240 as it is (a write touching another user's row is caught by nothing).
267. **M10's PRs come in sixteen steps: what is usable now first, then the path to public, and
    deployment last, on the user's word** (the user, 2026-10-22; M10 decision 15 (a)).
    1. production baseline (D256);
    2. the write-route isolation test (D266);
    3. rate limits (D257);
    4. own key only plus the safety limit (D245, D246, D250);
    5. the spend indicator (D247-D249);
    6. model choice (D244);
    7. the portfolio table - sorting, P/L in $ and %, agent row actions, the rebalance table
       (D252, D253);
    8. the Admin tabs and the Keys tab (D251);
    9. research and the Sentiment column (D254);
    10. email, verification and the signup modes (D258, D259, D243);
    11. password reset (D260);
    12. sessions (D261);
    13. OAuth and linking (D262, D263);
    14. deletion and export (D264);
    15. legal pages and consent (D265);
    16. deployment to the rented host (D255).

    **Rules for every PR:**
    - One branch off `main` at a time; no stacking.
    - A vertical slice.
    - Migrations take the next free number when each PR is written.
    - Each PR seeds its new tables in D266's test.
    - The user is asked before each PR, a merge happens only on "merge", and a redeploy only on
      "redeploy".
    - A handoff after every five merged PRs (CLAUDE.md).

    **Rejected:**
    - the path to public first (the features the user asked for, usable now on compose and
      kind, would wait about ten PRs, while going public is blocked anyway until the legal text
      exists, D265);
    - alternating feature and security PRs (neither stream finishes early, and a handoff carries
      both).

---

## Bugs that cost real time, and the lesson from each

**A tool name in text the model reads is an invitation to call it (2026-10-20, D226).** The
product guide listed the agents' tools by name; the assistant, asked something the guide did not
answer, called `get_position` - which it does not have - and Gemini ended the turn
`MALFORMED_FUNCTION_CALL`, twice with the retry, 9 times in 10. It looked like model flakiness
("about one turn in ten that reads the guide", 2026-10-14) and was a sentence. **Lesson: before
blaming a model's failure rate, find the turns that fail and read what they read last; an eval
case with `--repeat 10` and a one-line A/B costs cents and names the cause.**

**Two green PRs, one broken `main` (2026-10-18, #253 + #254, fixed by #255).** Two sessions each
added a `0057` on `0056_universe_taxonomy`; each branch's CI was green, and they merged minutes
apart, leaving two Alembic heads - `alembic upgrade head` refuses, so `main`'s CI and any redeploy
would fail. The first renumber (0056 -> 0057, after #252) was caught only because the PR number
skipped one; the second was caught by checking content after the merge. **Lesson: a PR's green
CI is against the `main` it was tested on. Immediately before merging anything with a migration,
`git fetch` and list `services/ai/alembic/versions` on `origin/main`; if a migration landed since
the branch was tested, renumber and re-run first.** Parallel sessions make this routine, not rare.

**A worktree's scripts imported the main checkout's code (2026-10-18, template creator PR 2).**
Worktrees borrow the main checkout's `services/ai/.venv`, which has `app` installed in editable mode
from the *main checkout*. `pytest` puts the worktree first (rootdir), so the tests were right; but
`python scripts/export_openapi.py` puts `scripts/` first and imported the main checkout's `app` -
the exported `openapi.json` silently lacked the branch's change, and `pnpm gen:api` regenerated
nothing. *Lesson: in a worktree, run every service script as `PYTHONPATH=$PWD .venv/bin/python
scripts/...` (from `services/ai`), and grep the generated file for the change before committing.*

**A clean merge carried a wrong "next decision" number (2026-10-18, #257).** Another session's
handoff (#256) rewrote MEMORY's header to "decisions reached 173 (next: 174)" while #257 was adding
174-175; git merged both texts without a conflict, so the header would have sent the next session
to reuse 174. *Lesson: after merging `main` into a branch that adds decisions or a migration,
re-read the header's "reached / next" lines and `alembic` heads - a textual merge cannot see a
numbering collision.*

**The assistant (2026-10-11/12, #220-#223) - lessons, newest first:**
- **A provider's spending cap is not the credit balance** (PR 4, 2026-10-12). OpenRouter answered 403
  "Workspace lifetime budget of $1.00 exceeded" with $8.80 of credit left; the first Haiku run graded
  61 refused turns as model failures. The runner now stops at the first 401/402/403. The cap is a
  workspace setting the user raised; the same key serves the local compose stack, which was blocked
  too. **Lesson: when every call fails the same way, stop and read the error before grading.**
- **A new route is public until its prefix is on `PROTECTED_PREFIXES`** (`apps/orchestrator/src/
  http/app.ts`). `/assistant` was missed; `app.test.ts`'s walk over every registered route caught
  it, while the route's own "signed-in only" test passed because the handler happened to refuse.
  **Lesson: a route's own auth test proves nothing about the gate - keep the walk, never skip it.**
- **The figure checker sources numbers from strings, timestamps included.** An integration test
  inventing "12%" passed on the 11th and failed in CI on the 12th (`price_as_of` held "-12T").
  The assistant's check now reads dates as dates (`reply.py`, `_without_dates`); narration's and
  the agents' still do not - see the debt row. **Lesson: an invented figure in a test must be one
  no date or time can contain (two decimals).**
- **A scripted model passes what a real one breaks.** 17 green integration tests, then one real
  question found three bugs, and every later PR's real run found more (U+2011 hyphens, list
  markers, link ids read as figures, invented pages, empty turns, "Test" for "Test agent"). Each
  fix carries its measurement in a comment. **Lesson: run one real question on a live copy before
  opening an LLM PR - it costs cents.**
- **`python scripts/x.py` from a worktree imports the main checkout's `app`** when `.venv` is the
  main checkout's (editable install): `export_openapi.py` silently exported main's API. Run scripts
  as `PYTHONPATH=. .venv/bin/python scripts/...`.

**Two sessions, one migration number (2026-10-11, #213 and #214):** the database sprint's DB3 took
`0050_query_statistics` and the Insights session's task 21 took `0050_insights_seen`, both off
`0049`. Each PR's CI was green - `test_migration_chain_contract.py` saw one head on each branch -
and they were squash-merged about an hour apart, so `main` had two heads and both deploys stopped
at `migrate` - and the failed deploy took compose down for ~35 min (no runs 07:56-08:31 UTC) and
kind's crons failed for ~15 min; a session that says "nothing is down" must check `runs` first. Fixed by renumbering the later one to
`0051` off `0050_query_statistics`, rehearsed on a live copy. **Lesson: with two sessions merging,
a green CI on a branch says nothing about the merge.** Immediately before merging a PR that adds a
migration, fetch `main` and run `alembic heads` on the branch merged with it (or merge `main` in
and let CI re-run); a session that sees another session's migration land renumbers its own first. **The second time** -
see Stage 4's "Two sessions numbering in parallel collide" below: checking the number before
naming it is not enough when the other PR merges after you named yours.

**The database sprint (2026-10-09/11, #207-#213) - lessons, newest first:**
- **An extension's grants go to `PUBLIC`.** `pg_stat_statements` grants its views to every role, so
  `REVOKE ... FROM traders_app` left `has_table_privilege('traders_app', ...)` true. *Lesson: after
  creating an extension, check the app role's privileges with `has_table_privilege` (which counts
  `PUBLIC`), and revoke from `PUBLIC` where the app should not read.*
- **A table's floor is its live rows plus a fresh index build.** DB2 promised ~45 MB from
  `sum(pg_column_size(row))`; `VACUUM FULL` gave 96 MB, because the HNSW index is a real 40 MB.
  *Lesson: estimate reclaimable space as total minus (live rows + rebuilt indexes); the cheapest
  honest measure is the `VACUUM FULL` itself, on a backed-up database.*
- **`bash -e` ignores a failing command that is negated.** A CI check written `! grep -q ... kept`
  could never fail. *Lesson: in a `run:` block, assert absence with `if grep -q ...; then exit 1;
  fi`.* Also: whole-day age arithmetic depends on the hour CI runs - give boundaries a day's margin.
- **The startup loader's "newer or equal" rule made every restart a full reload** (49 loads of 2
  snapshots), and an unconditional `ON CONFLICT DO UPDATE` made each reload a rewrite of every row.
  *Lesson: an upsert run on every start needs a `WHERE ... IS DISTINCT FROM`, and a test that
  checks `xmin` across two runs - and remember `RETURNING` returns nothing when that `WHERE` is
  false.*

**Stage 4's last stretch (2026-10-07/08, #186-#199) - lessons, newest first:**
- **A real-service rehearsal found what 900 unit tests could not:** BullMQ 6 treats `ioredis` as an
  *optional* peer and fails at the first Redis call without it - the tests never open Redis. Fixed
  in #199 by adding `ioredis`. *Lesson: a new infrastructure package is proven against the real
  service before the PR, not after the deploy.*
- **Two sessions numbering in parallel collide.** UX4 took migration 0046 while PR 7a held a 0046;
  #190 took D67 in another proposal file. Renumbering by script then rewrote `down_revision =
  "0046_digest_seen"` into a revision that does not exist - the migration test caught it.
  *Lesson: `git fetch` and read `origin/main`'s newest migration and decision number before naming
  one; renumber by hand, never by a blanket replace, and run `test_migrations.py` after.*
- **A test was time-bombed by the date.** The scan's evidence includes the briefing's `as_of`
  (today's timestamp), so "8 next week" counted as sourced on 2026-10-08 and the
  unsourced-figure test failed in CI. *Lesson: a figure meant to be unsourced must be one no date
  or time can contain (777, not 8).*
- **Postgres tests run as the owner locally and as `traders_app` in CI.** The app role cannot delete
  scans, ledger rows (`agent_cash`) or `installation_settings`, so a test that commits them cannot
  clean up and the file's final `DELETE FROM users` fails - only in CI. *Lesson: commit such rows
  under the seeded admin (never deleted), or archive instead of delete; a green local run of
  `queries.postgres.test.ts` does not prove CI's.* The two role tests that always fail locally
  (admin audit, model choices) are expected.
- **A rehearsal stack must not share the live queue.** The rehearsal orchestrator used Redis
  database 5 and it was flushed after; on database 0 a queued rehearsal job would have been run by
  the real worker against the live account once scheduling was turned on.
- **The squash title is the first commit's message** when a PR has several commits - #197's reads
  "wip: PR 7a before merging main" on `main` for good (rewriting it needs a force push the ruleset
  forbids). *Lesson: merge with `--subject`.*

**A handoff that added decisions turned `main` red (#169, fixed by #170).** `docs/DECISIONS.md` is
generated from this file's numbered decisions, and `tests/test_decision_index.py` fails when they
disagree; #169 added decisions 113-116 without regenerating it, and CI - back after an outage -
caught it only after the merge. **Lesson: a PR that adds or renumbers a decision here runs
`python3 scripts/build_decision_index.py` and commits `docs/DECISIONS.md` with it.**

**CI "failed" twice on a GitHub outage, not on the code (#167, #168).** Every job but kind ended
`cancelled` after exactly 15 minutes with no step run; the annotation said *"The job was not
acquired by Runner of type hosted"* and githubstatus.com had an open Actions incident. **Lesson:
before reading a red CI as a code failure, check the job conclusion (`cancelled` with no steps) and
the annotation** - `gh run view <id> --json jobs`. Both PRs were merged on the user's word with the
gate run locally, the new SQL exercised against a live copy, and the compose smoke test run against
the redeployed stack instead of in CI.

**A route test dated tomorrow saw nothing (#168).** The performance route reads the real clock; a
fixture deposit dated 2026-10-06 on 2026-10-05 had no closed session, so the series was empty and
the test looked like a logic bug. **Lesson: a test that goes through a route which reads `new Date()`
must date its fixtures in the past**; pure functions take `now` as a parameter, and their tests pin it.

**Adding a query under an invalidated key hung another page's test (#168).** A trade's `onSuccess`
awaits the invalidation of everything under `['agents', id]`; the agent page test served no answer
for the new `/performance` request, so the refetch never settled and the trade panel never closed
- a failure in a test about trading, caused by a chart. **Lesson: when a new query joins an
invalidated key, every page test rendering it must serve it.** The same PR met jsdom's missing
`ResizeObserver` (recharts' container needs one): any page test that renders a chart needs the stub
`holdingPage.test.tsx` already had.

**A converter that trusts its caller was handed unvalidated input (#165, caught by its test).**
`budgetToMinor` assumes its string already passed the agents API's regex; the new top-up schema
was a plain string, so `1.234` became 124 cents instead of a refusal. **Lesson: reuse the
validator, not the converter** - `BUDGET_PATTERN` is now exported and the top-up schema applies it;
a test sends a third decimal. A function whose doc says "from a validated string" is a promise the
next caller will not read.

**A summarising fetch invented a holiday (#162 research).** WebFetch's summary of NYSE's holiday
page listed "Monday, July 3, 2026" as an early close; July 3, 2026 is a Friday and the observed
Independence Day. The raw page's footnotes said 2028. **Lesson: for a fact a test will pin, read
the source text** (curl + strip tags), never a model's summary of it.

**The kind job's front door met the second after `rollout status` (#158, fixed there).**
`rollout status` returns once a pod passes readiness; the Service's endpoint reaches the proxy a
moment later, and a curl in that second gets a 502 through nginx (ready at :36, 502 at :37). A
re-run would have passed by luck. **Lesson: a check that runs straight after a rollout must
tolerate the settle** - the front-door curls now retry 10× at 2 s; a real outage still fails.

**An approved spec was executed against a schema that had moved under it (multi-agent Stage 1,
2026-10-04).** `PROPOSAL-MULTI-AGENT.md` was written at #40 and approved; by #150 three more per-user
unique constraints existed, `runs.user_id` had become nullable for the rescreen, the intents index
had become `intents_one_live_per_proposal` (revocation), and `llm_calls` had grown a column named
`agent` meaning the calling component. Each would have failed a migration or quietly mis-designed a
table. **Lesson: an approved document is a statement about the schema on the day it was written.
Before executing one, measure the live schema it touches** (`pg_constraint`, nullability, every
`ON CONFLICT`) and amend the document first - §11 is that measurement.

**Decimal's `str()` is not a money format (Stage 4, PR 3, caught by tests before merge).** The
agent tools wrote money as `str(from_minor(...))`, and `from_minor` normalises: $1,000 reached the
model as "1E+3", $119.90 as "119.9", ten shares as "1E+1". No test asserted the exact string until
the tools were run over real SQL. **Lesson: any figure a model or a reader quotes is formatted with
`minor_to_decimal_string` (`core/money.py`) or `f"{d:f}"`, and its test asserts the exact string,
round values included.** Related, from the same week: in tool output `_pct` means a ratio - the
evidence validator multiplies it by 100 - so a value that is already a percentage is named
`_percent`.

**Rehearsing on a copy can test nothing while looking green (Stage 1, PR 3).** Run against a fresh
copy of the live database, the branch orchestrator's default run keys were already claimed - the
copy carries live's `runs` rows - so every run "succeeded" by skipping, and no insert through the
new `ON CONFLICT` targets ran. **Lesson: a rehearsal must pass explicit fresh run keys** (and, in
zsh, not `$RANDOM` inside one command line - it expanded to the same value twice, which is how the
repeat-key refusal got tested by accident).

**A least-privilege change broke the proposal workflow for three days, silently (2026-10-01 to
10-04, fixed in #150).** `disableInit: true` was set on the inner `PostgresStore`, but Mastra checks
the flag on the `MastraCompositeStore` it is handed, so every first storage call ran
`CREATE TABLE IF NOT EXISTS`. Harmless as the owner; once migration 0033 moved the services to
`traders_app` (usage, no create), *every* Mastra storage call failed. `startProposalLifecycle` had
no fallback, so the next new proposal would have thrown the whole portfolio scan - alerts included -
and an Approve/Reject tap on a run would have failed; nobody hit either only because the one high
finding (BTC-USD, 10-03) was rightly held by its open episode. One run stayed suspended. Found by
reading the logs while rebuilding for something else. Lessons:
- **A flag that disables something must be checked on the object that is consulted**, not on the
  one it was configured on. The library's proxy read the composite; nothing read ours.
- **A privilege reduction needs a test of every component that touches the database as the new
  role**, not only the hand-written SQL. The app-role CI job ran `queries.ts` and never the
  Mastra store; it now does (`the workflow runtime` in `queries.postgres.test.ts`, shown failing
  with the production error before the fix).
- **"Mastra is never a prerequisite" was a docstring, not a property.** Starting and deciding now
  fall back to the direct path when the engine's storage fails, and tests make the engine throw.

**The first real rescreen (kind, 2026-10-01) found four things every test had passed (M8 PR 8).**
1. *A sample is not a run.* 100 `info` fetches in 8.9 s extrapolated to a 10-minute build; the
   real one met `YFRateLimitError` within two minutes, took 28 minutes and failed on 64 symbols.
   That forced the same-day retry of a failed rescreen (its kept cache made the retry 3 minutes).
   → **Measure the duration of anything rate-limited with the whole run, not a sample of it.**
2. *Validate at the precision you store.* A holding weight of `9.9999994E-8` passed
   `0 < w <= 1` and became `0.000000` in `numeric(9,6)`, so the CHECK failed the whole load.
   `plausible_weight` now quantizes to the column's resolution first.
3. *Publish after commit, not before.* The snapshot was renamed into the volume before its load
   committed; when the load failed, the startup loader (newest snapshot wins) would have failed on
   it at every deploy. It is now loaded from the dot-directory and renamed only after commit.
4. *A skip is not a removal.* 4 members lost their description in the new snapshot but kept the
   earlier profile, and showed as `-4 unexplained`. The loader now counts `undescribed_kept` /
   `no_currency_kept` - decision 86's lesson, met again from the other side.
→ **Prove a long background job end to end on real data before the PR**; each of these was
invisible to unit tests, the integration suite and a sampled measurement alike.

**The universe loader skipped 14 ETF-holding rows without counting them (found in M8 PR 4).**
`load_holdings` did `continue` for a holding whose fund had no profile - BULZ (10 rows), GDXD and
GDXU (2 each), leveraged funds with no description. It counted implausible weights (19) but not
these, so of the 33 rows between the snapshot (16,396) and the database (16,363), 14 had no
explanation anywhere; found only because the status panel was built to reconcile to zero, and it
didn't. → **Every `continue` in a loader is a count someone will later need.** A skip nobody
counted is a difference nobody can explain, and the first person to compare the two totals has to
re-derive the loader to find it.

**The milestone plan named two protections that could not have worked (found measuring for M8).**
"`REVOKE UPDATE, DELETE` makes `admin_audit` append-only": the app's only role is a superuser that
owns every table, so the revoke would have been silently void. "The role travels in the
server-side session": there is no server-side session, only a signed cookie. Neither would have
failed a test. → **Before building a control, check the premise it rests on against the running
system.** A security property that is a no-op looks exactly like one that works until the day
it's needed; `test_admin_audit_sql.py` now asserts the superuser premise so it fails when it
changes.

**Deploying to Kubernetes found five faults that every test and the compose stack had passed**
(M7, #111). (1) Kubernetes' Docker-links variables: a Service named `ai-service` sets
`AI_SERVICE_PORT=tcp://...` in every pod, which collided with our own setting. (2) The AI
service's `/readyz` said "degraded" with a 200. (3) The orchestrator's `/readyz` failed with the
AI service - harmless under compose, a whole-app outage under a readiness probe. (4) nginx
exposed `/api/internal/*`. (5) Every build of an edited tree was tagged `-dirty`, so a redeploy
changed nothing and the old pod kept running (the tag is now `-dirty-<hash of the edits>`). →
**An environment is a test.** Each fault was invisible until something new *read* the same
contract - an env var namespace, a status code, a tag - and each was obvious in the first
minute of looking at the new consumer's behaviour rather than its config.

**Trimming a published permission list cost a dead ingress** (#112). Traefik's RBAC was cut to
what "Ingress mode" seemed to need; without `nodes` it logged `nodes is forbidden` and loaded no
route at all. → **Start from the vendor's published rule list, then remove with evidence**
(the controller's logs after the cut), not from a guess about what a mode uses.

**Unexplained, and recorded as such: requests from the Mac to the kind node's port 80 were reset**
(#112). The first cluster created with the mapping answered from Docker's network, from Docker's
VM, over IPv4 and IPv6 - and reset every request from the Mac. Docker's own log showed the
correct IPv4 forward; a plain container on port 80 worked; no macOS network extension or proxy;
hostPort and hostNetwork changed nothing. A freshly created cluster worked, then the committed
config from scratch. It was not reproduced. The README's troubleshooting says "recreate the
cluster". → **When a cause cannot be shown, say so and write down what was ruled out** - the
next occurrence starts from that list instead of from the beginning.

**A looping model answer passed the evidence validator (found measuring `/ask` for its screen).**
The free route answered "what is the current price of gold" with "Hereellsellsellsell…" for most of
2,500 tokens, and `/ask` returned it as `answer_source: llm`: the validator checks *figures*, and the
loop's one figure was in the cited passage. 1 of 7 model answers measured that morning. Fix:
`app/llm/degenerate_text.py` (a unit of 1-10 characters containing a letter, repeated 8+ times in a
row) runs before the figure check; `/ask` falls back to the verbatim passages with
`fallback_reason: degenerate_completion`, and narration treats it as `malformed` (no new reason for
`narrationHealth.ts` to learn). Checked against every stored text first - 36 corpus chunks, 72
observations, 7,410 article titles - with no match. → **A validator that checks one property
(sourced numbers) is not a validator of the text.** Ask what else a bad output could look like and
still pass it; a model's failure modes are not limited to the one the check was written for.
Also measured then: the free route takes **18-69 s** per answer, once over 3 min (client timeout is
5 min); a refusal takes 0.6 s.

**A provider's daily history includes the day still trading, and the backfill kept it forever (#98).**
Yahoo returns today's candle while the session is open, priced at the latest trade, and the provider
dates every candle 20:00 UTC; the backfill inserted with `DO NOTHING`. So every backfill that ran
before a session closed stored the price at run time as that day's close, permanently: AAPL's 16 Sep
"close" was $332.57 (real $332.41, which the next morning's quote showed), every crypto close since
mid-September was the price at the hour the backfill ran, and a 06:45 UTC run wrote a BTC row dated
20:00 that evening. Found only because the holding page's measurement listed raw rows around "now".
Fix: never store a close dated after now; the backfill replaces its **own** earlier rows (same
source, `delay_seconds = 0`), never an observation. The next manual run corrected 18 rows, including
AAPL's to $332.41. → **When a provider's "daily" series is stored, ask what it returns for today.**
And `DO NOTHING` on a value that can legitimately change is a decision that the first answer wins;
make it deliberately.

**The equity curve was a day early on this machine and right in the container.** node-postgres
parses a `DATE` into a JS `Date` at *local* midnight; the snapshots route printed it with
`toISOString()`, which is UTC, so at UTC+3 `2026-09-14` became `2026-09-13`. The container runs in
UTC, so CI and the compose stack were right, and the route's own test mocked the row as
`new Date('2026-09-14T00:00:00Z')` - UTC midnight, the one input where the bug cannot show. Found
only because the chart's first tick said 13 Sep while the first snapshot was the 14th. Fixed by
selecting `as_of::text` (M6 equity-curve PR), pinned by an integration test that sets
`TZ=Asia/Jerusalem`. → **A calendar date must never become a `Date`.** Select it as text, and when
a test mocks a driver's value, mock what the *driver* returns, not what is convenient to write.

**A test that read the clock passed for a day, then failed on `main` and every PR.** `sendDigest`
called `gatherTopicDigest(user)` with no time, so it used the real clock, while its test pinned
rows to 2026-09-27. It went red at midnight, and a neighbouring test was one day from the same
fate. Found because two unrelated PRs failed the same check. → **A monkeypatch stopped patching anything, and the test started reading the clock.** A registry
test forced "market open" by patching `is_us_market_open`; #77 routed `quote_ttl` through a new
`is_session_open`, so the patch hit a function nobody called any more. #77's CI ran during US
hours and passed; the next run, overnight, failed on `main` for every PR. Found on a MEMORY-only
PR, which is what made it obviously not that PR's fault. → **After a refactor that reroutes a
call, grep the tests for `monkeypatch.setattr` on the old name.** And the clock lesson again, from
a new direction: a test that *forces* a condition is only as good as its hook into the code.

**0019 could not be re-applied after its own downgrade, and nothing had ever tried.** Its downgrade
keeps proposed and rejected auto topics (deliberately) and drops their fingerprint columns; its
upgrade then adds a CHECK that every auto topic has a fingerprint. So any rollback below 0019 with a
proposal present could never roll forward. Found on the Postgres job's first run, by stepping
each revision down *and back up* over data. Fixed in 0019's upgrade (backfill before the CHECK,
words by `matchWords`' rule frozen in the migration) - in the file that refuses, as with 0006. →
**A downgrade that keeps rows must be checked against its own upgrade's constraints**; the
round-trip test now does that for every revision.

**A race test passed with the lock it tested removed.** Five concurrent calls finished too fast to
overlap, so the test for `recordNarrationState`'s row lock was green either way. Ten rounds of
twelve overlap reliably (9-10 rows written without the lock). → **Run a concurrency test once with
the protection removed**; a race that never happens in the test proves nothing about the lock.

**A test must not read the clock,
any more than `.env` (CLAUDE.md convention 3): anything that decides "today" takes `now`.** The
check that proved nothing else did this: run each suite once with `Date` faked a year ahead
(`vi.useFakeTimers({ now, toFake: ['Date'] })` in a throwaway setup file) and read what breaks.

**The first real headlines broke three assumptions a green suite had passed.** Syndicated copies
counted as recurrence; unlinked articles read as themes; everyday words spent the resolve budget.
Every one was invisible on fixture data and obvious on the first real batch. → **Before calling a
data filter done, run it read-only over real data and read the output.** It took one query each
time.

**An illustrative number nearly became the design.** The instrument-overlap rule was chosen from an
example ("nuclear fuel" overlaps "uranium" by 80%) that nobody had measured. Five real resolutions
showed 0% on the confident sets the first version compared. → **Before building on an example
number, run the real thing once; the resolver is five embedding calls away.**

These are listed because the lesson generalises, not because the bug was interesting.

**Stacked PRs silently lost merged work.** #8 and #9 were merged into their *base branches*, which
had already been merged into main — so GitHub showed them MERGED while their code was nowhere. Two
PRs of work, including the rate-limiter fix, sat orphaned until a content check found them.
→ **One branch off `main` at a time. After merging, verify by content (`grep` for a marker), never
by the merge badge.** Parallel authoring in worktrees is fine; parallel *merging* is not.

**Tests that read `.env` pass on the wrong machine.** A test asserting `/market/*` rejects
unauthenticated requests passed locally (where a real key was set) and failed in CI (where the
default key triggered a bypass) — and the *green* result was the misleading one, because it was
green for a reason unrelated to the code. The same pattern recurred twice more.
→ **Build settings with `_env_file=None`; override injected config.** A test whose result depends on
a file outside the repository is testing the machine.

**Tests pinning tuning values fail for unrelated reasons.** A daylight-saving test asserted the
crypto TTL was 60; raising that TTL broke a test about session boundaries. Three separate spurious
failures came from this.
→ **Assert constants, never their current values.** A test should fail when the behaviour it
describes changes, and at no other time.

**Templates tested against invented evidence.** The drawdown template read `peak_price_minor` while
the rule emits `high_price_minor`. Every unit test passed because every unit test supplied evidence
written by hand; the first real scan raised `KeyError`. The same shape hid a worse one: allocation
drift requires each position to carry the observation time behind its value, and neither the
pipeline nor its test supplied one — **drift could never have fired in production, silently**.
→ **Test the consumer against output the producer actually generates**, not against a fixture of
what you believe it generates.

**A wildcard auth guard shadowed the internal routes.** Mounting the session check as a sub-router
at `/*` made `POST /internal/runs` return 401 to everyone, including the cron trigger. The symptom
would have been *silence* — no alerts, no observations, a dashboard that looks perfectly healthy —
and liveness probes cannot see it, because the process is fine and its dependencies are fine.
→ **Scheduled work needs a freshness check** ("did anything run today?"), not a liveness probe.
`GET /runs` exists for this.

**Three M4 bugs were found by *using* the product, and none had a failing test.** This is the most
generalisable thing learned in M4, so it is stated as a group rather than three entries.

- Tapping Approve on a real bot did nothing visible. `answerCallbackQuery` is a toast that fades and
  leaves no trace, and FLOWS.md F4's "edit the message" step had simply not been implemented. Every
  test asserted the toast, because the toast was what had been built.
- A test pinned `NOW` to a fixed date and then called the service *without passing that clock*, so
  it compared a frozen fixture against the real one. It passed in CI and began failing permanently
  a few hours later, on `main`, once wall-clock time crossed the fixture's value.
- Two secrets were documented as separate precisely so a leak of the shared one could not forge what
  the private one protects — and the code then signed connect links with the shared one. The
  comment was accurate about the intent and wrong about the implementation.

→ **A test written after the code tests what was built, not what was specified.** All three survived
a full green gate. Re-read the spec against the code, and use the thing; the second found two of
these and a direct question from the user found the third.
→ Specifically: **`now` is an argument, everywhere, and every call must actually pass it.** One call
site in a file already did, which is what made four omissions easy to miss.

**A migration rewrote an enumeration by retyping it, and dropped a value.** 0006 rebuilt
`runs_kind_check` from a hand-typed list that omitted `backfill` — the kind 0005 exists entirely to
add. Every database holding a backfill run refused 0006 and stopped at 0005, taking 0007–0009 with
it: the entire M4 schema unreachable. This machine sat like that for days, which is why `proposals`
and `notifications` did not exist locally and nothing downstream of an observation was ever visible.
The fix had to be *in 0006*, because a repair migration is never reached — the failure happens
inside the file that refuses to apply.
→ **Extend a named list; never retype the literal.** And the deeper one:
→ **A CHECK constraint is only exercised by data.** CI migrates an empty database, so it proves the
SQL parses and nothing more. The constraint that matters is the one applied to rows that already
exist — the case CI never has and every real installation does.
`services/ai/tests/test_run_kinds_contract.py` now asserts both properties and reads both lists from
source. It was confirmed to fail against the original bug before being kept.

**A reasoning model's thinking is billed out of the answer's token budget.** Narration on a `:free`
route returned the model's chain of thought instead of JSON, which looked like a model ignoring
instructions. It was truncation: 1707 reasoning tokens against a 700-token ceiling, and a reply cut
off mid-thought comes back with the reasoning in `content`. `{"exclude": true}` does not help — it
hides the reasoning and still spends it. Only turning thinking off does.
→ **Reasoning earns its tokens when the answer is not determined by the input.** Narration restates
figures under rules and has no judgement to improve; `/ask` deciding whether to refuse does. That is
why `reasoning_effort` is now a per-call argument rather than one process-wide setting — otherwise
the caller that never thought about it inherits the choice made by the one that did.

**Two changes were written against wrong diagnoses and deleted.** A JSON parser made tolerant of a
reasoning preamble rescued none of the real replies, and an `{"enabled": false}` special case
measured identical to the pass-through it duplicated.
→ **Code written for a cause that turned out to be imaginary does not earn its place by being
harmless.** Delete it and keep the measurement.

**Verification methods failed three times this session, and each time looked like working code.**
A `grep -c "Done"` hid a failing typecheck. Container-based checks of worktree code tested `main`,
because compose builds from the main checkout. Browser clicks "succeeded" against an unfocused tab
while screenshots looked fine, so the page appeared broken when it was not.
→ **Read the output of a gate; never count its matches.** And when a check passes or fails
surprisingly, suspect the harness before the code.

**A PR merged while its fix was still being written.** The message-edit fix was pushed to
`feat/telegram` after #30 had already merged, so it went nowhere and needed its own PR.
→ **Once a PR is merged, its branch is dead.** A follow-up starts from `main`.

**Taps did nothing for a day, and every test was green.** M4 was verified with a hand-run script
that polled `getUpdates` and replayed each update at the webhook. The script was never committed, so
when its session ended the product lost its only inbound transport - and the webhook tests kept
passing, because they post to the handler directly. Nothing asserted that *something delivers*.
→ **Scaffolding that a verification depended on is part of the product until proven otherwise.**
If a feature only worked while a script was running, the script belongs in the repository.

**A migration number is a shared resource.** Two PRs in flight both took `0007` off `0006`, which
would have given Alembic two heads and broken `upgrade head` outright. Neither PR could see the
other.
→ **Check `alembic heads` returns exactly one before merging anything with a migration**, and
renumber the PR that is cheaper to move — the one not yet opened, not the one already in review.

**A parked branch's migration number went stale while it sat.** `claude/m3-corpus-concept-links`
was written carrying `0010_kb_corpus` off `0009_telegram_bindings`. While it waited, `main` took
the same parent for `0010_instrument_metadata` and then added `0011`. Merging it would have given
Alembic two heads and made `upgrade head` fail outright for every installation. MEMORY.md already
carried the remedy — "check `alembic heads` returns exactly one" — and it did not help, because an
instruction is only followed by sessions that read it, and this branch was written before the
instruction existed. The same collision had already been caught by hand once, when two M4 PRs both
took `0007`.
→ **A rule that has been broken twice belongs in a test, not in a document.**
`services/ai/tests/test_migration_chain_contract.py` now asserts the shape of the graph: no shared
parents, unique revisions, one base reachable from one head, and numeric prefixes sorting in chain
order. It was confirmed to fail against the original pair before being kept.
→ The general form: **a branch that sits still still rots**, because the numbers it reserved are
shared with everyone else. Rebase a parked branch onto `main` before reading a line of its code.

**A markdown subset was assumed rather than measured.** The concept text parser was written to
handle `**bold**` and indented formulas, because those are what the documents *appeared* to use.
The corpus also uses `*italic*` throughout — including in the three documents written two sessions
earlier — and every one of those would have rendered as literal asterisks to the reader. It was
found by grepping the nine files before writing the test that claimed they only used the supported
constructs.
→ **When you are about to assert something about data, read the data first.** The assertion was
about to be written as a fixture of what the documents were believed to contain, which is the same
shape as the M2 bug where templates were tested against hand-written evidence.
→ The test now reads the nine real files and fails if any emphasis marker survives into rendered
output. Confirmed failing for all nine against the bold-only parser.

**A nullable discriminator was read by a query that did not know about it.** The ingester's dry-run
selected every `kb_documents` row regardless of namespace. A `news` document carries a null
`concept_slug` by design, so it came back as an orphaned concept and crashed a sort comparing `str`
to `None`. `--prune` had the identical gap, which would have made "load the definitions" a command
that silently deletes ingested articles.
→ Found by *running it* with a news row present, not by a test — the hermetic Python suite has no
Postgres and cannot reach the SQL's scope. This is the same lesson as the three M4 bugs, arriving
again: **the suite cannot test the layer it is deliberately isolated from, so that layer has to be
exercised by hand or in the compose job.**

**A new data directory was not in the image, and the path that read it could not have worked
there.** `Dockerfile.ai` copied `data/fixtures` and not `data/corpus`, and the ingester's
repo-relative default (`parents[3]`) raises `IndexError` from `/app/scripts/`. Both would have
shipped: every unit test passes because it runs from a checkout, where both are fine.
→ **A path that resolves differently in a container needs the two-place resolution the codebase
already has**, not a repo-relative guess. `Settings.corpus_dir` now mirrors `fixtures_dir` exactly:
checkout path if it exists, container path otherwise, env var always wins.
→ CI now starts the `corpus` container and fails unless it exits cleanly, because that is the only
gate that can see either fault.

**A CI gate that could not have failed for the reason it claimed.** The new corpus check asserted
the container's state by grepping `docker compose ps --format '{{.State}}'` for `exited (0)`. That
string is in no field: `.State` prints `exited` with no code, `.Status` prints `Exited (0) 2
minutes ago` with a capital E, and only `.ExitCode` prints `0`. It failed on the first CI run while
the ingestion it was checking had worked perfectly — nine documents created inside the container
from the image.
→ The lesson is not "read the docs for `--format`". It is that **the evidence was already on
screen**: running that exact command locally had printed `exited`, and it was read without being
compared against the pattern just written. This is the third appearance of the same failure —
`grep -c "Done"` hiding a failing typecheck, container checks testing `main`, and now this.
**Reading a gate's output means comparing it to what the gate asserts, not glancing at it.**
→ It now compares a value (`.ExitCode` = `0`) rather than matching a substring, and an absent
container yields the empty string, which is not `0` — so a service that never ran fails instead of
passing vacuously. **A gate that cannot fail is worse than no gate**, because it is counted as
coverage.
→ And the process lesson: **exercise every branch of a check you add, not the one you expect.** All
three were run this time — clean exit, missing container, and a genuinely failing ingestion.
→ **Correction, M3 slice 4: that was three of four branches, and the fourth passed vacuously.** A
container that is *still running* reports `ExitCode` **`0`** — measured with a probe that slept and
then exited 3: `ExitCode='0' State='running'` mid-sleep. So this check passed whenever it read
mid-ingestion, which is precisely the failure this entry says it fixed. It never bit only because
fixture ingestion is fast. The obvious replacement, `docker compose wait`, is wrong the other way:
for a service that has *already* exited it prints "No containers for project" and returns 1, which
would have failed CI on nearly every run. `scripts/wait-for-exit.sh` polls `.State` until it reads
`exited` and only then trusts `.ExitCode`, and was run against all four states before being used.
**The lesson that generalises: "every branch" is a claim about the state space, and it is only as
good as the enumeration. Three was believed to be all of them.**

**Two retrieval bugs, both invisible to a hermetic suite, both found on the
first real query.** Slice 2's SQL was written, reviewed, and covered by 40 new
tests that all passed, and neither of these survived one second of contact with
Postgres.

- An optional parameter compared only against NULL — `(:model IS NULL OR
  c.embedding_model = :model)` — is rejected outright: `could not determine data
  type of parameter $3`. Postgres has nothing to infer the type from. The fix is
  a cast; the point is that the statement *never runs at all*, and nothing in
  the suite executes a statement.
- `plainto_tsquery` **ANDs** its terms, so "how do I bring my portfolio back to
  its target weights" becomes `bring & portfolio & back & target & weight` and
  requires one chunk to contain all five. Three of the four natural-language
  questions tried returned **nothing** from the full-text half. MEMORY.md's own
  claim that "the full-text half is real, which is why hybrid retrieval still
  gives a usable answer in the meantime" was therefore false as written: the
  half that was supposed to carry the placeholder period was silent for exactly
  the queries `/ask` exists to serve. The query is now rewritten to OR by
  rendering `plainto_tsquery`'s output and replacing its operator, so the
  parsing, stemming and quoting stay with Postgres and no user input is ever
  interpolated.

→ The lesson is not "write better SQL". It is that **the hermetic suite cannot
test the layer it is deliberately isolated from, and that layer is where the
bugs are** — this is now the third consecutive slice where running the thing
found what a full green gate did not. Budget the hand-exercise; it is not
optional polish.
→ And specifically: **a belief about retrieval quality written into MEMORY.md is
still a belief.** The AND semantics could have been checked in one `psql` line
at any point in the two sessions the claim sat there.

**"Blocked on X" was inherited for two sessions, and then disproved with the wrong
argument.** MEMORY.md recorded the paid embedder as blocked behind the same OpenRouter
spend cap as narration. Checking the price dissolved that: embedding the whole corpus is
5,114 tokens ≈ **$0.0001**, against narration's ~$0.45/month — four orders of magnitude
apart, filed under one sentence. So the migration was started on the strength of "it is
not actually blocked"; the first live call returned **403, budget already exceeded**. The
cap is a *lifetime* budget that was already spent, so the cost of the operation was never
the relevant number.
→ Two distinct lessons, and the second is the sharper one. **A constraint copied forward
is not a verified constraint** — that sentence sat unchallenged through two sessions and
one line of arithmetic moved it. And: **checking the price is not checking the balance.**
Having just criticised an inherited belief, the replacement belief was adopted with
exactly the same rigour it was accused of lacking. When correcting an assumption, verify
the *new* claim at least as hard as the one being discarded.
→ Practical form: `GET /api/v1/credits` reported `total_credits: 0` even *after* the
budget was raised and calls were succeeding. **The only reliable test of a paid endpoint
is a paid call.** One 5-token request costs $0.0000001 and answers definitively.

**Fusing a weak ranker with a strong one at equal weight made the strong one worse.**
Once the embedder became semantic, the ORed full-text half went from lifeline to liability:
over six paraphrased questions the vector half alone scored **5/6**, the lexical half
**2/6**, and RRF over both **4/6**. Reverting the lexical half to AND restored **5/6** —
because strict, it returns nothing rather than something plausible, and a half that
abstains cannot outvote a half that knows.
→ **The right strictness for one half is a function of what the other half can do**, so it
is passed in rather than configured: `require_all_terms=vector_is_semantic`. A weight
would have needed a number nobody could justify; a boolean derived from a property the
system already knows needs none.
→ The general form, and the reason this is written down: **a justification can expire.**
The OR rewrite was correct, measured, and documented with its reasoning — and that
reasoning ("the hybrid would be one placeholder embedder wearing two hats") became false
the moment the placeholder was replaced. Comments that record *why* are what make this
detectable; a comment that had only recorded *what* would have survived unchallenged.

**The eval set found three bugs on its first run, and two were predicted and still shipped
first.** "What will my portfolio be worth next year" contains "worth", so the total handler
answered a forecast with *today's* figure. "Should I sell my largest position" names the largest
position, so that handler answered with its value — dodging a request for advice silently instead
of declining it (guideline 2). Both were written into the eval *expecting* them to fail, and they
did; both are now refused before any handler runs. The third was the gold case above.
→ **Write the case for the bug you suspect before fixing it.** A fix with no failing case first
cannot show that it fixed anything, and an eval that has only ever passed has not yet been shown
to be able to fail.

**A metric improved because a case was relabelled.** Once the gold case expected "hedged" rather
than "refused", the threshold report stopped counting it as out-of-domain — and separation jumped
from +0.0667 to **+0.1404** with the floor reported "inside the gap". Nothing about retrieval had
changed. Cases now carry `out_of_domain` for what they *are*, independent of what is expected of
them, and the report is back to the true figure.
→ **What a case is must not change because what we do about it changed.** Otherwise every
decision to accept a behaviour also quietly improves the measurement of it.

**First person does not mean "about my portfolio", and the obvious router ships that
bug.** Keying intent on "my"/"I" fails immediately on *"how much did I lose from the
top"* — first-person, and a **concept** question about drawdown. So is "should I sell
when things drop". What separates the two is a reference to their *holdings*, not to
them.
→ **Pronouns describe how someone writes, not what they are asking about.**

**A word boundary does not make a ticker unambiguous.** The symbol matcher was written
as `\bSO\b` with a comment claiming it stopped Southern Company firing on the word
"so". It does not — `\bso\b` matches "so" perfectly well, and a test written to check
the comment failed on the first run. Tickers are conventionally upper case, so the match
is now **case-sensitive against the original question**, and a lowercase "aapl" falls
through to CONCEPT (the harmless direction).
→ **A comment asserting a property is not the property.** This one was written,
believed, and disproved by the test that was written to confirm it — which is the whole
argument for writing the test.

**The evidence validator caught a derived figure in a template, not a model.** "This
excludes **1** unpriced holding" — the 1 is `holdings_count - priced_count`, computed in
the sentence and absent from the evidence. The validator rejected it exactly as it
rejects a model's invention.
→ **The validator is not an LLM guard, it is a provenance check**, and it is worth
pointing at deterministic text too. A figure the reader cannot trace is untraceable
whoever wrote it.

**The compose gate was counted as coverage for `/ask` and never called it.** Slice 3's
PR went up green with "the compose smoke test passes" as part of its evidence.
`scripts/smoke-test.sh` exercised the M1 vertical slice and nothing since — not `/ask`,
not even `/concepts/:slug` from slice 1. Adding the checks then found two more things: a
Python f-string with escaped quotes in its expression, which is a `SyntaxError` before
3.12 and would have failed on the host's 3.9 — and that the `not_in_corpus` refusal
**cannot be asserted in CI at all**, which MEMORY.md had just claimed the eval set could
measure.
→ **Before citing a gate as evidence, check what it runs.** Green means "every check
that exists passed", and says nothing about checks that do not exist.
→ Every new check was then fed bad input to prove it could fail — six assertions, all
failing as they should. A check that has only ever passed has not yet been shown to be
a check.

**The smoke test replaces every holding in the database it points at.** It imports with
`mode: "replace"`. Running it against the shared dev stack deleted and rewrote the
portfolio — harmless *this time*, because that database already held the demo portfolio,
which was confirmed afterwards by reconciling against the last snapshot to the cent. But
it was confirmed afterwards rather than checked before. The script header now says so in
capitals.
→ **Read what a script writes before running it against data you did not create.** The
reconciliation also carried its own trap: a naive cost-basis sum was $504.93 short, and
the entire gap was SAP.DE's euro cost basis converted at EUR/USD 1.1465 by the snapshot
and not by the query. A mixed-currency sum is not a total (guideline 3), and an alarming
discrepancy should be checked for that first.

**A stale placeholder in `.env.example` became a boot failure.** M0 wrote an
`EMBEDDINGS_PROVIDER=fastembed` block with a 384-wide model, two milestones
before anything read it, and every local `.env` copied it. Slice 2's factory
refuses an unknown provider by design, so those installations would have met
"not a known embedder" on upgrade — a message that reads like a typo the reader
did not make. `fastembed` is now named explicitly and answered with "this is an
M0 placeholder, set `fixture`".
→ **A setting written before anything reads it is a guess that will be found by
the code that finally reads it.** Prefer adding configuration with its consumer.
→ `EMBEDDINGS_DIM` was deleted rather than honoured: the width is fixed by the
column, so an env var appearing to change it is a lie about what is
configurable.

**A fixture that looked like a solved problem.** The synthetic price history made the analysis
engine testable and also let the missing `history()` survive two milestones. A fixture hides an
absence.
→ When a fixture stands in for a real source, **record what is still missing** rather than treating
the green test as coverage.

**A renamed migration was verified by reading the working tree, and CI tested the commit.** Another
session renumbered `0014_instrument_profiles` → `0015` to follow #49's `0014_intent_revocation`. Its
commit was a *pure rename* (0 lines changed); the edited `revision`/`down_revision` were left
uncommitted in the worktree. This session "verified" the renumbering by reading the file on disk,
said it was correct, and CI failed with two Alembic heads.
→ **Verify a commit with `git show <sha>:<path>`, or in a clean `git worktree add --detach` of it —
never by reading the working tree.** "Verify by content" (the stacked-PR lesson) only works if the
content you read is the content that ships.
→ A peer session's "nothing uncommitted was touched" is a claim, not a check.

**The same gate-that-cannot-fail, a fourth time.** `ruff format --check . | tail -1` exits with
`tail`'s status, so a failing format check let a commit through. It was caught only because the
output line was read. → **Never pipe a gate into `tail`/`grep` inside an `&&` chain.** Run it bare,
or `set -o pipefail`.

**A failed fetch cached as "no data" would have become a fact.** The first universe build cached
`{}` for 41 symbols Yahoo rate-limited — including **GOOGL**, which two eval cases expect; it would
have looked like a resolver miss. Now a failure is not cached and the build refuses to write a
snapshot with holes. The mirror case arrived in slice 2: Yahoo's "No Fund data found" for an ETN
*is* an answer (no holdings) and raises the same exception type as a transient error, so the
message decides.
→ **Absence and failure must never share a representation** — the `null`-price rule, again, for a
cache.

**A scripted string replacement silently did nothing.** An edit to the holdings fetch matched text
the formatter had already re-wrapped; the constant it added landed, the `except` branch did not, and
the build failed the same way again. → When editing by script, **assert each anchor matched
exactly once**; a replacement that finds nothing is not an error in Python.

**Tuned gains did not generalise, and only the sealed batch could show it.** Slice 2 took the
primary suite from 5/20 to 9/20. On the sealed batch it changed nothing — 1/11 and 14/35 for both
slices. Every design choice after the first run had been made while looking at the primary suite.
→ **An eval you have looked at is a development set.** Keep a batch sealed until a change is final,
and treat the unsealed number as the result.

**CHECK constraints written from assumption were corrected by data — the right way round.**
`weight <= 1` rejected a leveraged fund's 106% position and a reporting error at 66,880%; the load
ran in one transaction and rolled back cleanly. The fix was to skip and count such rows, not to
loosen the column. Same lesson as 0006's `runs_kind_check`: **a constraint is only exercised by
data**, and it is better met here than in production.

---

**A layer with no caller is not done, and a green suite cannot say so.** M2 built and tested the
whole news pipeline; nothing ever called it, so `articles` was empty in every installation for three
milestones, and M5's plan assumed news existed. The same session found topic instruments had no
price history, because backfill read holdings only. Both were found in the first ten minutes of
topicScan by asking "what writes the table this reads?" and grepping for callers.
→ **Before building on a layer, grep for its callers and look at its table's row count.** "It has
tests" and "it runs" are different claims.

**GDELT's 429 was blamed on us for a whole handoff, and it was not ours.** Slice C saw 429s after
two quick curls and concluded the IP was throttled and would recover. It never recovered, and the
theory went untested because it was never framed so it could fail. The test took four requests:
the scheduler's requests were already 30 min apart and still refused; spaced probes 20 s apart
were refused with or without OR terms, `sourcelang` or a large window; one plain query succeeded
and the identical URL was refused two minutes later. A limit that depends on neither our rate
nor our request is the server's load, not our counter. → **Before explaining a failure by our own
behaviour, vary that behaviour and check that the failure moves with it.** Spacing probes
beyond the stated limit (20 s against a 5 s limit) is safe and is how to do it.

**`text-start` on a header row centred every `<th>`, in English too** (#142). Browsers centre a
header cell unless an ancestor sets an explicit alignment, and `text-align: start` is the initial
value, so Chrome does not count it - `left` did. All eight tables were affected; the tests passed,
the screen did not. Fixed once in `index.css` (`th { text-align: inherit }`). → **A logical value
that equals the initial value is not "set".** After a mechanical CSS rewrite, look at the pages;
a class-for-class swap is not behaviour-preserving by construction.

**Hand-built signed numbers reorder in right-to-left text** (#142-#144). `+0.41%` rendered as
`0.41%+`, `1–168` as `168–1`, `$AAPL` as `AAPL$`, and an English reason after a colon came out in
pieces: the Unicode bidirectional algorithm gives a leading `+`/`-`, a dash or `$` with no strong
letter beside it the paragraph's direction. `Intl` in he-IL inserts its own marks, which is why
every figure goes through `i18n/format.ts`; what is built by hand is wrapped **in the Hebrew
string** in LRI…PDI (`\u2066…\u2069`, signed figures, ranges, tickers) or FSI…PDI
(`\u2068…\u2069`, English fragments from the server); names go in `<bdi>`. → **In an RTL
language, check every number that has a sign, a range or a currency beside it, on screen.**

**i18next treats a parameter named `count` as a plural selector** (#143). Passing formatted text
under `count` ("5,223", "2 findings") makes it parse text to choose a form; in English it happened
to fall back to the base key, in Hebrew it would pick a wrong one. → **`count` only for numbers;
formatted figures are `value`.** The catalogue keeps that rule.

**Two Hebrew states translated to the same word** (#144): "Snoozed" and "Rejected" were both
"נדחה", one meaning postponed and one refused; the audit trail would have read "נדחה ← נדחה".
Snooze is "השהיה". Found by reading the screen, not by the parity test, which checks presence,
not meaning. → **A translation is reviewed on screen, by state, next to its neighbours.**

**`seed_head.sql` must carry every value a CHECK enumerates** (#144's CI). Adding `'he'` to a
CHECK failed `test_the_seed_covers_every_enumerated_value` until a seed row held it, so the
downgrade runs over real data. → **A migration that adds an enumerated value adds a seed row in
the same PR.** Run `test_migrations.py` against a throwaway Postgres container, never compose's
(see Local environment).

**A test that read the real clock failed on the 8th of every month** (2026-10-08).
`test_the_thesis_may_state_the_quantity_it_proposes` used the stray figure "8" and expected the
evidence validator to refuse it; the briefing carries the scan's timestamp, whose year, month and
day are sourced figures, so on any 8th it passed as sourced. Two sessions fixed it the same morning
(this one with 77, #188 with 777 - #188's landed). **Lesson: a test on `datetime.now()` whose
assertion is about small numbers is a calendar test in disguise; pick figures no date can contain,
or pin the clock.**

**A query on every page made unrelated tests hang** (UX2). The bar's inbox count turned
`proposalsQuery` into an always-active query; the confirm and run-scan mutations return their
`invalidateQueries` promises from `onSettled`, so they now waited for it - and tests whose `get`
mock answers only the page's own paths left it pending forever. The mutation never settled, the
"Bought 3 INTC" message never appeared, and the failure read as a UI bug. **Lesson: when a
component starts a query app-wide, grep the tests for catch-all pending mocks; a mutation that
awaits invalidation inherits every active query's fate.** Same shape in UX5: adding a holding waits
for the equity curve's snapshots.

**`git grep PATTERN REV -- path` from a subdirectory reports 0** (UX1 merge check). The pathspec is
relative to the working directory, so `-- apps/web/src` from `apps/web` matched nothing and a
merged change looked absent. **Verify by content from the root, or with `-- ':/apps/web/src'`.**

## Current technical debt

| Item | Where | Impact |
|---|---|---|
| **The template creator's UI has not been seen in a browser** | `MandateFields.tsx`, `TaxonomyPicker.tsx`, `InstructionsCheck.tsx` | jsdom covers the behaviour; layout, Hebrew RTL and the picker's menu are unseen. The UX4 rehearsal method (below, "Running a branch's orchestrator against a copy of the live DB") does it without touching the dev database |
| **No real model has run `mandate_check`** | `app/agents/mandate_check.py` | Tested with scripted answers only. A model that paraphrases instead of copying quotes has every conflict dropped - safe, but it then looks like it never finds one. Read the first real `llm_calls` rows with `purpose = 'mandate_check'` |
| **Mandate limits are not re-checked at approval** | `services/tradeApproval.ts`, `fills.ts` | The scan checks a buy against capital at cost; a proposal approved later, after another approval moved cash, can land past a limit. The fill still refuses what cash cannot cover. Approving is the user's explicit act |
| **The instructions are still `persona` underneath** | `agents.persona`, `AgentView.persona`, wire code `no_persona` | Relabelled in the UI only ("Additional instructions", D170/D174); renaming the column and the code is churn with no behaviour, left on purpose |
| **Narration's and the agents' figure checks still read a timestamp's digits as sources, and refuse U+2011 hyphens** | `app/narration/evidence_validator.py`; the assistant fixed it in `app/assistant/reply.py` only | A small whole number (a day, hour or minute) written by a model passes whenever its evidence carries a timestamp that contains it; "7‑day" with a non-breaking hyphen is refused. Moving `_without_dates` and the dash normalisation into the validator fixes both for everyone - and changes narration's behaviour, so measure its rejection rate before and after |
| **A key with "pct" in it is read as a ratio, so the mandate's own percentages cannot be quoted** | `mandate.mandate_brief` (`min_cash_pct_of_capital`, `max_position_pct_of_capital` hold "25"), `evidence_validator.is_ratio_key` | Found 2026-10-21 (D235): a thesis writing "my 25% cash buffer" is refused as unsourced, because the validator offers 2500% for a `pct` key, never 25%. D236 makes a pass talk about cash, so this will bite more. Renaming the two keys (`..._percent_of_capital`) fixes it; stored briefings keep the old names, read only by the UI's folded JSON |
| **Scheduled runs serve only `SINGLE_USER_ID`** | `scheduler.ts` (`triggerRun` names no user), `routes/internal.ts` falls back to it | Found 2026-10-21: the second user's agent George has never had a scheduled scan; `agent_scans` runs report `"agents": 3`, the admin's. Every scheduled kind - scans, news, digest - is the admin's only. The three-part fix is M9-MEASUREMENT.md's "Scheduling" item; proposed as its own session |
| **A few cents above the buffer still asks for a justification** | `mandate.cash_above_buffer` (D235), `scan._quotes_idle` (D236) | As decided: any amount above the buffer is idle, so an agent left with $3 is sent back unless it quotes "3.00". Cheap and harmless, but reads oddly; a floor (cash that buys one share plus the fee) would need a decision |
| **`purpose = 'ask'` outlives `/ask`** | `Purpose` in `app/llm/base.py`, `SCOPE_FOR_PURPOSE`, `llm_calls`' CHECK, `services/llmPanel.ts`, `spend_estimate.py` | Nothing emits it since PR 4; kept so stored rows still read. Retention (30 days) empties them; then drop it with a migration |
| **A month written as a word is never checked** | `app/assistant/reply.py`, `app/narration/evidence_validator.py` (both read digits) | Live 2026-10-21 (llm_calls 476): a Hebrew answer gave a 2026-10-20 snapshot as "20 בנובמבר 2026" - November. The checks compare digits, so "20" and "2026" are the only figures they see; this time the year was missing from the evidence and the reply was refused, but "20 בנובמבר" alone, or "November 20" in English, passes with the wrong month. Not Hebrew-specific - D220 makes it likelier, because a Hebrew answer translates the ISO date instead of quoting it. A fix would be one rule in the assistant's instructions (quote dates as they appear in tool results) or month names in the validator, in both languages; measure first how often answers spell out a date |
| **The assistant eval runs only by hand** | `scripts/run_assistant_eval.py` | Keyed and paid, so never in CI: a prompt or tool change can regress it unseen. Run it (Flash-Lite, `--repeat 3`, ~$1.30 with the judge) before merging any change to the assistant's prompt, tools or checks |
| **No backup leaves the laptop** | `~/Backups/traders` (DB1, decision 137) | The daily dumps survive `k8s-down.sh`, a lost Docker volume and a bad migration, but not the Mac's disk failing or the laptop being lost: Time Machine has no destination and no synced folder exists (checked 2026-10-11). The fix is the user's - a Time Machine disk (`~/Backups` is already included) or a synced folder (`TRADERS_BACKUP_DIR`, then `backup-schedule.sh install` again) |
| **The shadow SPY pays no fees** | `services/performance.ts` (`benchmarkOn`), D38 | The user's choice for now (2026-10-05), to be revisited: they will add fees. The agent pays 10 bps / $1.50 on every trade and the shadow pays nothing, so the comparison leans slightly against the agent - about $1.50-$10 per deposit at today's budgets. When fees are added, decide whether each deposit pays one fee on the way in (the shadow buys once per deposit) and record it as a decision; the hint under the figures ("without fees", `agents.performance.hint`) must change with it |
| ~~A simulated agent has no stored daily value yet~~ | — | **Resolved by PR 7 (D36)**: the daily value is computed from the ledger and stored closes, not stored - no snapshot, no migration |
| ~~SPY has no stored prices~~ | — | **Resolved by PR 7**: the backfill always fetches the benchmark, and every instrument an agent has ever traded |
| ~~An `agent` fill does not yet require its proposal~~ | — | **Resolved by #182 (0044)**: `fills_agent_has_proposal`, and `proposals_trade_has_scan` beside it |
| ~~The lexicon sentiment scorer misreads market headlines~~ | — | **Resolved** (2026-10-08): the cause was tense - headlines say "Sinks", "Plummets", "Rises"; v1 listed mostly past tenses. `lexicon-v2` adds the present tenses (not "up/down/higher/lower", which name no price) and `scripts/rescore_sentiment.py` scores stored articles beside their v1 rows. Measured on a copy of the live database: articles matching no word 84.2% -> 80.1% (27,678 articles; the rest mostly name no price at all); 92 changed sign, nearly all one-sided -> balanced. Run the script once after any future `LEXICON_MODEL_NAME` bump, or the topic page keeps reporting the old lexicon (it reports the scorer that read the most articles) |
| ~~The Admin page shows a model as chosen when none is~~ | — | **Resolved** (2026-10-08): when the model in use is not offered for a scope (agents on the free route, or a chosen model since withdrawn) the picker selects a disabled "Not chosen – using <model>" entry, Save stays off, and the total counts nothing for that scope. When the model in use *is* offered (narration on the free route) it is selected, as before |
| ~~Approving a trade from Telegram is refused~~ | — | **Resolved by #186 (D62)**: Approve previews, Confirm fills at the signed price |
| **The give-up alert ignores quiet hours, mute and dedupe** | `scheduledScans.ts` (`reportGaveUp`) | Sent through `notifier.send`, not `fanOut`, so a slot that gives up at 03:00 messages at 03:00 and a muted user still hears it; it is once per slot only because it runs on the last attempt. Route it through the fan-out with a `refKind` for runs (a CHECK change) if it ever annoys |
| ~~Scheduled scans run for `SINGLE_USER_ID` only~~ | — | **Resolved by M9's completion (D238)**: every active user's due slots, enqueued round-robin. Was: | The ask plans one user's agents, as every run kind does. Multi-user means iterating users here, and per-user fairness on the queue needs BullMQ Pro's groups (D73) |
| **The plan needs the AI service's calendar** | `planScheduledScans` | With the AI service down the ask fails (recorded "AI service unreachable", HTTP 500 - a failed CronJob in kind) and the next ask, 15 minutes later, catches up; a slot's window is hours, so nothing is lost unless the outage outlasts it |
| **Agents' answers are refused for formatted figures** | evidence validator (`app/agents/answer.py`, `narration` checker) | The first scheduled scan (2026-10-08) wrote "1,923" - refused as unsourced. Measure how often real scans are refused and for what before changing anything; a computed figure (shares x price) is rightly refused, a re-formatted one may not be |
| **#197's commit title on `main` reads "wip: PR 7a before merging main"** | git history | Cosmetic and permanent (the ruleset forbids the force push a fix would need); the PR and this file name it correctly |
| **The trading strings in Hebrew were written by the model** | `he.json` `agents.trade`, `agents.account`, `agents.activity` | Read in the preview and laid out correctly, but not reviewed by the user line by line - the same standing as the earlier Hebrew row |
| **The exchange calendar ends 2030-12-31** | `data/calendar/xnys.json` | Its test fails from 2030-10-02; the fix is one generator command (RUNBOOK §4). A closure no rule predicts must be added by hand when announced |
| ~~Mastra is decided-retired but still runs~~ | — | **Resolved 2026-10-05**: Mastra retired (D11), schema dropped in 0039; `test/mastraSchemaOwnership.test.ts` went with it |
| **The primary's stored name is English** | `agents.name` = 'Main portfolio' (0036 trigger) | It is data, but it is the one agent name the product chose rather than the user. Stage 2's UI must render the primary through the i18n catalogue (`is_primary` → `t('agents.primary')`), never the stored string, or a Hebrew reader sees English |
| **The inbox, the digest, notifications and the run history are user-wide** | `-- agent-blind` reads in `queries/` (decision 103) | Correct while only the primary exists. When Stage 2 adds simulated agents, each entry must carry its agent's name and the simulation label (P2 amendment), and `GET /runs` filtered to an agent must leave out the agent-blind kinds (§3.3c) |
| ~~`llm_calls.agent` is still there, beside `purpose`~~ | — | **Resolved by #177 (0042)**: `agent`, its CHECK and the trigger are dropped; `purpose` admits `agent_scan`, which alone names an agent |
| **A Hebrew reader still meets some English server text** | decisions 96, 98 | **Narration in Hebrew - the approach agreed 2026-10-07, kept in mind, not scheduled:** one model call returns both languages (`{"en": ..., "he": ...}`); the validator checks each separately (it already reads Hebrew digits) and a failing language falls back to its own template while the other keeps the model's text; about double one narration's output, still pennies a week. *Rejected:* translating the English afterwards (a second call, and a translation can add figures the validator never saw). Measure the free model's Hebrew on real findings first, read by the user; amends guideline 1 for observations. `/ask` answers, news headlines and the concept corpus are English, marked `lang="en"`; a model-written observation reads as its template in Hebrew (its richer English prose is not shown). Next steps, each its own project: the corpus (4,253 words, translated and re-ingested per language); `/ask` (English intent rules and model); Hebrew narration by the model (the validator already reads Hebrew digits - the open question is quality on free routes, so measure it first) |
| **The Hebrew wording was written by the model and merged without line-by-line corrections** | `apps/web/src/i18n/locales/he.json` | The user asked to merge after a side-by-side list was sent (17 strings flagged as least sure: "נ״א", "סטייה בפיזור", "ירידה מהשיא", "השהיה", "מוערך בחסר", "מכשיר", "יקום", the ד׳/ש׳/ימ׳ abbreviations). Instructions use the plural ("בחרו") and possessives "שלך" - the user was asked whether to change the form and did not answer. Corrections are edits to `he.json` only; the parity test keeps them complete |
| ~~The sign-in page is always English~~ | — | **Resolved**: signed out, the page takes the first of the browser's preferred languages the interface has (`signedOutLanguage` in `i18n/index.ts`; "iw" counts as Hebrew), else English. Outside a browser it is always English, because Node exposes the machine's locale as `navigator.languages` and a test must not depend on it |
| ~~Duration abbreviations have no plural forms~~ | — | **Resolved**: the English `duration.*` keys gained `_one`/`_other` (both still "1d"), so Hebrew says it in words with its dual - "לפני יום", "יומיים", "5 ימים" - and the ד׳/ש׳/ימ׳ abbreviations are gone from durations. `countdown.left` became "עוד {{duration}}", which agrees with a singular ("עוד שעה") where "נותרו" did not. Still model-written, like the rest of `he.json` |
| ~~A dead rescreen waits for the next trigger~~ | — | **Resolved** (independent task 12): worse than this row said - a rescreen that died held its own day's key, and the one-running index (0031) refused **every later day's** key, button and CronJob alike, until someone edited the row. `claimRun` now meets that index by closing out runs of the kind that are dead by its own reclaim test (stale heartbeat, or never beat and older than `STALE_RUN_MINUTES`), marking them `failed` with `stats.supersededBy`, and claiming once more; a live one still refuses. The fetch cache is not tied to a key, so the new run resumes. Tested against Postgres as `traders_app` |
| **The snapshot volume is ReadWriteOnce** | `infra/k8s/base/universe-snapshots.yaml` | kind has one node, so every AI-service copy and the `universe` Job share the claim. On a multi-node cluster, pods on a second node cannot mount it: it needs ReadWriteMany storage or the rescreen pinned to one node |
| **An on-demand profile is never refreshed** | `app/universe/on_demand.py` | Written once (`DO NOTHING`); its size facts and description stay as fetched until a rescreen admits it (then the loader owns it) or it is deleted. A fetch lost to a dying process (`BackgroundTasks` is in-memory) is retried only the next time a user names the symbol - on a later local day, since gap events are counted per day but the request fires on every sighting |
| **The topic gate refused a nonsense phrase by 0.007** | `app/ask/relevance.py` (`refuse_below` 0.32) | Measured on compose 2026-09-30: "zzqx flibbertigibbet" scored 0.313, "medieval tapestry restoration" 0.245, "quantum computing" 0.584. The gate held, but a nonsense string sits 0.007 below it. `universe_gap_low_confidence` events now record every `none` with its score; **look at their distribution before moving the gate**, not at one example |
| **Model cost reads $0 on this installation** | `.env` `LLM_MODEL` (a `:free` OpenRouter route) | Every recorded call is priced 0 because the configured route is free - true, and the panel (#126, decision 88) says "free route" rather than $0. "Free" is read from the `:free` suffix alone: a free route OpenRouter names differently would show as "$0", a price. The cost column has not yet been seen non-zero on real data |
| **A low-confidence topic cannot be produced in the kind cluster** | fixture embedder, `app/ask/relevance.judge` | Keyless by decision 79: on a non-semantic embedder the judge abstains, so every topic is `weak`, never `none`. Show that event on compose |
| ~~The app connects to Postgres as a superuser that owns every table~~ | — | **Resolved** by decision 93 (independent task 9, migration 0033): the services connect as `traders_app`; the owner runs migrations only. What remains is the next row |
| **The owner's password still reaches every container** | compose `env_file`, kind `traders-secrets` | Compose loads `.env` into every service, and every kind pod reads the one Secret, so `POSTGRES_PASSWORD` (and in kind `MIGRATION_DATABASE_URL`) is in each service's environment even though no service uses it. Task 9 closed the SQL-injection path (a query runs as `traders_app`); code execution inside a service could still read the owner's password. Fix: a second Secret (and a second env file) that only Postgres and `migrate` mount - it changes the shape of `secrets.env` and `.env`, which is why it was not folded into task 9 |
| **The integration suite changes a cluster-wide role's password** | `tests/integration/test_admin_audit_sql.py` | `as_app` sets `traders_app`'s password to a test value, and a role belongs to the whole Postgres server. Harmless in CI (its own server); against a server that also hosts a running stack, the services lose their login until `migrate` runs. A fix: create a per-run role for the test (`traders_app_test_<random>`, granted like `traders_app`) instead of borrowing the real one |
| **Telegram's inbound delivery is unproven** | deployment | Still true after M7, deliberately: the cluster runs with Telegram off (decision 79). **The user decided (2026-09-30) to prove the webhook in a real cloud deployment with HTTPS**, not through a tunnel from the laptop; `setWebhook` on the real bot stops the compose stack's polling, so it waits for that deployment. Everything else was exercised against a real bot, but `setWebhook` needs a public HTTPS URL. The handler has only ever been driven by replaying genuine payloads at it locally. **The first real deployment is the first real test of that leg** — check `getWebhookInfo` for `last_error_message` immediately after |
| ~~`queries.ts` conflicts on every parallel PR~~ | — | **Resolved** (independent task 15, decided by the user 2026-10-01): 21 modules under `src/db/queries/`, one per concept, and `queries.ts` is an index of `export *` lines, so no call site and no `vi.mock('../src/db/queries.js')` changed. A pure move, checked as one: every non-blank, non-import line of the old file appears in the new ones exactly as often (bar `export` prefixes and the section banners the file names replaced). One private helper, `LIVE_TOPIC`, is exported now because topics and topic proposals share it. CLAUDE.md's rule reads "all SQL lives under `src/db/queries/`". **A new module needs its `export *` line in the index** - typecheck catches a caller of a function that is not re-exported, but not a module nobody calls yet |
| ~~Migration 0008 hard-codes a table Mastra owns~~ | — | **Resolved 2026-10-05**: Mastra retired (D11), schema dropped in 0039; `test/mastraSchemaOwnership.test.ts` went with it |
| ~~Concept chips point nowhere~~ | — | **Resolved in M3 slice 1.** Kept as a line rather than deleted because it stood here from M2 to M4 and its absence would otherwise read as an oversight |
| ~~Retrieval is exact-match only~~ | — | **Resolved in M3 slice 2.** Hybrid retrieval exists and `GET /concepts/search` serves it. What is still missing is the *answer*: there is no `/ask`, no intent routing, no citations and no relevance floor, so a nonsense query still returns the three least-bad chunks rather than a refusal. That is slice 3 |
| ~~No test executes a line of retrieval SQL~~ | — | **Resolved** (independent task 4): the `postgres (integration)` CI job - see "Orientation". It found a real bug on its first run: 0019's upgrade could not follow its own downgrade (below) |
| ~~OWED: migrate the fixture embedder to a paid OpenRouter embeddings model~~ | — | **Done.** `openai/text-embedding-3-small` through OpenRouter, verified against the live endpoint: 36 chunks, 5,114 tokens, **$0.00010228**, no chunk id moved. Set `EMBEDDINGS_PROVIDER=openrouter` to use it; the code default stays `fixture` so CI and a fresh clone remain keyless. The fixture was **not** deleted — it is the hermetic CI path and slice 4's eval set needs it |
| **The relevance floor is measured to be in the wrong place** | `app/ask/relevance.py` | `REFUSE_BELOW = 0.23` was fitted to sixteen questions. On the eval's held-out questions the classes separate at **(0.2502, 0.3169]**, so 0.23 sits *outside* the gap — and every keyed CI run prints that verdict. It was deliberately **not** moved: combined with the fitting set the classes overlap (0.2498 vs 0.2502), and a value chosen to make the held-out set pass would make it a training set. The hedged weak answer (decision 36) is what covers the boundary meanwhile. **The honest next step is more questions, written by someone who has not read the corpus**, not a new number |
| **The keyed eval tier does nothing until a secret exists** | GitHub repo settings | The `eval-keyed` job skips with a notice unless `OPENROUTER_API_KEY` is a repository secret. **Until it is added, nothing automated tests the `not_in_corpus` refusal** — the one M3's exit criterion names — because the floor abstains on the fixture path. Adding the secret is a settings change only a repo admin can make; it was deliberately not done from a session |
| ~~`/ask` has no user interface~~ | — | **Resolved in M6 PR 10** (decision 70): `/ask` in the web app, linked from the dashboard header. Kept as a line because it stood here from M3 to M6 |
| ~~`narration/templates.py` divides money by 100 unconditionally~~ | — | **Resolved** (independent task 1): templates render minor units at the currency's exponent (`minor_unit_exponent`), and **the evidence validator had the same assumption** - it divided every `_minor` figure by 100, so it would have *approved* "150.00" for 15000 JPY. It now reads the `currency` declared by each evidence mapping. The old template and old validator agreed on the wrong number, which is why no test saw it; the rule-output tests now run in JPY as well as USD |
| **The corpus is a derived copy that three separate mechanisms keep in step** | `data/corpus`, compose, `.claude` | The files are the source of truth and `kb_documents`/`kb_chunks` are what the API serves. A hook covers Claude's edits, the `corpus` container covers every stack start, CI covers the image. None of the three covers a hand edit on a machine with no stack running — that reader sees stale text with nothing reporting the disagreement. `--dry-run` answers "are they in step?" and nobody is obliged to run it |
| **The ingest hook does not apply to a session started before it existed** | `.claude/settings.json` | The settings watcher only watches directories that had a settings file when the session began, and `.claude/` had none. Any session started after that commit picks it up; the session that wrote it did not, and confirmed so with a sentinel rather than assuming |
| **Import previews live in process memory** | `services/previewStore.ts` | Forces `replicas: 1` in Kubernetes, **`strategy: Recreate`** (a few seconds with no API per deploy) and **no autoscaler on the orchestrator** - MILESTONES asks for an HPA on both services; the user chose the AI service only (M7). The Telegram poller would also run per replica. The only remaining in-memory state — run keys moved to the `runs` table in M2 |
| ~~The cluster's `secrets.env` belongs to the checkout that ran `k8s-up.sh`~~ | — | **Resolved** (independent task 13): with no file, `k8s-up.sh` recovers it from the Secret the running Postgres StatefulSet reads (so a worktree or a fresh clone deploys to the existing cluster without copying anything), and refuses when `data-postgres-0` exists with no Secret to recover from. Checked against the live cluster: the recovered file was identical to the main checkout's, mode 600 |
| ~~A decided proposal's workflow can stay suspended forever~~ | — | **Resolved** (independent task 14): `sweepAndCloseLifecycles` also resumes, with `refresh`, every run still suspended on an approved/rejected/expired proposal (`listLeftoverLifecycles`, 50 per sweep); `refresh` reads the proposal, finds it finished and ends the run without writing anything. Chosen over closing it inside `decideProposal`'s fallback, which runs exactly when a resume has just failed; the sweep retries every 15 minutes and also clears runs left before this. The run's stats now carry `closed` beside `expired` |
| ~~The sign-in page says "the passphrase from your environment file"~~ | — | **Resolved** (independent task 10): it names `APP_PASSPHRASE` and both places it lives |
| ~~No CI job deploys to kind~~ | — | **Resolved** by the `kubernetes (kind)` job (M7 PR 7, #116). Original text: |
| (history) No CI job deploys to kind | `.github/workflows/ci.yml` | Planned with the user (M7 decision 7): a job that creates a kind cluster, deploys, and runs `kubectl create job --from=cronjob/run-backfill`. Not built yet; until it is, the manifests are proven only on this machine and can rot like compose would without its smoke test. Belongs in PR 6 or PR 7 |
| **The cluster's daily digest reads `degraded` every day** | `infra/k8s/base/config.env` | With Telegram off (decision 79) the run records "TELEGRAM_BOT_TOKEN is not set, so there is no channel to deliver on" - true, and seen on the first CronJob-fired digest (2026-09-30 12:16 UTC). The digest's UI card still works. Harmless noise in `runs`; revisit if the cluster ever gets a bot, or if a run-health view starts counting `degraded` |
| ~~A crypto day's "close" is stored intraday the first night~~ | — | **Resolved** (independent task 11): `backfill.is_final` treats a crypto candle as final only once its UTC day is over, not at its 20:00 stamp |
| **Templates are the deliberate steady state until deployment** (decided 2026-09-23) — funding narration was considered and **declined for now**, to be revisited when the product is deployed for real. So a future session should *not* treat template-only explanations as a defect to fix: the cost is known ($0.45/month), the fix is known (raise the OpenRouter workspace cap, point `LLM_MODEL` at a capable model), and the decision is to wait. | `.env` | Explanations are fixed phrasing over checked figures, and the dashboard badge says so |
| **The free tier cannot narrate at all, and the reason is not cost** | `.env`, `app/llm` | `LLM_MODEL` is a `:free` route because the OpenRouter workspace has a **lifetime** budget of $0.01 — a cumulative cap, not an allowance, so nothing resets and only an org admin changes it. On the free model narration now reaches the evidence validator and is **rejected every time** (`unsourced_figures`, 3/3 measured) for deriving figures not in the evidence. So free means templates, reliably. Real usage is ~$0.0015 per narration and ~10 findings a day ≈ **$0.45/month**, which is what funding the workspace costs. The badge (#38) states this to the user rather than hiding it |
| ~~Crypto detection is a symbol-shape heuristic~~ | — | **Resolved** (independent task 5): the quote request carries each symbol's `asset_class`; the `-USD` suffix is only the fallback for a bare lookup with no class |
| ~~Market hours assume US sessions for every symbol~~ | — | **Resolved** (independent task 5): `app/core/market_sessions.py` maps exchanges - display names *and* Yahoo codes, both present in `instruments` - to their own session in their own timezone; an unknown exchange keeps New York hours. Holidays, auctions and lunch breaks are still ignored, deliberately |
| ~~Server state is hand-fetched in every MobX store~~ | — | **Resolved in M6** (decision 64, #90-#92 and the topics PR): every read is a TanStack Query query, and no store holds a copy of a server response it must remember to refresh. What stores still call is writes (which update or invalidate the cache), the session check (changed only by the store's own sign-in and sign-out), and responses to one-off actions - an import preview, a topic resolution for the label being typed, the Telegram connect link - none of which is a resource to refresh |
| ~~The Topics screen has never been looked at in a browser~~ | — | **Resolved** (independent task 3, 2026-09-28): reviewed at desktop and 375 px against the live stack - the list, a topic card, and the confirm screen over a real 13-candidate resolution. Two faults found and fixed: the dashboard header did not wrap, so on a phone the page was 721 px wide and a tap on "Topics" landed on "Settings" (the only way to reach the page); and each candidate's checkbox was centred in its row, so on long quotes it sat beside the quote rather than the ticker it ticks. "Suggested from the news" was seen with real proposals on 2026-09-29 (#86), including the weak-match toggle; not yet at 375 px. Timestamps use the browser locale app-wide (`formatExactTime`); that is M6 polish, not a Topics fault |
| **Few component/DOM tests on the web app** | `apps/web/test` | Started with the TanStack Query foundation: `test/serverStateHarness.tsx` renders with a real query client and root store and only `api` mocked; a `.tsx` test opts into jsdom with `// @vitest-environment jsdom`, so the store tests stay in node. Rendered so far: the feed's four states, the holding writes, the Telegram card, the live inbox's interval, the topic card (`feed`, `holdings`, `telegramConnect`, `inboxRefresh`, `topicCard` `.test.tsx`). Earlier lesson kept: two UI bugs (Discard disabled by its own typo, a deep link that did nothing) were found by using the app, and a DOM test would have caught the first |
| ~~Telegram has no working binding~~ | — | **Resolved 2026-09-24.** A chat is bound. The "receives nothing" mystery was never a Telegram problem: nothing in the repository consumed updates, because M4's polling bridge was a hand-run script that left with its session. Kept as a line so the history of the symptom survives |
| **Real news needs `NEWS_PROVIDERS=gdelt,fixture` in `.env`** | `.env` | Slice C added the GDELT provider; the code default and `.env.example` stay `fixture` so CI is offline (the same deliberate asymmetry as `MARKET_DATA_PROVIDERS`). Until `.env` names `gdelt`, every live `news_collect` run fetches 0. **Also still unwired:** the narration correlation step - `run_portfolio_scan` is always called with `articles=()`, so no observation cites news yet |
| ~~Auto-discovery has run once on real, title-matched headlines and proposed nothing~~ | — | **Resolved 2026-09-29** by the market feed (decision 60): the first run over it proposed "data center" and "bond yields". The original text follows because its lesson (resolve budget spent on everyday words) still shapes `GENERIC_WORDS` |
| (history) Auto-discovery's first real run | `app/topics/discovery.py`, `services/topicDiscovery.ts` | 2026-09-28 10:33 UTC: 123 linked headlines, 20 phrases, 8 resolved, 0 proposed. Every resolved phrase was `none` or `weak` (`ai`, `buy`, `pro`, `prediction` none; `tv`, `crypto`, `iphone`, `remittix` weak). The 12 skipped by the 8-per-run cap were resolved by hand afterwards and none would have qualified either (`chips` resolves to potato-chip makers LW and UTZ; `futures` is `confident` with no confident candidate; `bytedance alibaba` is `weak` over NVDA/TSM/MU). **So 0 proposals was the right answer, and the run exposed two faults:** (1) the resolve budget went to everyday words - `buy`, `pro`, `use`, `billion`, `season`, `prediction` belong in `GENERIC_WORDS`; (2) single words are poor resolver queries (two-letter "ai" resolves to nothing), and the one multi-word phrase was the one with a real signal. Not yet shown: discovery *finding* a theme, which M5's exit criterion needs |
| ~~Open proposals never expire~~ | — | **Resolved** (decision 57, migration 0021): unanswered for `TOPIC_PROPOSAL_TTL_DAYS`, a proposal becomes `expired`, kept and named in the run's stats. Kept as a line so the history survives |
| ~~One standing drift is proposed again every day~~ | — | **Resolved** by decision 92 (independent task 8): a question belongs to an episode, not an observation. Measured first: 7 BTC-USD proposals in 7 days, mostly one after another, so the fix this row proposed (one open proposal per subject) would have stopped 1. Kept as a line so the history survives |
| ~~A holding's cost basis has no edit control~~ | — | **Resolved** (independent task 10): the row and card edit cost per unit beside quantity, starting from the stored value (`minorToDecimalString`, exact and round-tripped by a test), sent only when changed and always with its currency. **On the way, a latent money bug:** `PATCH /holdings/:id` read a `costBasis` sent without `currency` at USD's exponent, so 1500 for a JPY holding would have stored 150000 - the same family as task 1 (#73). It now reads the holding's own currency. No client had sent a cost alone yet, so no row was wrong; `packages/shared` also had no money tests at all until this PR |
| **The free model is slow and flaky for `/ask` and narration** | `.env` (`LLM_MODEL`) | Measured 2026-09-30: 18-69 s per `/ask` answer, once over 3 min; 1 in 7 answers looped (now rejected, #101); and after that morning's load the narration badge read "Model unavailable" (`provider_error`). Nothing is wrong with the code - the screens say what happened - but the experience is the free route's. The funded fix is the same as narration's row above |
| ~~An equity can have a weekend "close"~~ | — | **Resolved** (independent task 11): `observation_time.at_last_close` re-dates an equity or ETF quote read while its exchange is shut to the close it reports (Sunday -> Friday's close), in the exchange's own timezone. Only when the exchange is in `market_sessions` (`known_session`): an unknown one is not guessed as New York, since a wrong guess moves an observation to another day. Measured first: 48 rows dated Sunday 27 Sep 2026 on compose, one per dashboard visit. The 48 rows were deleted from compose at the user's request (2026-10-01), in a transaction that committed only if exactly 48 matched |
| **Company names that are everyday words link falsely** | `app/news/entities.py` | Measured on the first raw-file run (2026-09-27 19:35 UTC): 2 of 18 stored articles were about the fruit - "Apple Cider & Donut Day at the Kinney Pioneer Museum", "Czipar's annual Apple Festival" - and linked to AAPL, because a capitalised "Apple" in a headline matches the company. The same will happen for "Target", "Block", "Visa", "Shell" when followed - and for **surnames**: on 2026-09-29 the "gasoline" topic card showed "Auxiliary Bishop René Valero and His Legacy" (thetablet.org) linked to VLO. Consequences: the fruit lands on the topic card and in sentiment, and discovery reads it ("festival" was a candidate phrase on 2026-09-28). The provider is not at fault; the matcher accepts a bare name as a sole signal. **Deferred by the user to a dedicated PR after more data** - likely shape: for a name that is also a dictionary word, require a second signal (a ticker, "Inc", a product word) before linking, and measure precision over several days of runs, not one |
| **Laptop sleep leaves gaps in collection** | local scheduler | Overnight 2026-09-27/28 the runs jumped 20:30 -> 23:13 -> 03:21 -> 10:18 UTC. The cursor caught up (16 files a run, never older than 48 h), so no news was lost - but the daily `topic_discovery` meant for local midnight ran at 10:33 UTC. Harmless for news; worth knowing when a "nightly" result appears at breakfast. **M7's CronJobs do not remove it on a laptop**: the kind cluster sleeps with the machine too, and `startingDeadlineSeconds` drops the stale ticks; the "ask often" rhythm is what catches up. Only an always-on cluster removes it |
| **Names ending in ", LP" never link to news** | `app/news/entities.py` `core_name` | `core_name` strips "Fund", "Inc" and the like but not a trailing ", LP", so "United States Gasoline Fund, LP" is matched - and searched on GDELT - only by that exact phrase, which prose never writes. **Not fixed on purpose:** 37 instruments in the committed universe have LP names, and `core_name` also shapes the resolver's matching text (`app/universe/matching_text.py`), so the fix moves topic resolution and needs the new held-out batch to measure. Fix both together, or give the news matcher its own rule |
| **A very large instrument list outruns the collect timeout** | `app/news/gdelt.py` | 8 names per request, 5.5 s apart: 500 instruments (the request cap) is ~63 requests, ~6 min, over the 5-minute `SCAN_TIMEOUT_MS`. Irrelevant at a dozen instruments; the fix when it matters is fewer, wider requests or a per-run instrument budget - **and retries shorten the headroom**: worst case per request is three 30 s timeouts plus 40 s of backoff (~130 s), so even today's dozen instruments (two requests) could need ~260 s of the 300 s budget. That worst case needs GDELT to time out rather than refuse, and refusals so far have taken 11-15 s |
| Redis cold start refetches everything | `core/cache.py` | The `quotes` table holds usable recent prices; warming from it was deferred |
| `instruments`, `quotes` and the news tables (and `instrument_profiles`, `etf_holdings`) have no `user_id` | migrations | **Intentional** — shared reference and market data, not user-owned. Documented so an audit does not re-flag it |
| **Topic resolution finds 14/35 expected tickers on held-out topics** | `app/topics/resolution.py` | Measured on the user's sealed batch; slice 2 did not change it. Causes, measured: one outlier sets the gate; no ETF clears the source floor for cloud/e-commerce/obesity/robot surgery; giants are described too broadly; OTC-only ADRs (LVMUY) are not in the universe. The backlog, ranked, is `docs/TOPIC_RESOLUTION.md` §4 — **and it needs a new held-out batch before any of it can be measured** |
| ~~The universe is not reachable from the running stack~~ | — | **Resolved in M5 slice 3** (`POST /topics/resolve`). The image copies `data/universe` without the descriptions; the compose `universe` container loads it on every start from a read-only mount of the checkout. CI loads hand-written fixture descriptions so the smoke test runs the resolver's SQL. **Still true:** nothing refreshes the snapshot itself, and a machine with no `descriptions.local.jsonl` answers `unavailable`, by design |
| **A fresh machine needs 30+ min of Yahoo fetching, and a retry, before topics resolve** (2026-10-01: a sample suggested ~10 min; the real rescreen was rate-limited, failed at 28 min on 64 symbols and needed two resumed retries) | `build_instrument_universe.py`, or the admin's rescreen button | Descriptions are not committed (decision 40). The build is resumable (`--cache`, `--holdings-cache`) and refuses to write a snapshot with holes; rate-limit failures are retried on the next run. Rebuilding also re-screens, so membership near the $1B line moves (LAC sits at $1.05B) |
| **Disambiguation is built and dormant** | `app/topics/meanings.py` | `MEANINGS_SPLIT_BELOW` was fitted before name stripping; afterwards no fitting topic splits, including "chips" and "mining". The code and its constant say so. Needs genuinely ambiguous fitting topics on current vectors before it is trusted |
| **Ticker networks still reach discovery through the followed feed** | `app/news/gdelt.py`, `market_feed.py` | `EXCLUDED_OUTLETS` applies to the market filter only (decision 60, deliberately: it did not change what the followed feed collects). But a network headline that names a followed company ("Nvidia (NASDAQ:NVDA) short interest...") is still collected and read by discovery, and on 2026-09-29 it produced a **weak proposal, "short interest"** (IWM, IWR, LQD...). Options: exclude the listed outlets from the followed feed too (changes topic news for the user - ask), or add "short interest"-style template words to `GENERIC_WORDS`. Measure on the stored window first |
| **The resolver cannot match events about private companies** | `app/topics/resolution.py` | "anthropic ipo" is a real, recurring story; it resolves `weak` to LLY, ABBV, PLTR - nothing to do with it - because Anthropic is not listed. Weak proposals are hidden by default exactly for this (decision 62), but the band does not say *why* the match is weak. A resolver change needs the new held-out batch (batch 3) |
| **The discovery window only started filling with market news on 2026-09-29** | data | The 7-day window held ~150 market headlines on the first run, ~1,600 the same afternoon. Expect the proposals to change over the first week as it fills - more themes, and stronger counts behind them. Do not tune anything on the first days' runs |
| **The outlet-country table is from 2018** | `data/outlets` | 98% of the measured week's market articles came from a listed outlet; newer outlets have no country and count against a phrase's lead country (errs towards keeping it). Rebuild instructions are in its README; re-measure the 0.75 bar after replacing it |
| **The market feed stops when the user follows nothing** | `routes/internal.ts` `news_collect` | The run is skipped with "no holdings and no topics", and the market feed rides on it. Harmless in v1 (there are always holdings); relevant the day an empty account is supported |
| **The topic eval is not in CI** | `scripts/run_topic_eval.py` | Needs a database holding the universe *and* a semantic embedder; CI has neither. `test_topic_eval_set_contract.py` guards the file on every PR, but no automated run measures resolution

---

- ~~Compose and kind run 0045 and pre-sprint UI~~ - **resolved**: both deployed at 0048 by the Stage 4 handoff session (2026-10-08). Was: until redeployed, the live app
  has no Insights page, no shared bar and no digest banner, and its web bundle would call
  `/notifications/digest/seen`, which only #193's orchestrator has - deploy both together, as
  `dev-docker.sh` and `k8s-up.sh` do.
- **Export is a browser download only** (UX6): no server endpoint, so Telegram or a script cannot
  ask for one. Add `GET /holdings/export` beside `holdingsExport` if that is ever wanted - the
  builder is already in `@traders/shared`.

## Local environment (this machine)

- **The daily backup is a launchd agent** (`~/Library/LaunchAgents/com.traders.db-backup.plist`,
  installed 2026-10-11 from the main checkout at the user's request): 04:00 local, both databases,
  into `~/Backups/traders/<kind|compose>/`, log `~/Library/Logs/traders-db-backup.log`. It runs
  **the main checkout's** `scripts/db-backup.sh` - a different branch checked out there changes
  what the backup runs. `bash scripts/backup-schedule.sh status|run|uninstall`.
- **In a worktree, the shared Python venv imports the main checkout's `app`.** The venv at
  `/Users/a/projects/Traders/services/ai/.venv` is an editable install of the main checkout, so
  `scripts/export_openapi.py` run from a worktree silently exported `main`'s models (2026-10-20,
  PR for D197: `openapi.json` came out unchanged). pytest is unaffected (it puts the worktree
  first); scripts are not. Run them as `PYTHONPATH=. .../.venv/bin/python scripts/...`.
- **Throwaway Postgres for the integration tests:** `docker run -d --rm --name <x> -e
  POSTGRES_USER=traders -e POSTGRES_PASSWORD=traders -e POSTGRES_DB=traders_ci -p
  127.0.0.1:55439:5432 pgvector/pgvector:pg16`, then `TEST_DATABASE_URL=...:55439/traders_ci
  INTEGRATION_REQUIRED=1 pytest tests/integration`, as CI does. **Not 55432: that is compose's
  Postgres.**
- **Both Postgres servers log statements over 200 ms** (DB3); `docker logs traders-postgres-1` and
  `kubectl ... logs postgres-0` are therefore no longer quiet, by design.

- **`ENABLE_SCHEDULED_SCANS=true` in the user's `.env` is deliberate** (2026-10-08, the user's yes):
  compose schedules agents' scans, kind does not (`config.env`), `.env.example` says `false` so a
  new installation never spends on its own. Do not "fix" the asymmetry. Off again = the line set to
  `false` and `bash scripts/dev-docker.sh`.
- **Rehearsing a scheduled scan end to end (PR 7b's recipe):** a copy of the live DB; a second AI
  service from the worktree on :8011 against the copy (`uvicorn app.main:app --port 8011`, env from
  `.env` with `DATABASE_URL` overridden); this branch's orchestrator on :8091 with
  `ENABLE_SCHEDULED_SCANS=true SCHEDULER_ENABLED=false TELEGRAM_BOT_TOKEN= REDIS_URL=redis://127.0.0.1:6379/5`
  (**its own Redis database**, flushed after); then `POST /internal/runs {"kind":"agent_scans"}` with
  the internal key. Start long-lived processes from a script with `nohup ... & disown`, or the Bash
  tool waits on them. To age a failed attempt past the hour, `UPDATE runs SET finished_at = now() -
  interval '61 minutes'` on the copy. A changed model on the copy (`llm_model_choices`) makes scans
  fail without cost.
- **`traders_ci` left at a revision that no longer exists** (after a renumber): undo the migration by
  hand there and `UPDATE alembic_version` to the last good revision, then rerun pytest - it
  migrates forward.

- **Stage 4 PR 5 recipes (2026-10-07), all run by the session itself on the Mac:**
  - *Rehearsal copy:* `docker exec traders-postgres-1 sh -c 'createdb -U traders <copy> && pg_dump
    -U traders traders | psql -q -U traders <copy>'`; alembic from the worktree with the main
    checkout's venv and `DATABASE_URL=postgresql://traders:$POSTGRES_PASSWORD@127.0.0.1:55432/<copy>`;
    drop the copy after. zsh does not word-split a `$Q` holding a command - use a function.
  - *Branch stack on the copy:* AI service `uvicorn app.main:app --port 8002` (`.env` sourced,
    `DATABASE_URL` as `traders_app:traders_app` on the copy, `REDIS_URL=redis://127.0.0.1:6379/0`,
    `UNIVERSE_SNAPSHOT_DIR` = main checkout's `data/universe`); orchestrator `npx tsx src/server.ts`
    on 8082 with `AI_SERVICE_URL=http://127.0.0.1:8002`, `SCHEDULER_ENABLED=false`, Telegram vars
    empty, and the copy's admin given a **throwaway password** (since D179:
    `printf '%s' "$throwaway" | DATABASE_URL=<copy> pnpm --filter @traders/orchestrator --silent
    admin:password --email admin@copy.test`, the value generated into the scratchpad; typing it is
    allowed - a test value on localhost - typing the real one is not), `ALLOWED_ORIGINS=http://localhost:5179`;
    web `API_PROXY_TARGET=http://127.0.0.1:8082 npx vite --port 5179`. **Both 8082 and vite bind
    every interface (Tailscale too)** - stop them as soon as the check is done, by port.
  - *Scripting the API:* a urllib cookie-jar script against 8082 (no `Origin` header). A scan
    straight at the AI service: `POST :8002/agents/<id>/scans` with `x-internal-key` and
    `{"user_id": ..., "trigger": "manual"}` (no proposal is written - that is the orchestrator's).
  - *The user's own signed-in Chrome* (Claude in Chrome) reaches the live app at `localhost:5174`
    for Admin/agent actions: `fetch('/api/...')` from its tab. The built-in browser pane is not
    signed in, and the real passphrase is never typed.
  - *The CI test Postgres* `traders-agents-ci` (127.0.0.1:55434, `traders_ci`) still runs; the
    Python integration suite and `queries.postgres.test.ts` as `traders` work there. As
    `traders_app` the password differs locally (auth fails): CI's app-role pass is the check.
- **A live-price approval needs NYSE open** (13:30-20:00 UTC = 16:30-23:00 Israel), and a trade
  proposal expires an hour after the open (D4) - test inside that hour.

- **Deployed at the Stage 3 close (2026-10-06):** compose and kind run `main` at `c73a163`,
  migration `0040_ledger`, from the main checkout (`bash scripts/dev-docker.sh`, `bash
  scripts/k8s-up.sh`, outside the sandbox); the compose smoke test passed after each deploy. No
  simulated agent exists on either; live `fills` is 0. SPY has no stored close until the backfill
  of 2026-10-07 (Israel day): the backfill claims one run per Israel day, and the 10-06 run had
  already happened when PR 7 deployed - **a deploy that adds an instrument to the backfill waits
  for the next day's run** unless a backfill is triggered with its own `runKey`.
- **Previewing something whose data comes from the AI service needs the AI service on the copy
  too** (PR 7): price history and the backfill read and write the database *the AI service* points
  at, so a branch orchestrator on a live copy with the compose AI service would read live data. What
  worked: a native AI service from the worktree on **8002** (`PYTHONPATH=<worktree>/services/ai`
  with the main checkout's venv `uvicorn`, `.env` sourced, `DATABASE_URL` → `traders_review`,
  `REDIS_URL=redis://127.0.0.1:6379/0`, `UNIVERSE_SNAPSHOT_DIR` → the main checkout's
  `data/universe`), the 8083 orchestrator's `AI_SERVICE_URL` pointed at it, then a backfill run
  with its own `runKey` through 8083. To give a chart history, the test agent's ledger rows were
  backdated **on the copy only** (`ALTER TABLE cash_movements|fills DISABLE TRIGGER USER` inside one
  transaction, re-enabled before commit) - never on live, where those triggers are the ledger's
  guarantee (decision 107).
- **Scripting the orchestrator's API:** a POST with an `Origin` the server does not allow is
  refused 403 - send **no** Origin from scripts (curl/urllib), or exactly the allowed one. The
  trade rehearsals used urllib with a cookie jar against a branch orchestrator on 8082 (live copy).
- **The preview recipe worked again** (8083 orchestrator on a live copy, `vite` on 5179, scripts in
  the scratchpad, `.claude/launch.json` in `info/exclude` and deleted after). The in-app browser's
  existing session carried over, so no passphrase was typed; the preview orchestrator was still
  given a throwaway `APP_PASSPHRASE` so the real one never left `.env`. The live account is Hebrew,
  so the preview opens in Hebrew - check English through the tests.
- **The market-hours check is real now:** a live-price trade is refused while NYSE is closed
  (16:00 New York = 23:00 Israel). Rehearse live-price trades in US hours; typed prices work any time.

- **The migration rehearsal on a live copy, as Stage 1 did it five times** (the user's standing
  rule): `docker exec traders-postgres-1 createdb -U traders traders_review`, then
  `pg_dump -U traders traders | psql -q -U traders -d traders_review` inside the container; record
  the nine owned tables' counts; `alembic upgrade head` from the worktree with
  `DATABASE_URL=postgresql://traders:traders@127.0.0.1:55432/traders_review` (and `PYTHONPATH=.`);
  compare counts; `downgrade -1`, check, `upgrade head`. Then run the **branch's orchestrator**
  against the copy: `npx tsx src/server.ts` with `DATABASE_URL` = the copy as `traders_app`,
  `AI_SERVICE_URL=http://127.0.0.1:8001` (the compose AI service), `ORCHESTRATOR_PORT=8082`,
  `SCHEDULER_ENABLED=false`, every `TELEGRAM_*` empty with `TELEGRAM_UPDATES=webhook` (so it does
  not poll the real bot), and `APP_PASSPHRASE`/`SESSION_SECRET`/`INTERNAL_API_KEY` taken from
  `.env` without printing them; `POST /internal/runs` with `x-internal-key` and **explicit fresh run
  keys** (see Bugs). Stop it **by its port** (`kill $(lsof -nP -tiTCP:8082 -sTCP:LISTEN)`), never
  `pkill -f src/server.ts`: that pattern matches any orchestrator on the machine, and on 2026-10-05
  it may have stopped the stray `m3-slice-2` one on 8081 (nothing listens there now). Drop the copy.
- **Throwaway Postgres for the integration suites, used throughout Stage 1:**
  `docker run -d --name traders-agents-ci ... -p 127.0.0.1:55434:5432 pgvector/pgvector:pg16`, the
  Python integration suite as `traders`, `scripts/migrate.py` with `APP_DB_PASSWORD=traders_app`,
  then `queries.postgres.test.ts` as `traders_app`. Removed after each use.
- **Deployed state at this handoff:** compose and kind were rebuilt from the main checkout after
  #152 (0036) and #154 (0037); #155 (0038) was deployed the same way (verified: both run `0038`, the trigger present, the orchestrator ready with no errors) by the same two commands
  (`bash scripts/dev-docker.sh`, `bash scripts/k8s-up.sh`, both outside the sandbox). Every
  scheduled run after 0036 finished `ok` and is owned by "Main portfolio".

- **Never point the Python integration suite at the compose Postgres while the stack runs.**
  Roles are per Postgres server, not per database, and `test_admin_audit_sql.py`'s `as_app` fixture
  sets `traders_app`'s password to a test value - so the live services lose their login until the
  next `migrate` (any `dev-docker.sh` start) sets it back. It was done once this session, against a
  throwaway `*_ci` database on the compose server, and the rebuild that followed repaired it. Use a
  separate Postgres container for local integration runs, or rebuild afterwards. **It happened
  again on 2026-10-02** (Hebrew server-text session): the live orchestrator logged 14 failed logins
  over a day, found only by reading its logs before the next rebuild. The memory note existed and
  was not read at the moment it mattered - check this section before any `TEST_DATABASE_URL` run.
  **Run the integration suites the way CI does, in a separate container** (worked 2026-10-04):
  `docker run -d --name traders-mastra-ci -e POSTGRES_USER=traders -e POSTGRES_PASSWORD=traders
  -e POSTGRES_DB=traders_ci -p 127.0.0.1:55433:5432 pgvector/pgvector:pg16`; the Python
  integration suite as `traders` against it; then **`scripts/migrate.py` with
  `APP_DB_PASSWORD=traders_app`** (the step whose absence made a 2026-10-02 attempt refuse with
  "schema is not at head"); then the orchestrator file with
  `TEST_DATABASE_URL=postgresql://traders_app:traders_app@127.0.0.1:55433/traders_ci`. Remove the
  container afterwards.
- **The Write tool turns `\u2066`-style escapes into the literal invisible characters.** Source
  that must hold bidi isolates (Python or TypeScript) was rewritten afterwards to use escapes so a
  reviewer can see them. macOS grep has no `-P`; this check works (and found one, fixed in #149):
  `git ls-files '*.py' '*.ts' '*.tsx' | xargs python3 -c "import sys; [print(f) for f in sys.argv[1:] if any(c in open(f, encoding='utf-8').read() for c in '\u2066\u2067\u2068\u2069')]"`
- **A worktree has no `services/ai/.venv`.** This session symlinked the main checkout's
  (`ln -s /Users/a/projects/Traders/services/ai/.venv services/ai/.venv`; untracked, never commit)
  and ran scripts with `PYTHONPATH=.` so they import the worktree's `app`. Before `PYTHONPATH` was
  set, `export_openapi.py` reported writing the spec and produced no diff.
- **At the Hebrew handoff (2026-10-02) compose and kind both run `main` at `7dcaf0a`, migration
  `0034_user_language`** (#144). The live account's `user_settings.language` is `en`.
- **Two browsers, two cookie jars.** The user signs in in **their Chrome**, not in the app's
  browser pane, and does not want to look for the pane; reading their pages needs the Claude in
  Chrome tools, with their go-ahead. The session cookie is per host, not per port, so any
  `localhost:<port>` dev server behind a `/__api` Vite proxy to an orchestrator shares the sign-in.
  `127.0.0.1` and `localhost` are different hosts. Chrome will not shrink below ~500 px: check
  375 px with an `<iframe style="width:375px">` written into a same-origin page.
- **A review copy of the live database is cheap and safe** (how #144 was checked before merging):
  `docker exec traders-postgres-1 createdb -U traders traders_review`, then
  `pg_dump -U traders traders | psql -U traders -d traders_review` inside the container, migrate the
  copy with the worktree's alembic (`DATABASE_URL=postgresql://traders:traders@127.0.0.1:55432/traders_review`),
  and run the branch orchestrator against it as `traders_app` with `SCHEDULER_ENABLED=false` and
  every `TELEGRAM_*` unset (a second poller would steal the real bot's updates). Drop the copy after.
- **Stray processes from older sessions:** an orchestrator from the `m3-slice-2` worktree
  listens on **8081**, and a Vite server from `~/.Trash/frontend` on **5173**. Neither was
  started or stopped by the Hebrew session; pick other ports (8082, 5175 worked).
- **Earlier, compose and kind both ran `main` at `1a12eac`** (#140; the line below is from #136, kept for its other facts)
- **Earlier, compose and kind ran `main` at `680ef20`** (#135), rebuilt and redeployed from the main checkout. **Both run migration 0033**: services connect as
  `traders_app` (compose password: `APP_DB_PASSWORD`, defaulting to `traders_app` because this
  machine's `.env` does not set it - set one if the stack ever leaves the laptop); kind's is in
  `secrets.env`, which `k8s-up.sh` upgraded in place on 2026-10-01.
- **The kind cluster was redeployed from this worktree during M8** (last: PR 5's commit
  `070fb0b`, whose content is `main`'s `a916ee6`), with the main checkout's `secrets.env` copied
  in (it is gitignored; without it `k8s-up.sh` would mint new secrets over a running Postgres).
  Its DB holds this session's test rows: gap events for AAPL/SAP.DE/BTC-USD/BYND/NOSUCHXQ, one
  `llm_calls` row. **Rebuilding compose restarts the scheduler, and the backfill fires 8 s after
  start, then hourly from there** - a rebuild after 21:00 UTC runs the next local day's backfill
  at once. **zsh does not word-split `$KUBECTL`-style variables**: run such snippets under
  `bash -c`, as CI does, or the command silently does not run (it cost one false "200" here).
- **A kind cluster named `traders` runs next to the compose stack**, recreated at M7's close
  (2026-09-30 ~14:30 UTC) **from the main checkout at `a13f662`** with that checkout's
  `secrets.env` and `data/universe` (5,223 profiles loaded); the smoke test imported the demo
  portfolio (10 holdings). Deploy it from the main checkout from now on (debt table). kind 0.33 is installed with Homebrew; kubectl 1.36. Every command
  names `--context kind-traders`. `bash scripts/k8s-up.sh` redeploys in ~1-2 minutes;
  `k8s-down.sh` deletes it (its DB holds only the demo portfolio). App:
  **http://traders.localhost**, as the admin (D179: a password in the database, printed once by
  `k8s-up.sh`; `bash scripts/admin-password.sh kind <email>` sets a new one).
  Docker has 7.75 GB; compose and the cluster together used well under half.
- **Docker Hub pulls time out inside the session's sandbox**, every time in M7: run
  `docker pull`, `build-images.sh` and `k8s-up.sh` outside the sandbox.
- **zsh traps met in M7:** `K="kubectl --context ..."; $K get` fails (zsh does not split words
  - use a function); `-o custom-columns=...[0]...` needs quotes (`[0]` is a glob); a heredoc
  containing `'"'"'` confused the tool's shell - write the edit script to a file instead.
- **A port-forward dies when its pod is replaced**, so it goes stale after every deploy.

- **`.env` has `MARKET_DATA_PROVIDERS=yfinance,fixture`** — real, 15-minute-delayed prices. Since
  decision 67 the trailing `fixture` is dropped at startup (a real chain never falls back to invented
  prices), so this is effectively `yfinance`: a Yahoo failure now leaves a holding unpriced.
  **`.env.example` keeps `fixture,yfinance`** so a fresh clone and CI run entirely offline with no
  API keys. Do not "fix" the difference: it is the point.
- Other processes on this machine hold ports 5432, `127.0.0.1:8000` and `[::1]:5173`/`[::1]:5174`.
  Every published port is configurable; this machine uses `POSTGRES_HOST_PORT=55432`,
  `WEB_HOST_PORT=5174`, `AI_SERVICE_HOST_PORT=8001`.
- **Prefer `http://127.0.0.1:5174` to `localhost`** — macOS may resolve `localhost` to IPv6 first,
  where a different project is listening. Either name now keeps the sign-in: the web app calls
  `/api` on its own origin (Vite proxy in dev, nginx in the image). Before that, compose baked
  `VITE_API_BASE_URL=http://127.0.0.1:8080` into the page, the cookie landed on `127.0.0.1`, and a
  page opened as `localhost` signed in with 200 and then got 401 on every call.
- The database currently holds ~1,800 real daily closes from Yahoo and a real portfolio scan's
  observations. Nothing synthetic remains in `quotes`.
- **A git worktree has no Python venv and no `.env`** — both live in the main checkout only, and
  `services/ai`'s editable install points at the main checkout's `app/`, so the obvious
  `.venv/bin/pytest` silently tests the *other* tree. Run a worktree's Python suite as
  `cd services/ai && PYTHONPATH=$PWD /Users/a/projects/Traders/services/ai/.venv/bin/python -m pytest -q`;
  `PYTHONPATH` precedes site-packages, so it wins over the `.pth`. `pnpm install` in the worktree
  does work and is needed once. **The same holds for every script**, and
  `scripts/export_openapi.py` is the dangerous one: run bare in PR 7 it wrote the main
  checkout's schema (17 paths, no new route) with no error, and the generated client had nothing
  to call. Check the path count it prints against the routes you added.
- **Every worktree shares one development database.** A background task's migration lands in the
  same Postgres the main stack uses, so the database can end up *ahead* of the running containers.
  That is how an "impossible" `Can't locate revision` appeared: the DB was at `0010_instrument_metadata`
  while the images still held 0009. **This recurred in M3 and will recur again**: applying
  `0012_kb_corpus` natively put the DB ahead of a `migrate` image still built from `main`, and the
  container died with `Can't locate revision '0012_kb_corpus'`. The fix is always the same —
  rebuild the image (`docker compose build migrate`), not touch the database.
- **The database currently holds the ingested corpus**: 9 documents and 36 chunks in
  `kb_documents` / `kb_chunks`, **all 36 embedded by `openai/text-embedding-3-small`**.
  Switching `EMBEDDINGS_PROVIDER` re-embeds on the next ingest and moves no chunk id,
  because the model is recorded per row. A fresh database needs
  `scripts/ingest_corpus.py` or a stack start, or every concept chip 404s and every search returns
  nothing. `--dry-run` says whether the files and the database agree without writing, and now
  reports embedding coverage as well as text — vectors are a second derived copy with the same
  drift.
- **As of 2026-09-29 05:25 UTC the stack runs `main` at #77 (`7752018`) and the database is at
  `0022_narration_transitions`**, rebuilt with `bash scripts/dev-docker.sh` (no `--reset`), and checked
  inside the containers rather than assumed. **`.env` has `NEWS_PROVIDERS=gdelt,fixture`** (the
  user's choice; `.env.example` keeps `fixture` - a deliberate asymmetry, do not "fix" it), which
  now means GDELT's raw files: about 96 downloads and **~300 MB a day** from
  `data.gdeltproject.org`. `articles` holds real, title-matched news from 2026-09-27 17:45 UTC on,
  plus 77 unlinked articles from the old search API that age out of every 7-day window by
  2026-10-04 (left in place by the user's decision; discovery ignores unlinked articles).
- **After a merge, the stack is not updated by itself.** Two steps, both needed: fast-forward the
  main checkout (`cd /Users/a/projects/Traders && git merge --ff-only origin/main` - compose builds
  from there, never from a worktree), then `bash scripts/dev-docker.sh`. Confirm by grepping the
  running container, e.g. `docker exec traders-ai-service-1 grep -c <marker> /app/app/...`; the
  orchestrator image runs its TypeScript source under `/repo/apps/orchestrator/src`.
- **Port 8081 is held by another worktree's orchestrator** (`m3-slice-2`, found 2026-09-27), and
  answers `/healthz` - so a "server is up" check on 8081 passes against the wrong code. Run a
  branch's orchestrator on 8083, with `SCHEDULER_ENABLED=false TELEGRAM_UPDATES=off` so it cannot
  double-fire runs or steal the container's Telegram updates.
- **The stack and the database are in step as of 2026-09-24**: both at `0013_kb_embeddings`,
  images rebuilt from `main` at #47 with `bash scripts/dev-docker.sh` (no `--reset`, so the
  Postgres volume and every holding, quote and observation were kept). Verified rather than
  assumed: `migrate` and `corpus` both exited 0, and the keyed eval run *inside the running
  container* passed 35/35. They will drift apart again the next time a worktree applies a
  migration natively — see the shared-database bullet above for the symptom and the fix.
- **`.env` must set `EMBEDDINGS_PROVIDER=openrouter`** to get semantic retrieval; the code
  default is `fixture` and stays that way so CI and a fresh clone need no key. This is a
  deliberate `.env` / `.env.example` asymmetry, like `MARKET_DATA_PROVIDERS` above — do not
  "fix" it. **This machine's `.env` is already correct** (fixed 2026-09-24; the pre-edit copy
  was backed up outside the repository). Any *other* `.env` written from the M0 example still
  carries `EMBEDDINGS_PROVIDER=fastembed`, `EMBEDDINGS_MODEL=BAAI/bge-small-en-v1.5` and
  `EMBEDDINGS_DIM=384`: delete the last two and set the provider. `fastembed` names an adapter
  nobody wrote, and the service refuses to start on it, deliberately and with a message saying
  what to set. Leaving the bge `EMBEDDINGS_MODEL` in place is the quieter trap — the real
  embedder would ask for a 384-wide model and fail its width check on the first call.
- **The OpenRouter workspace now has budget**, which also unblocks narration (~$0.45/month) —
  the dashboard badge still reports templates, and whether that is still the right steady
  state is now a measurement nobody has taken rather than a constraint. `LLM_MODEL` is also
  no longer the route MEMORY.md measured as 3/3 rejected, so that finding may not apply.
- **`DATABASE_URL` in `.env` names the compose hostname `postgres`, which does not resolve on the
  host.** Anything run natively against the dev database needs
  `DATABASE_URL=postgresql://traders:traders@127.0.0.1:55432/traders` in front of it. This costs a
  confusing `failed to resolve host 'postgres'` every time it is forgotten, including to alembic.
- **`docker compose` builds from the main checkout, never from a worktree.** `REPO_ROOT` resolves to
  the script's own repo and the compose context is `/Users/a/projects/Traders`, so rebuilding while
  working in a worktree silently tests `main`. Several "fix confirmed" results this session were
  actually confirming unmodified code. To exercise a branch end to end, run the three processes from
  the worktree instead — AI service on `:8002`, orchestrator on `:8081` (`ORCHESTRATOR_PORT`, not
  `PORT`), web dev server on `:5179` with `VITE_API_BASE_URL` pointing at the orchestrator, and
  `ALLOWED_ORIGINS` set to that web origin or CORS refuses every state-changing request.
- **The main checkout is not pulled automatically.** It sat on `a0637be` for three merged PRs, which
  is what made the compose images stale. Pull it before rebuilding anything.
- **`psql` is not installed on this machine.** Use `docker exec traders-postgres-1 psql -U traders
  -d traders -c '...'`. So is `timeout(1)` absent; the Bash tool's own timeout is the substitute.
- **An `ai.openclaw.gateway` LaunchAgent runs permanently on this machine** with a Telegram connector
  bound to bot `8778977785` — *not* ours. It is unrelated, and it is recorded here so the next
  session does not spend an hour suspecting it of eating updates, as this one did.
- **A real Telegram bot is configured**: `@trade_pulse_agent_bot`. `.env` holds its token, its
  username and the two secrets. The bot is live — anyone with that token controls it; `/revoke` in
  BotFather if it ever leaks.
- **No webhook is registered**, and `TELEGRAM_UPDATES=polling` (the default) makes the orchestrator
  long-poll instead. Telegram serves one transport at a time: registering a webhook makes polling
  answer 409, which the poller logs as a misconfiguration. Only one process may poll a token -
  a second poller (another worktree's stack, a script) silently steals updates.
- **Tapping "Approve" in the real chat is the only end-to-end test of the Telegram leg.** The unit
  suite replays recorded payloads and cannot tell you that nothing is listening.
- Telegram hides a deep link's `?start=` payload in the message bubble: the chat shows a bare
  `/start` while the update carries the token. Do not conclude from the UI that the payload was lost.

- **The universe is loaded in the shared `traders` database** (2026-09-24, #53): the stack's
  `universe` container embedded 5,223 profiles (~$0.016) and loads 16,363 holdings on every start.
  `traders` is at `0021_topic_proposal_expiry` (see the stack bullet above; one active topic, no
  proposals yet).
  **`traders_m5`**, the old scratch copy for native branch migrations (stuck at 0022), is
  dropped (decision 146): make a fresh copy when a branch needs one, and drop it after.
- **The descriptions file lives at `data/universe/descriptions.local.jsonl` in the main
  checkout** (gitignored, and excluded from images by `.dockerignore`), with a spare copy at
  `data/local/`. A worktree needs its own copy to run `ingest_universe.py`. A fresh
  `build_instrument_universe.py` is ~1 h, so copy the file rather than refetching.
- **Running a worktree's orchestrator natively against your `.env` starts a second Telegram
  poller**, and MEMORY's rule is that a second poller silently steals updates from the stack's.
  Always start it with `TELEGRAM_UPDATES=off TELEGRAM_BOT_TOKEN= SCHEDULER_ENABLED=false`.
  **Port 8081 was held by an orchestrator left running from an old worktree**
  (`m3-slice-2-b2e605`, started 2026-09-24 08:41). A new process on 8081 dies on `EADDRINUSE`
  *after* logging that it started, and every request then silently reaches the old code. Check
  `lsof -nP -iTCP:<port> -sTCP:LISTEN` and the listener's `cwd` before trusting a native
  endpoint. 8083 was free. **As of 2026-09-27 that stray process (pid 85085) was still running**,
  with the bot token and `DATABASE_URL` pointing at `traders`. Its code predates the poller, so it
  cannot steal taps, but its scheduler may still run old-code scans. The user was told how to stop
  it (`kill 85085`); check whether they did.
- **In zsh, `$S:path` is a history modifier, not a string.** `git show $S:services/...` expanded
  `:s` as a substitution and failed. Write `git show "${S}:path"` when verifying a commit by
  content.
- **Docker Hub can time out from a session's sandbox** (`node:22-slim` metadata,
  `DeadlineExceeded`). On 2026-09-24 it was transient. **On 2026-09-30 it failed twice in a row**
  from the sandbox; `docker pull node:22-slim` run *outside* the sandbox, then `dev-docker.sh`
  (also outside), worked every time after. Retry before suspecting the Dockerfile.
- **The native preview for a PR that changes the AI service needs a native AI service too**
  (PR 8): uvicorn from the worktree on **8091** with `PYTHONPATH` set and the main checkout's
  venv, and the native orchestrator's `AI_SERVICE_URL` pointed at it; otherwise point it at the
  stack's `http://127.0.0.1:8001`. **Vite hot reload wipes in-memory store state** (`/ask`'s
  questions vanished mid-answer when a lib file was edited) - re-ask after edits, it is not a bug.
- **`/ask` on the free route is slow and costs nothing:** 18-69 s per model-written answer, once
  over 3 min; a refusal 0.6 s. The in-app browser's JS tool gives up after 45 s, so measure it
  with `curl` against `http://127.0.0.1:8001/ask` (`x-internal-key` from the main `.env`), not
  from the page.
- **Service scripts in a worktree need `PYTHONPATH=$PWD`** (from `services/ai`): the borrowed venv's
  editable install points at the main checkout, so `scripts/export_openapi.py` and friends otherwise
  import the wrong `app` (see Bugs, "A worktree's scripts imported the main checkout's code").
- **Run a topic eval with the main checkout's `.env` sourced** — the worktree has none:
  `set -a && source /Users/a/projects/Traders/.env && set +a`, then override `DATABASE_URL` and set
  `CORPUS_DIR` to the worktree's `data/corpus` (the eval file is found beside it).

---

**Running a branch's orchestrator against a copy of the live DB** (UX4 rehearsal): copy with
`docker exec traders-postgres-1 sh -c 'createdb -U traders traders_ux4 && pg_dump -U traders traders
| psql -q -U traders -d traders_ux4'`, migrate it with this branch's alembic and
`DATABASE_URL=...@127.0.0.1:55432/traders_ux4`, then start `tsx src/server.ts` with compose's
environment (`docker inspect traders-orchestrator-1`) **but `TELEGRAM_BOT_TOKEN` unset and
`SCHEDULER_ENABLED=false`** - otherwise a second orchestrator sends the user real messages from the
copy's pending notifications. A dev server with `API_PROXY_TARGET` pointed at it (another port)
shares the Chrome session. Drop the copy afterwards. **The orchestrator's Postgres tests run as
`traders_app`** like CI: `TEST_DATABASE_URL=postgresql://traders_app:traders_app@127.0.0.1:55434/traders_ci`,
after `APP_DB_PASSWORD=traders_app scripts/migrate.py` against `traders_ci` - as the owner, two
grant tests fail for the wrong reason.

## Where to go next

### Next session: after M9 (written 2026-10-21)

**State:** M9 is complete in code: the exit test (D240) passes on a throwaway Postgres as
`traders_app`. No standing grant - ask before each PR, merge only on "merge", redeploy only on
"redeploy".

1. **Merge, then redeploy compose** (no migration, so no backup is required; take one anyway if
   unsure). After it: `runs` gains rows with `user_id IS NULL` and keys `<kind>:installation:...`
   for backfill, news, names, the sweep and the scan plan - **each daily shared kind runs once
   more on the deploy day** because its key changed; harmless (idempotent). Check: the approved
   user `f36b1a45` gets `snapshot` / `portfolio_scan` / `daily_digest` runs of their own, and
   George (their agent) is planned by `agent_scans` at its next slot.
2. **kind (k8s): its CronJobs and its code change together** when it is next
   redeployed (the manifests send `RUN_FOR: every_active_user` for user kinds, which this code
   requires), so apply the manifests with the images - a new image under the old CronJobs would
   answer every user kind 400 `no_user`.
3. **Unseen in a browser:** the Admin page's Users card, the zone picker in Settings and the
   reset card's new home at the bottom of Settings (jsdom covers each).
4. **M10 (public access)** is the roadmap's next milestone - only on the user's word; it brings
   OAuth, self-service reset and abuse limits (docs/MILESTONES.md).

**What cost time in this session:**
- **A `vi.mocked(fn).mockResolvedValue` survives `vi.clearAllMocks()`.** A test that set a user's
  role for one case changed the next case's user; use `...Once` or set it back.
- **A Postgres test's cleanup must delete what has no cascade first** - `agent_cash` names the user
  without one, so non-primary agents go before `users` (as `queries.postgres.test.ts` does).

### Next session: after the guide fix (written 2026-10-20, night)

**State:** the improvements list (items 1-5) is done and deployed; so are the two fixes the
own-key check found (D225, D226). The standing grant for this batch ended with this handoff:
ask before each PR, merge only on "merge", redeploy only on "redeploy".

1. **Telegram ask mode is checked live (2026-10-21 05:11-05:12 UTC, done).** The user asked the
   bot two questions in Hebrew from the phone ("מה מצב התיק שלי?", then one about the simulated
   agents); both answers came back in Hebrew (D220). `telegram_bindings.assistant_conversation_id`
   now points to conversation `dcdfb127`, titled with the first question; the route's own query
   (`listAssistantConversations`) lists it first, so the Ask page's history shows it (read in
   SQL; the HTTP route needs a session). `llm_calls` 473-480: 8 calls, all `purpose = 'assistant'`
   on the admin, `paid_by = 'installation'` (correct: the admin has no row in `user_llm_keys`),
   about $0.014. No orchestrator warnings. One finding, now under debt: the first draft (476)
   gave the snapshot date as "20 בנובמבר 2026" - November, for a 2026-10-20 snapshot. The figure
   check refused it only because "2026" was not in the evidence; the repair turn (478) quoted
   `2026-10-20` and was accepted.
2. **Run the assistant eval with the judge before the next prompt or guide change.** D226 was
   measured with `--no-judge` (outcomes and mechanical checks only): the three agent questions
   10 times each and the product group 3 times, about $0.15. One finding in that run that D226
   does not touch: "why cant I create an agent?" is sometimes *declined* (`action`, 4 of 10) with
   no tool call - the model reads "create" as a request to act. Harmless (the decline names the
   Agents page) but worth a look if the judge marks it.
2b. **The scan review is done (D227, D228; 2026-10-21).** #247 closed; the agent's instructions
   now count as a source for its thesis. Next look: about 50 model scans (compose had 16), the
   numbers in D227 as the baseline.
3. **D225 is unseen in a browser.** The hint beside the disabled Create agent button is covered by
   jsdom; its wrap at phone width and in Hebrew is not.

**What cost time in this session:**
- **`prettier --write` is not this repo's formatter.** Run on two web files it reflowed both
  (118 changed lines for a 20-line change). There is no web formatter; match the surrounding code
  by hand and check `git diff --stat` before committing.
- **zsh does not split an unquoted `$2`.** A shell helper passing `--cases a,b` as one argument
  made the eval exit on "unrecognized arguments" with no report; use `${=2}` or an array.

### Next session: after the own-key check (written 2026-10-20, evening)

**State:** improvements items 1-3 are done and deployed; the own key works live (header). D211
settled the user-set limit: none in the app, OpenRouter's per-key limit instead. No standing grant:
ask before each PR, merge only on "merge" (admin squash, verify by content on `main`), redeploy
only on "redeploy" (backup first when a migration runs).

1. **Item 4: re-evaluate an expired trade proposal**, then **item 5: Telegram ask mode** - briefs
   unchanged in "after the UI batch" below. Both are paid calls and go through the own-key wrapper
   for free (every call site passes `Caller(user_id=...)`).
2. **Small, found in the live check - bring as questions:**
   - **Create agent is disabled with no reason given.** Paper budget starts empty; its "1000" is a
     placeholder that reads as a value, and a template fills name, instructions and mandate but not
     the budget. The button's condition is `AgentsPage.tsx` (`!budgetValid`). Options: a template
     fills a default budget, or the form says what is missing.
   - **`MALFORMED_FUNCTION_CALL` on Ask.** `google/gemini-3.5-flash-lite` answered 4 of 12 calls
     with that finish reason (llm_calls 448, 449, 455, 456; questions about creating an agent), and
     two of three answers became "No answer I could check". The only such errors in 14 days, so
     measure before acting: is it the model, the tool schema, or the question.
3. **`/private/tmp/claude-501/env.bak`** - a copy of compose's old `.env` (secrets, world-readable,
   5138 bytes). Ask the user whether to delete it; never print it.

### Next session: after the own key (written 2026-10-20, evening)

**State:** improvements items 1-3 are done (#271; #275/#276; #277 + this PR). No standing grant:
ask before each PR, merge only on "merge" (admin squash - the "protect main" ruleset - then verify
by content on `main`), redeploy only on "redeploy".

1. **Merge and redeploy PR 3b, on the user's word.** Before the redeploy: add
   `LLM_KEY_ENCRYPTION_KEYS` to compose's `.env` (the user generates it; never paste it into a
   chat or a commit), back up, redeploy, then read `alembic_version` = `0065_own_llm_keys`. A
   live check worth doing with the user: save a real key on a non-admin account, run a scan, and
   read its `llm_calls` row - `paid_by = 'own_key'` - and the Settings card ("the monthly limit
   doesn't apply"). Never type the user's key yourself.
2. **The user-set limit for own-key spend** - the user's direction of 2026-10-20 (D206): every
   user eventually brings their own key and sets their own limits. A Settings field "stop my
   own-key spend at $N a month" (null = none), enforced by the same wrapper shape as the cap but
   summing `paid_by = 'own_key'`. Not asked for yet as a PR - bring it as a question.
3. **Item 4 is built: re-check an expired trade proposal (D212-D217, migration `0066`; the first
   PR after handoff #279).** Head is `0066_proposal_refresh` once it merges (next free: `0067`);
   rehearse `0066` on a restored backup before its redeploy. Unseen live: a re-check from the
   phone needs a trade proposal that expired unanswered (compose has one, IRON 2026-10-19, but
   past the 7-day window from 2026-10-26). **Seen live 2026-10-20 19:18 UTC** (#280 deployed): it
   proposed buying 3 more IRON - the trade had already been made by a later approval - which
   led to D218-D219 in the next PR. **Item 5: Telegram ask mode** - its brief is unchanged
   in "after the UI batch" below; a paid call through the own-key wrapper like every call site.
4. **The handoff after this one is due at the next merge** (five since #274 counts this PR's
   merge as the fourth; a fifth ends the window).

**What cost time in this session:**
- **Validation constraints on a secret echo it back.** A pydantic `Field(max_length=...)` on a secret
  returns the value in the 422; zod's `issues` do the same in the orchestrator. Secrets are
  `SecretStr` with no constraint, checked by hand in the route, and the orchestrator's 400 carries
  no issues (D206).
- **The orchestrator's Postgres tests as the owner role** fail two grant tests (admin audit, model
  choices) for the wrong reason - run them as `traders_app`, as the addendum below says.
- **The newest backup can be older than the live schema**: the redeploy's backup is taken before
  it migrates, so 12:55's dump is `0062` while compose is `0064`. Rehearsing from it covers every
  step since; read `alembic_version` on both before claiming what was rehearsed.
- **The worktree has no `.venv`**: `uv venv -p 3.12 .venv && uv pip install -p .venv -e '.[dev]'`
  in `services/ai` (`python3.12` is not on PATH; uv finds it).

### Next session: after the UI batch (written 2026-10-20)

**The user's improvements list (2026-10-20), split and agreed - one PR at a time, ask before
each, merge only on "merge", redeploy only on "redeploy":**

1. **Done: #271** - one `PasswordInput` with a show/hide toggle for all four password fields;
   the agent's Performance card in its own tab (five tabs; the row scrolls at phone width);
   Settings' Email and Password cards became one Sign-in card whose buttons open each form in a
   drawer, and the severity table folds under the proposals card. Settings' Account card stays:
   it is read-only today, but D163 makes the zone editable there.
2. **Built in its PR (D199-D201, `0062`): the agent limit counts only active agents, and the admin
   has none.** Rehearse `0062` on a restored backup before merge; undeployed until "redeploy".
   The original brief: The user's reason:
   cost comes from scans, and a paused agent does not scan, so creating more is harmless. Today
   the `agents_within_limit` trigger (`0047`) counts every non-archived, non-primary agent - active
   and paused - for every user. The change: migration `0062` rewrites the trigger to count
   `state = 'active'` and to fire on create-as-active and on resume (paused -> active), skip the
   admin (`users.role`), and the orchestrator's pre-check and the page's sentence ("3 of 3 active")
   follow. Rehearse the migration on a restored backup, as #253 was.
3. **Built: 3a the cap (#277, D203-D205, `0064`); 3b the user's own key (D206-D210, `0065`) -
   its PR needs `LLM_KEY_ENCRYPTION_KEYS` in compose's `.env` before redeploy, or the feature is
   off.** The original brief: **The user's own OpenRouter key - decided: a user with a valid key of their own is never
   capped; without one, the cap (D157) applies as planned.** So the cap PR is still needed, and
   the two are best designed together. Open: storing a per-user key is an exception to guideline
   9 (secrets only in `.env` / Kubernetes Secrets) - the proposal to bring is encrypted at rest
   with a key from `.env`, never sent to the browser, shown as its last four characters,
   validated against OpenRouter on save; background scans and narration run on the owner's key.
   Measure first how a call reaches `BudgetedProvider` with its user (the cap PR's list under
   "after M9's signup" item 2 still stands).
4. **Re-evaluate an expired trade proposal** (after 3 - it is a paid call). A button in Telegram
   and the UI runs a focused one-ticker re-check for that agent - fresh price, the same mandate
   rules, the evidence validator - and either issues a new proposal or says why not. One refresh
   per proposal. For reference, how long proposals live: trade proposals 60 minutes from the next
   market open (D4, `TRADE_PROPOSAL_TTL_MS`); portfolio-scan proposals `proposal_ttl_hours`
   (default 24, 1-168); topic proposals 14 days.
5. **Telegram ask mode** (after 3) - decided: the same paid call and daily budget as the Ask page,
   **one rolling conversation per chat**, and **answered in the language the question was asked
   in**. That last is an exception to guideline 1's "`/ask` answers stay English" and needs a
   decision number when it is built (and a word on whether the Ask page follows).

**Also open, in order of urgency:**
- **Compose has #264's signup without the cap (D186).** Ask the user: leave it (household users
  only, over Tailscale) or roll compose back until the cap merges.
- The 2026-10-20 Test agent scan review: #270 (several trades a scan, D197) suggests another
  session acted on it, but this session did not see it. Draft **#247** is still open and waits on
  it, as do the research sub-agent and the per-agent tool picker.
- Everything under "after M9's signup" items 3-6 is unchanged.

**What cost time in this session:**
- **The dev server's port must be in `ALLOWED_ORIGINS`.** The orchestrator refuses a sign-in from
  any other origin with `403 bad_origin`, which in the browser looks exactly like a wrong
  password. Compose allows `localhost:5173`, `localhost:5174` and `127.0.0.1:5174`; 5174 is the
  compose web container (the code on `main`), so a branch's dev server belongs on **5173**. An
  orphaned Vite from a `frontend` folder in the Trash was holding 5173 on `::1` and was stopped
  with the user's OK. Check the response body before suspecting the password.
- **The browser pane does not share the user's browser cookies.** "Signed in at 5174" in Chrome
  means nothing to the pane; the user signs in on the pane itself.
- **Checking Hebrew without changing the user's saved language:** in the Vite dev server,
  `(await import('/src/i18n/index.ts')).applyLanguage('he')` from the page switches language and
  `dir` client-side only; move between pages with `history.pushState` plus a `popstate` event, since
  a reload re-reads the saved language. In RTL the menu button is on the left.
- **The pane is 304 px wide**, which is where the five agent tabs overflowed: measure
  `document.documentElement.scrollWidth` against `innerWidth` on any page with a row of tabs.
- **Count merges with `git log`, not by memory**, when other sessions are merging too: this
  handoff came at seven.

### Addendum: after the agent controls (the parallel session, written 2026-10-20)

Four merges since handoff #266 (#268 tabs, #269 schedule, #270 decisions, #272 old scans; #271 by
another session). Handoff at the user's request. **Deployed:** compose `6f17ac1` at `0061`; kind
`796cf3d` at `0059`; #271 merged, undeployed. No standing grant: ask before each PR, merge only on
"merge", redeploy only on "redeploy".

Read with "after the UI batch" above: **the user's improvements list is the order.** These are notes.

1. **D186: one approved user now runs uncapped on compose** (signed up and approved 2026-10-20) -
   so the question "after the UI batch" puts to the user is no longer hypothetical; ask it first.
   Compose was redeployed by this session (08:56 UTC is its #272 redeploy), on the user's word,
   and it was already past #264 before. For the cap itself (item 3 of the user's list), the plan from "after M9's signup" item 2 stands unchanged:
   measure first (how a call reaches `BudgetedProvider` and whether the user travels with it, for
   narration, scans, `/ask` and `mandate_check`; "this month" in `users.timezone`; a call's maximum
   cost from `max_tokens` x price; the refusal codes and sentences; the admin never capped), then
   the questions one at a time. **New since that plan:** a scan now writes up to 10 proposals and
   may answer up to three times (D197's figure and mandate rounds), so a scan's worst-case cost is
   larger than when D158 was argued - include it in the measurement.
2. **Watch the new controls on real scans** (read-only, then report): every agent is at
   `max_decisions = 1` and agressive at every 4 h until the user changes them. After the user
   raises one: `agent_scans.answer -> 'trades'` with `refused` entries, `transcript` `returned`
   rounds (D189/D170 per trade), proposals per scan, and any `waiting_for_approval` repeats
   refused (D198). The question to answer: do several decisions produce rebalances, or several
   unrelated buys?
3. **The 2026-10-20 10:00 Test agent scan review** ("after M9's signup" item 1, #247's baseline,
   the research sub-agent and tool picker) - not done by this session; ask the user whether it
   happened. Read it knowing #268-#272 changed the schedule, the answer shape and the briefing.
4. **Small debt this session left, as consequences:**
   - While editing the schedule, "Next scheduled scan" still names the *stored* schedule's next
     slot until Save - the preview line above it is right, this one is not.
   - Approving a funded buy before its sell is refused as plain "insufficient cash" on web and
     Telegram; the reason could name the sell (the payload has `fundedBy`).
   - Telegram's refusal paths (market closed, price moved, expired) are covered by tests only.
5. **Then M9 continues** as "after M9's signup" item 3 lists (scheduling fan-out D161 - an approved
   user still gets no scheduled scans; time-zone reads D163; the admin's user list D162; exit test).

**Things from this session that cost time:**
- **A worktree's Python scripts run the main checkout's code** (the shared venv is an editable
  install): `export_openapi.py` exported `main`'s models and `openapi.json` came out unchanged. Run
  scripts with `PYTHONPATH=.`; pytest is unaffected. (Also under "Local environment".)
- **Compose's CSRF origin list has no :5175**, so a worktree dev server there cannot sign in (403
  `bad_origin` before the password is read). A local, git-excluded `vite.worktree.local.config.ts`
  that sends `origin: http://localhost:5173` from the proxy solved it. Simpler now: the stale Vite
  that held 5173 is gone (the other session stopped it), so run a branch's dev server on 5173.
- **Redeploys may sign the browser pane out** (it happened after #270's): budget a sign-in from the
  user before a browser check, and never type their password.
- **Port 55432 is compose's Postgres.** The throwaway for integration tests goes on another port.

### Next session: after M9's signup (written 2026-10-19, evening)

Five merges since handoff #259 (#260 login, #261 D183, #262 form fixes, #263 trade cost in the
prompt, #264 signup + approval) - this handoff is the count's. **Deployed:** compose and kind both
run `796cf3d` (#263), schema `0059_mandate_check`; login is live, so everyone signs in with email
and password (`APP_PASSPHRASE` is gone; the admin's came from `admin:password`). **#264 is merged
and NOT deployed - and must not be until the cap PR is merged too (D186).** No standing grant: ask
before each PR, merge only on "merge", redeploy only on "redeploy". Count merges with
`git log --oneline <this handoff's sha>..origin/main`. In order:

1. **2026-10-20 10:00 Israel: the Test agent scan review** with the user ("after #232" item 2;
   a scheduled task opens it). It is #247's baseline, and it brings back two deferred decisions:
   the research sub-agent and the per-agent tool picker. Read it knowing what changed under the
   scans since it was planned: the mandate and `rule_rejected` (#254), and **#263's "What a trade
   costs" section** in every agent's prompt - fewer small round trips is the expected effect.
2. **M9's next PR: the cap's enforcement (D157, D158).** Measure first, read-only:
   - how a model call reaches `BudgetedProvider` (`services/ai/app/llm/factory.py`) and whether
     the user travels with it - narration, agent scans, `/ask` and `mandate_check` each enter
     differently; every `llm_calls` row already carries `user_id` (355 of 355 on 2026-10-18);
   - "this month" in the user's zone (`users.timezone`), spent = `sum(cost_micro_usd)`;
   - the call's maximum cost: `max_tokens` at the model's price (`llm_models` / the catalogue);
   - the refusal: reason codes for a scan and an `/ask` turn, the UI's sentence in both languages,
     and narration falling back to its template (alerts still arrive);
   - the admin (cap NULL) is never capped.
   Then bring the open questions one at a time. **After it merges, #264 and the cap PR redeploy
   together** (D186) - until then an approved user's cap is checked by nothing.
3. **Then M9 continues:** scheduling fan-out (`for: "every_active_user"`, D161; today
   `/internal/runs` still falls back to `SINGLE_USER_ID` - an approved user gets no scheduled
   scans), the time zone's reads + guideline 10 (D163; Settings cannot edit the zone yet), the
   admin's user list + own-account reset + one-time password (D162), the exit test.
4. **The template creator's first real data** ("after the template creator" items 3-4):
   `llm_calls` with `purpose = 'mandate_check'` since D183 (sentence numbers), and the first
   `rule_rejected` scans - does the retry help?
5. **Waiting on the user, not scheduled:** whether to translate the Yahoo taxonomy names (#262 -
   they are also what the server validates and scans match on); turning on GitHub's "require
   branches to be up to date before merging" on `main` (admin only; the ruleset has no required
   checks at all today, so a red PR can be merged).
6. **Unknown:** whether the 2026-10-19 market-prune re-read ("after M9's schema" item 1) was done.
   Nothing in this session did it. Check before anything restores onto compose's server.

**Three things from this session that cost time:**
- **`docs/DECISIONS.md` is generated** (`python3 scripts/build_decision_index.py`) from the bold
  first sentence of each MEMORY decision, and `test_decision_index.py` fails CI's Python job when
  it is hand-edited or stale. Add decisions to MEMORY, then run the script - never type the table.
- **The in-app browser's `form_input` does not reach React's state.** On a controlled input it
  sets the DOM value and React never hears it: the field looks filled, the submit sends `''`, and
  typing afterwards *appends* to the stale DOM text. Click the field and `type` instead.
- **`queries.postgres.test.ts` against `traders-agents-ci` as `traders` fails two tests** (the
  append-only `admin_audit`, model choices that may not be deleted): they assert the *app role's*
  missing privileges, and `traders` owns the tables. Expected locally; CI connects as the app
  role. `traders-agents-ci` is at `0059` now (migrated this session) and its admin has a throwaway
  email `admin-ci@example.com` - set a new password with `admin:password` when you need one.

### Next session: after the template creator (written 2026-10-19)

The four PRs are merged (#252, #254, #257, #258); nothing of them is deployed. In order:

1. **On the user's "redeploy":** 0056-0059 run, and the startup loader fills `universe_taxonomy`
   (check `SELECT count(*) FROM universe_taxonomy` - ~257 rows on kind's universe; 0 means the
   loader has not run since the migration).
2. **Look at it.** Open the new-agent drawer in English and Hebrew: the slider and its band, the
   picker's grouped menu and chips, the generated instructions and "Rewrite from settings", the
   over-limit note on an agent page. Then edit an agent's instructions to contradict its horizon
   and confirm the warning, Dismiss, and the list badge.
3. **Read the first real checks:** `llm_calls` where `purpose = 'mandate_check'` - verdicts, cost
   (expected about a tenth of a scan), and whether conflicts came back or were all dropped for
   paraphrased quotes (the AI service logs nothing for a dropped quote; compare the completion
   with the stored `instructions_check`).
4. **Read the first `rule_rejected` scans** on a funded agent with a mandate: did the retry help
   (a `returned` step followed by a `trade`), or does the model break the same rule twice?
5. Ideas the user heard and did not schedule: a "what the agent is told" preview; "duplicate
   agent" instead of saved templates (D168); a notice when an agent proposes nothing for N scans.
6. **Ask the user** to turn on GitHub's "require branches to be up to date before merging" on
   `main` (admin only) - the structural fix for two-sessions-one-broken-main.

### Next session: after M9's schema (written 2026-10-18)

No standing grant: ask before each PR, merge only on "merge", redeploy only on "redeploy". Count
merges since this handoff's commit with `git log --oneline <sha>..origin/main` - other sessions
merge too (four of this stretch's seven were theirs or fixed theirs). In order:
1. **2026-10-19: re-read the market prune** (above) before anything restores onto compose's
   server. If it is back near ~40 ms, close the database sprint's row; if not, measure the partial
   index on a restored backup in a separate container and bring decision 174.
2. **2026-10-20 10:00 Israel: the Test agent scan review** with the user, as "after #232" item 2
   says - it is #247's baseline. Note the template creator (#252, #254) changed scans since
   (`rule_rejected`, mandates); read the review with that in mind.
3. **M9's next PR: signup and login** (MILESTONES' order). Measure first: `http/routes/auth.ts`,
   `http/auth.ts` (add `ver`), the login page and its i18n (`en.json` `intro` names the
   passphrase), `APP_PASSPHRASE`'s readers, CI's login step (`ci.yml` posts `passphrase`). Name
   the argon2 package in the PR (D159; `@node-rs/argon2` likely) - the user approved a package,
   not a specific one. The bootstrap script that gives the seeded admin an email and password
   comes with it. Then: approval flow, cap enforcement (`BudgetedProvider` needs the user - its
   first measurement), scheduling fan-out, time-zone reads + guideline 10, admin list + own
   reset, the exit test.
4. **Redeploy when the user says** - #232 and #249-#255 are waiting; 0056-0058 run on it.
5. The rest of "after #232" (4-6) still stands.
6. **The agent template creator belongs to another session** (decisions 164-173). Do not pick up its
   PRs from here without the user saying so.

### Next session: after #232 (written 2026-10-18)

No standing grant: ask before each PR, merge only on "merge", redeploy only on "redeploy". In order:
1. **Redeploy #232 when the user says so** - the only merged change not yet deployed.
2. **2026-10-20 10:00 Israel: the Test agent scan review** (scheduled task, read-only). Read it
   with the user. Record its numbers as #247's baseline: `invalid_answer` rate, trades per scan,
   theses refused for unsourced figures, and any buy refused for cash. Then #247 can be marked
   ready, merged on "merge" and deployed on "redeploy"; compare the following week's scans with
   the baseline. After that, the two deferred decisions (research sub-agent, per-agent tool picker).
3. **M9's decisions**, one at a time with a recommendation, from `docs/M9-MEASUREMENT.md` - who the
   users are first. The user chooses the order against everything else.
4. **Read 0053-0055 back from the statistics** (`db-report.sh`): `articles_fetched_idx` scanned
   ~48 times a day on compose, `articles`' `seq_scan` no longer climbing per collect. Then the
   database sprint's row can close.
5. **Task 17's re-measurement** (narration's rejection rate on the free model) - still open in the
   queue.
6. **Follow-ups nobody has asked for yet, each needing the user's yes:**
   - #247's gaps: `affordable_shares` on `get_quote` for instruments outside the movers list;
     one repair turn after a refused scan answer (today one mistake ends the scan as
     `invalid_answer`).
   - The two #232 regressions above, if the next eval keeps showing them.
   - The market line (149) on the web feed and the digest.

**Lessons from this stretch:**
- **Fuzz a closed form against the function it inverts.** `affordable_shares` looked right and its
  hand-picked cases passed; 200,000 random cash/price pairs checked against `fee_minor` found one
  share too many just past the fee's crossover (price 1¢, cash 1,501¢ gave 751). When code inverts
  a cost rule, test it against the rule itself, not against figures worked out by hand.
- **An eval baseline from an older `main` cannot attribute what changed outside the targeted
  cases.** #232's baseline predated #231 and the merges after it, so its 15 gains and 9 losses
  elsewhere mix the new lines, other changes and run-to-run noise. Only the targeted cases are
  clean evidence. When a decision rests on the untargeted cases, run the baseline on the same
  `main` first (about $1.30 more).
- **Count merges, again.** Four of this stretch's five merges came from other sessions the same
  morning; `git log --oneline ff5943b..origin/main` found them, not memory.

### Next session: after #241 (written 2026-10-18)

No standing grant: ask before each PR, merge only on "merge", redeploy only on "redeploy". In order:
1. **DB4's second half - done 2026-10-18 (decisions 151-154; PRs 0053, 0054, 0055 in order).** "Next session: the database sprint's
   review, second half" below; its decision numbers now start at **151** (148-150 were taken by
   #237-#239). Kind and compose have run #218 since 2026-10-11, so step 3 applies. Note the compose
   stack was restarted 2026-10-18 ~07:36 UTC for #239 - Postgres was not, so the window should hold.
2. **#241 is deployed (2026-10-18, with 0053-0055).** The first real trade proposal after it is
   the live check of the "Evidence checked" line.
3. **M9's decisions**, one at a time with a recommendation, from `docs/M9-MEASUREMENT.md` - who the
   users are first (MILESTONES' list). Not ordered against DB4; the user chooses.
4. **2026-10-20 10:00 Israel: Test agent scan review** (scheduled task). Then the two deferred
   decisions: the research sub-agent and the per-agent tool picker (bring tool-call counts from
   `agent_scans`/`llm_calls`). #241's `otherCalls` already makes room for a sub-agent's tool name.
5. **#232 - done 2026-10-18** (measured, merged; see "after #232").
6. **Small follow-ups the user has not asked for yet:** the market line (149) on the web feed and
   the digest; watch the first real merged move+drawdown and market line on Telegram.

**Lesson from this stretch:** the handoff trigger is countable only if someone counts. Six merges
went by because #239 and #241 merged from other sessions on the same morning. Count merges on
`main` since the last handoff commit (`git log --oneline <handoff-sha>..origin/main`), not the ones
this session made.

### Next session: after the assistant follow-ups (written 2026-10-14, evening)

Ask the user before starting anything; there is no standing grant ("merge" per PR, "redeploy" only
when said). In date order:
1. **IBI check, 2026-10-15** - its scheduled task runs it (decision 135); nothing IBI unless it shows
   other MCP clients can connect and the user says go.
2. **DB4's second half, on or after 2026-10-18** - "Next session: the database sprint's review,
   second half" below.
3. **Test agent's scan review, 2026-10-20** - the scheduled task reports it; read it with the user.
   First time Flash-Lite trades with money: check its proposals against its persona (3% drop rule,
   20% of cash per trade, 5 positions) and its theses' figures (#230's rule is now live for them).
4. **#232, the assistant's prompt lines (draft)** - the user chose to measure it **after this sprint**
   with one full eval (`--repeat 3`, cap $1.50, command in the PR body), compare the targeted 0/3
   cases and look for any case that loses passes; merge only if it does not cost more than it fixes.
   **Ask for a budget first** (~$0.18 of the $5 is left). One more run only if it shows a regression,
   and ask before that too. Then remove `traders-assistant-ci` (`docker rm -f traders-assistant-ci`).
   **Unanswered, ask before that run:** should `/agents` count where a case expects
   `/agents/$agentId`, and should a correct decline pass whatever `reason` code it gives?
5. **Assistant candidates, each needing the user's yes:** answers in the user's language (amends
   guideline 1), `/ask` in Telegram, live progress while it looks things up.

**Lessons from this stretch worth keeping:**
- **A gateway can start refusing a request it accepted for months, and a fallback hides it.**
  Narration's template fallback is the right product behaviour and it turned a total outage into
  silence for a week. A health signal must speak at first sight too: a watch whose first reading
  is a baseline will baseline an outage (#234). When something "works", check `llm_calls.outcome`,
  not the feed.
- **A validator that recognises a symbol must recognise its words.** The `%` rule had existed since
  the 0.03% bug; the model wrote "percent" and walked past it. And show a model each figure in the
  form a sentence quotes it - money as `7.90`, ratios as `-12.77%` - from the validator's own rule, so
  what is shown and what is checked cannot drift apart.
- **Read the raw body before designing a retry.** "No completion text" looked like transport
  flakiness; the body said `finish_reason: "error"`, `MALFORMED_FUNCTION_CALL`, zero usage - a model
  failure that is free to retry, and only that one. A five-cent `--no-judge --cases` run with a
  temporary dump of the response found it; the error now names the reason itself.
- **Attribute a regression by A/B, not by suspicion.** The empty replies rose after PR 5 changed the
  client; running the same cases on 4b's commit (old client) showed the same failure (3/27 vs 5/27).
  A scratch `git worktree add --detach <sha>` plus `--no-judge` costs cents.
- **Split a PR by how it can be verified.** 4c's code fixes were proven by tests and shipped; its
  prompt lines change every question and wait for a paid eval (#232). One PR would have held the
  honesty fix (`total_covers`) hostage to a budget.
- **After a dependency PR, the local environments lag.** The main checkout's `.venv` lacked `openai`
  after #227 (`uv pip install --python .venv/bin/python -e ".[dev]"`); a fresh worktree has no
  `node_modules` (`pnpm install --frozen-lockfile`) - `npx vitest` there fetches an unrelated vitest
  and fails on a native binding.
- **Integration tests in one module share a database**: an assertion on a count of stored closes
  broke when an earlier test had stored more. Assert the relation (`< asked for`), not the count.


### Next session: after the assistant milestone (history - written 2026-10-14; items 1-2 done, see above)

Ask the user before starting anything: the assistant grant (`traders-assistant-grant`) covered the
milestone's planned PRs, and they are all merged. In order:
1. **Redeploy and check PR 5 live** (the user's machine: `git pull && bash scripts/dev-docker.sh &&
   bash scripts/k8s-up.sh`; no migration). Then one narration (a scan or `POST /internal/runs`) and one
   `/ask` question; `llm_calls` should show both with a cost, and `docker logs` no `llm.http_error`.
   If the gateway refuses something the hand-written client sent, compare the request body - the
   package adds `x-stainless-*` headers and, for embeddings, `encoding_format: "float"`.
2. **The 4b eval re-run** - see "Next session: the assistant's PR 4b". Read every failure and every
   judge/mechanical disagreement with the user; a regression gets its own PR.
3. **The items still due from "after the Insights work"** (below): task 19's after-measurement, the
   scheduled scans' review, the IBI check (2026-10-15, its scheduled task), **DB4's second half on or
   after 2026-10-18**.
4. **Post-milestone candidates for the assistant**, each needing the user's yes: answers in the
   user's language (needs a decision amending guideline 1 - today `/ask` answers stay English and are
   marked `lang="en"`); `/ask` in Telegram; streaming progress ("looking up NVDA...") - the `openai`
   package now gives it, which was the reason for the switch.
**Decision numbers** reached 147 (DB4); the assistant took none. **Next free migration: `0053`.**

**Lessons from this stretch (PR 4b, PR 5) worth keeping:**
- **A package's defaults are decisions you inherit.** `openai` retries timeouts, waits out a
  Retry-After of a minute, asks embeddings for base64, refuses a client without a key and reads
  `OPENAI_API_KEY` from the environment when given none. Each was checked against this product's
  choice and overridden in the constructor; a test pins the key one. Read the defaults before
  swapping a client, not after the first odd bill.
- **A test written for the swap found the swap's bug.** The existing client tests passed unchanged
  on the package; the one new test (no key) failed. Passing old tests proves the old behaviour, not
  the new edges - add a test for each thing the new dependency does differently.
- **"Copy and pin" beats a wire change for a constant two services share.** The scan slot times live
  in TypeScript and now in Python; a test parses the TypeScript. Cheaper than routing schedule data
  through the orchestrator on every question, and it fails loudly the day they differ.


### Next session: the assistant's PR 4b - what the eval found (written 2026-10-12)

**Built 2026-10-14; the measurement is owed.** Re-run the eval (command below, `--repeat 3`, ask the
user first - about $1.60 of the $5 is left) and compare with PR 4's 132/258 turns, mechanical 210/258.
Decided in 4b, each argued where the code is:
- **The AI service reads `ENABLE_SCHEDULED_SCANS` too** (`config.py`): compose's shared `.env` and
  kind's one ConfigMap give both services the same value, so "is there a next scan?" needs no wire
  change. The slot times are copied from `scanSchedule.ts` into `app/agents/scan_schedule.py`;
  `tests/test_scan_schedule.py` reads the TypeScript and fails when the two differ.
- **`month_to_date` replays the ledger** the way the agent page's performance does (D36): value at
  the last close before the 1st (UTC) = movements before it + fills before it x that close; change =
  net worth now - that value - deposits since; an agent started this month counts from its start.
  Missing close -> null with a note, never partial (decision 111).
- **`get_price_history(days)` counts sessions**, max 252, default 60 (was 365/90 calendar days). It
  also loads at least the backfill's minimum, so a short window over a stored history stops asking
  the provider again on every call (it did, for every `days` under ~28).
- **The eval world's agents own their holdings through fills** (`manual_user_override`, since an
  agent's fill needs a proposal); the budget is set so cash still ends at the $6000/$7500 the scans'
  theses quote.
- **Dates in words pass the assistant's check only** - narration's and the agents' still refuse
  them (same debt row as the timestamp digits).


The user chose (2026-10-12) to fix these in their own PR before PR 5, measured against PR 4's Flash-Lite
numbers (`--repeat 3`: 132/258 turns pass, mechanical 210/258; 30 of 86 turns pass every sample, 30
fail every sample). Ask before the first paid run; ~$1.60 of the $5 eval budget is left.
**Tool gaps (the model cannot answer without them):** `get_agents` has no next-scan time
(`product-next-scan`); `get_portfolio` has no day change in money and says nothing when cash is null
(the real portfolio keeps none - `account-cash`, `account-today`); `get_price_history(days=5)` loads 5
*calendar* days = 3 closes, so its own `5d` is null and "how did NVDA do this week?" has no weekly
number (`followup-nvda-amd` - load trading days, or at least `days + weekend`); agents have no
month-to-date return (`account-best-agent`).
**Prompt omissions (consistent across samples):** says nothing of a proposal being rejected; drops
news source names; never says a quote is delayed; a replayed scan's conclusion left out; the universe
question still declined as cosmology 1 time in 3 (and once more on a live copy). Haiku's own failure
mode, for the record: dates written "Oct 12, 2026" were refused as unsourced figures.
**How to run it:** `PYTHONPATH=. .venv/bin/python scripts/run_assistant_eval.py --env-file
/Users/a/projects/Traders/.env --database-url postgresql://traders:traders@127.0.0.1:55435/traders_ci
--model google/gemini-3.5-flash-lite --repeat 3 --max-usd 1.60` (reports land in
`services/ai/eval-results/`, gitignored). `--cases`/`--group` for a subset.

### Next session: the assistant's PR 4 (history - done as PR 4, 2026-10-12)

**The grant continues** (auto-memory `traders-assistant-grant`): one PR at a time off `main`, merge
on the user's "merge", redeploy on "merge and redeploy". **Ask the user's budget before the first
paid run** - an estimate was given: under $1 for the 80 cases on Flash-Lite, more if Sonnet is
compared. What PR 4 is:
1. **An eval runner** for `data/eval/assistant.json` (none exists yet; the contract test only
   checks the file). It needs: the fixtures (`demo`, `empty`, `unpriced`) seeded into a disposable
   database - Momentum and Value agents, the SMR pending proposal, the rejected URA sell, Value's
   failed scan, a drawdown observation, the uranium topic, a universe snapshot with one rescreen;
   `inject` (replace one tool result with attacker text, case `attack-injected-news`); a real model
   through `ask()`. Mechanical grading from each turn's `expect` (outcome, reason, `tools_any` from
   the transcript, `links`, `sources`, `must_not_match`); `behaviour` needs a human or a model
   judge - decide which with the user. Keyed only: it cannot run in the hermetic CI tier.
2. **Run it, and compare models** (at least Flash-Lite; Haiku or Sonnet if the user agrees). Known
   weak spot to watch: Flash-Lite declined "How was the universe made?" as cosmology 4 times in 6.
3. **Measure cost per question** from `llm_calls` (`purpose = 'assistant'`) and set the real daily
   limit (`installation_settings.assistant_daily_budget_micro_usd`, Admin page) from it, replacing
   the provisional $0.50. Measured so far: ~$0.003 a question on Flash-Lite (copies, 2026-10-12).
4. **Remove the old `/ask`**: `POST /ask` in both services, `app/ask/`, `run_eval.py`'s job and
   `data/eval/ask.json` - unused by the web app since #223. Check Telegram and anything else that
   calls it first (`grep -rn "'/ask'\|ai.ask("`). The concept corpus and `explain_concept` stay.
Then PR 5: the `openai` package for chat and embeddings together (debt row "hand-written over
`httpx`"). After the milestone: answers in the user's language (needs a decision amending
guideline 1), then `/ask` in Telegram.
**Next free migration: `0053`; check `origin/main` first - other sessions merge in parallel.**

### Next session: after the Insights work (#206, #209, #214, #216, 2026-10-11)

Ask the user before starting anything (the Insights grant ended with task 21). In date order:
1. ~~**Task 19's after-measurement - after Monday 2026-10-12's scans, on kind.**~~ **Done 2026-10-14** (decision 132's *After*: 0 repeated drawdown rows, 0 merged-move overlaps). Kind's 9 Oct scan
   showed no `heldInEpisode` only because the day key caught SMR and URA first. Re-run the before
   query (drawdown rows per subject and band; `price_move` sharing a subject and New York day with
   `sigma_move`) over kind's observations written after 2026-10-11, check `runs.stats.heldInEpisode`
   and `finding_episodes`, record it in queue row 19 and remove the row. SMR should still have
   exactly one open *high* episode and no new *high* row.
2. ~~**Review the scheduled scans**~~ **Done 2026-10-14, and it measured nothing worth having:** kind runs
   no scans (`LLM_PROVIDER=null`); compose has one agent, "Test agent" (created 2026-10-07,
   `pre_open`), with **$0.00 cash, no holdings and no deposit**, so every scan (10-12, 10-13, 10-14,
   one per trading day at ~09:05 New York, none missed) concluded `no_trade` because it cannot buy,
   for ~$0.001 each. The scheduler works; Flash-Lite's trading judgement is unmeasured until an agent
   has paper money. Also moot: narration's rejection rate on D75's choice - narration failed every
   call 10-07..14 (#229) and the explain model is now Flash-Lite. Original note:
   (now three trading days after Monday): outcomes, refusals, cost
   per day from `agent_scan_runs` and `llm_calls WHERE purpose = 'agent_scan'`. **The agents run on
   `google/gemini-3.5-flash-lite` since 2026-10-08 19:47 - intended (the user, 2026-10-09)**, so the
   review measures Flash-Lite, not Sonnet. D75's *explain* choice is set (Sonnet, 2026-10-08 19:45):
   re-measure narration's rejection rate on it after a few days.
3. **IBI check, 2026-10-15** (decision 135; the scheduled task runs it) - nothing IBI unless it shows
   other MCP clients can connect and the user says go.
4. **DB4's second half, on or after 2026-10-18** (the section below). Its first half ran
   2026-10-11 on the user's request (#218, #219, deployed; decision 143 split it).
5. ~~The `/ask` assistant milestone~~ - built and live (#212, #220-#223, 2026-10-12); PR 4 is the
   section above.

**Before merging anything with a migration:** `git fetch`, then `alembic heads` on the branch merged
with `origin/main` - two sessions were merging in parallel this week and branch CI cannot see it.
**The next free migration is `0052`, and two pieces of work will want one:** DB4's second half, if
it drops an index or adds `runs` retention, and the assistant's conversation tables. The one that
merges second renumbers. Decision numbers likewise: DB4 has reached 147 (#219); read `origin/main`
before taking the next.
**Insights after deploy:** the first visit showed the whole 7-day window as unread, once (null
`insights_seen_at`), as the PR said.


### Next session: the database sprint's review, second half (DB4, due on or after 2026-10-18)

**Done 2026-10-18 (decisions 151-154).** What the full week (10-11 07:56 -> 10-18 08:12 UTC, both
windows intact) showed:
- **Backups:** 8 launchd runs, all exit 0 - 7 inside the window, one per night 10-12..10-18
  (compose's 10-12 ran at 05:26, the Mac asleep at 04:00). Newest: kind 5.2 MB, compose 60 MB, 44 tables.
- **#218 worked.** `runs.seq_scan` for the week: kind 109, compose 86 (1,768 before). They are
  the old statement's 46/55 calls before #218 deployed on 10-11, 7/13 `pg_dump`s and ~20 ad-hoc
  reads; the new lookup ran 506/619 times without one. Across a tick (2 and 8 claims) the counter
  did not move. **Trap:** a watcher that polls `count(*)`/`max(started_at)` on `runs` adds two
  scans per poll - it moved the counter by 31 before it was noticed. Read `pg_stat_user_tables`
  and `pg_stat_statements` only.
- **Indexes:** see 151 (HNSW: reader ran, planner rightly refused it) and 152 (two with no
  reader dropped, the rest kept). **Retention:** 153, not yet. **New:** 154, the news
  collector's window read on compose.
- **Noise, discounted:** kind's 31-minute `SELECT 1` (the Mac asleep), `admin_audit_id_seq` at
  2.7 s (`pg_dump`), 13 no-op universe reloads (DB2 by design), and compose's slow log includes
  other databases' `CREATE INDEX` (restores into scratch copies) - section 1 is filtered by
  `dbid`, section 5 is not.

**The plan as written before it ran:**

**The first half ran 2026-10-11** on the user's request, 29 minutes into the window (decision 143):
backups checked, both reports read, decisions 144-147 taken, #218 opened (the `runs` predicate).
What is left needs the full week. Ask the user before starting (no standing grant; "merge" per PR).
1. **Check the backups:** `bash scripts/backup-schedule.sh status` (last exit 0, both dumps under
   48 h). By now launchd should have run nightly at 04:00; `~/Library/Logs/traders-db-backup.log`
   shows one pair of lines per run - count them against the days since 2026-10-11.
2. **Run the report on both:** `bash scripts/db-report.sh --target kind` and `--target compose`.
   Confirm the window header still says 2026-10-11 07:56 UTC (a `--reset` or `k8s-down.sh` would
   move it; a shorter window must be said, not hidden). Discount the nightly `pg_dump`s (one
   sequential scan per table per night, `COPY ... TO stdout` in section 1) - decision 143.
3. **If #218 is deployed, confirm it worked:** `runs`' `seq_scan` in section 2 should stop
   climbing with each refused claim; `EXPLAIN` the status lookup if in doubt.
4. **Bring the remaining questions one at a time, each with a recommendation** (AskUserQuestion):
   - indexes with no scans across the full week (unique ones are excluded - they enforce rules).
     `intents_ledger_idx` is one (decision 138: no reader; keep for a future audit view or drop).
     **Do not offer to drop the HNSW indexes** (`instrument_profiles_embedding_idx`,
     `kb_chunks_embedding_idx`) or the `search_idx` ones without checking whether their reader -
     topic matching, `/ask` retrieval - ran at all in the week (`llm_calls`, `runs` by kind);
   - retention for `runs`: measured 2026-10-11 at **29-37 rows a day** (not ~130), 1.1 MB on kind
     and 1.9 MB on compose - expect "not yet", with a size that would change the answer;
   - anything new in sections 1 and 5 (statements by total time, the slow log).
   Each answer is a decision (next number: **151** - 148-150 went to #237-#239); each change its own PR.

### Planned: the database sprint (agreed 2026-10-09)

**Agreed with the user 2026-10-09**, after a read-only measurement of kind's database (and compose's
size). Decisions 137-142. One branch off `main` per PR, in this order; ask before starting, as
always. The user's first list had four items - retention, composite indexes, vector indexes, a
foreign-key audit - and the measurement moved most of them:

- **Vector indexes are already done.** `kb_chunks` has HNSW since 0013, `instrument_profiles` since
  0015. At 36 chunks the planner rightly ignores it (a scan is exact and faster). Nothing to build.
- **The foreign keys leave no orphans.** Every `*_id` column has one except `notifications.ref_id`,
  which is polymorphic by design. The rules are deliberate (decision 140); nothing to change.
- **Retention is mostly in place or not yet needed** (decision 141): `llm_calls` prunes on insert,
  `ops_events` is upserted by `dedupe_key`, `admin_audit` is never pruned.
- **Indexes cannot be chosen yet:** nothing records slow queries (`pg_stat_statements` absent,
  `log_min_duration_statement = -1`), there is no `findings` table, `runs` has `started_at` not
  `created_at`, and `fills` was empty. They come from a week of statistics (DB3, DB4).

**What the measurement found instead (kind, 2026-10-09):**
- **`instrument_profiles` is 155 MB of a 176 MB database, for 5,243 rows** (heap 18 MB, indexes
  48 MB - the HNSW index alone 41 MB - TOAST 89 MB). It had taken **276,637 updates, about 53 per
  row, 1 of them HOT**; `instruments` 271,294. Cause: `load_universe` (`profiles.py`) updates every
  profile and instrument on every load, because `size_as_of` and `updated_at` always change, and
  each new row version is inserted into the HNSW index. And loads are frequent: **49 loads since
  2026-09-30 but only 2 distinct snapshots**, because the startup loader skips only a snapshot
  *older* than the last load (`loading.py`, `as_of < last_loaded`), so every stack start reloads
  the same one - about 10,500 row rewrites plus `DELETE FROM etf_holdings` and 16,307 inserts.
- **No backup exists.** No `pg_dump` anywhere in `infra/` or `scripts/`; kind's data lives on a
  `local-path` volume inside the node container, which `scripts/k8s-down.sh` deletes. Compose's
  database (226 MB, 44,465 articles, the scheduled scans) lives in one Docker volume.
- **`runs` had 1,768 sequential scans averaging ~700 rows** - some query reads the whole table
  repeatedly. Harmless at 1 MB (about 130 runs a day); the statistics in DB3 will name it.

**DB1 is built (2026-10-09, #208):** `scripts/db-backup.sh`, `db-restore.sh`,
`backup-schedule.sh`, `lib/backups.sh`, the launchd template in `infra/launchd/`, RUNBOOK section 5.
**Drills passed on both live databases:** compose 51 MB, 42 tables, 135,828 rows, dumped in 10 s;
kind 4.3 MB (its fixture-embedder vectors compress well), 42 tables, 30,330 rows; every table
restored to exactly the rows the dump holds. CI now plants 90 days of dated dumps and checks the
retention rule, drills both environments, and performs a real swap-restore on compose that the
services come back from. Built differently from the row below, on purpose: a real restore never
drops anything (restore beside, verify, rename the live one to `<db>_before_<stamp>`, swap), and the
dump is verified by reading the *whole* archive back (`pg_restore --data-only`, counting COPY rows
into `.counts`) rather than `pg_restore --list`, which reads only the table of contents. **Still the
user's to do:** run `bash scripts/backup-schedule.sh install` from the main checkout (it writes to
`~/Library/LaunchAgents`), and answer whether `~/Backups` is under Time Machine. Also found while
building: compose's `instrument_profiles` is 155 MB too (5,226 rows) - DB2 applies to both.

**DB2 is done (2026-10-11, #210; deployed and reclaimed the same day).** Both upserts in
`profiles.py` update a row only when a value differs (`IS DISTINCT FROM` over every column but
`updated_at`; the instrument's `WHERE` mirrors its fill-only `SET`), with the `RETURNING` fallback
select; ETF holdings are compared as a multiset (weights quantized to the column's 6 places) and
replaced only when they differ. `universe_loads.report` gains `profiles_written` and
`holdings_replaced` - read those first when asking "did a load write anything?".
`tests/integration/test_universe_load_sql.py` checks by `xmin` that a reload leaves every row
untouched; it **fails on the old code** (checked). **Measured on deploy:** the first reload on
each environment reported `profiles_written 0, holdings_replaced 0`, and kind's counters were
identical across the restart (287,071 profile and 281,728 instrument updates, 881,082 holding
deletes). On compose, 10 instrument updates did land - all 10 of the user's holdings, in one
transaction, from the `snapshot` run refreshing their metadata, not the loader. **Reclaimed with
`VACUUM (FULL, ANALYZE) instrument_profiles`** (after a fresh backup; ~3 s each, `lock_timeout`
30 s): kind 155 -> 96 MB (database 176 -> 117 MB), compose 155 -> 97 MB (229 -> 171 MB); heap
18 -> 9 MB, TOAST 89 -> 45 MB, indexes 48 -> 43 MB. **The estimate was wrong, and why:** the plan
expected ~45 MB, from `sum(pg_column_size(row))` = 43 MB - which counts heap rows only. The HNSW
index is a real 40 MB (5,243 vectors of 1,536 floats are 31 MB before the graph), so it was never
bloat. *Lesson: estimate a table's floor as live rows plus a fresh index build, not live rows.*
`pgstattuple` on a copy was dropped from the plan: a dump-based copy has no bloat, and a
file-level copy needs the live database disconnected; the `VACUUM FULL` before/after measured it.
#209 (Insights tabs, another session) shipped in the same redeploy; it has no migration.

**DB3 is done (2026-10-11, #213; deployed, window opened 07:56 UTC on both).** Migration **0050**
creates `pg_stat_statements` - in Alembic, because an extension is schema (as `vector` is) and a
report that ran DDL the first time it was read would change the database by looking at it. Both
servers get `shared_preload_libraries=pg_stat_statements`, `log_min_duration_statement=200` and
`log_lock_waits=on` (compose `command:`, StatefulSet `args:`; kept identical by comment). CI's
integration Postgres is a GitHub service container, which cannot take server flags - creating the
extension works there, only reading it fails, and the compose and kind CI jobs (which do carry the
flags) run the report. **A trap found while building:** the extension grants its views to
`PUBLIC`, so revoking from `traders_app` alone left `has_table_privilege` true; 0050 revokes from
`PUBLIC` too, and `test_query_statistics_sql.py` pins it. `scripts/db-report.sh --target
kind|compose [--reset]` reads statements by total time, tables by sequential reads, never-scanned
non-unique indexes, sizes and the slow log; `--reset` starts the window. The helpers that reach
each database moved from `lib/backups.sh` to `lib/db-targets.sh` (`db_target_available`,
`db_targets`, `require_db_target`), which `backups.sh` sources. RUNBOOK section 6. **After merge:**
redeployed both (Postgres restarted with the flags; both show `shared_preload_libraries =
pg_stat_statements`, `log_min_duration_statement = 200ms`, revision 0050, `/readyz` ok), then
`--reset` on each at **2026-10-11 07:56 UTC** - the window DB4 reads.

**The PRs:**

| # | PR | Size | Done when |
|---|---|---|---|
| DB1 ✅ | **Backup and restore** (decision 137). `scripts/db-backup.sh [--target kind\|compose]`: `pg_dump -Fc` run inside the Postgres container (`kubectl exec` / `docker exec`, so the host needs no Postgres client and the versions match), streamed to `${TRADERS_BACKUP_DIR:-$HOME/Backups/traders}/<target>/`, written to `.partial` and renamed only after `pg_restore --list` reads it; directory `700`, files `600`. Keeps the newest 14 plus one a week for 8 weeks. `scripts/db-restore.sh <file> --target ...` refuses without `--yes`. `k8s-down.sh` takes a kind backup before deleting (skip with `--no-backup`). A launchd agent (a plist template under `infra/launchd/` and an install script the **user** runs - it is persistent config on their Mac) runs both targets daily. `k8s-up.sh` and `dev-docker.sh` warn when the newest backup is older than 48 h, so a schedule that stopped is noticed | M | **a restore drill passes:** a dump of each environment restored into a scratch database with row counts equal per table; the drill and the dump sizes recorded here |
| DB2 ✅ | **The universe loader writes only what changed.** Both upserts in `load_universe` gain `WHERE (...) IS DISTINCT FROM (...)` over every column but `updated_at` (`size_as_of` included, so a *new* snapshot still updates its rows). **Trap:** `ON CONFLICT DO UPDATE ... WHERE` false returns no row, so `_upsert_instrument`'s `RETURNING id` needs a fallback select. ETF holdings are replaced only when the set differs. **Do not** skip the load when `as_of` equals the last one: the mounted descriptions file can change without `as_of` changing - the row-level guard is the safe one. Then, **after DB1 has a fresh backup**, reclaim the space once: measure live versus dead bytes first (`pgstattuple`, on a copy), then `VACUUM FULL instrument_profiles` (an exclusive lock for seconds; run it with the CronJobs quiet) | S-M | a test loads one snapshot twice and the second writes no row; `n_tup_upd` on both tables unchanged across a `k8s-up.sh` restart; the table's size before and after recorded here |
| DB3 ✅ | **Query statistics on.** `shared_preload_libraries=pg_stat_statements` and `log_min_duration_statement=200` (ms - an observation threshold, not a product rule) as server flags in `infra/k8s/base/postgres.yaml`, `infra/compose/docker-compose.yml` and CI's Postgres; the extension created (Alembic, or a guarded init - settle in the PR; **0049 was taken by #206** (`0049_finding_episodes`) although IBI's plan names it, so read `origin/main`'s newest migration before numbering). `scripts/db-report.sh`, read-only: top statements by total time, tables by sequential reads, unused indexes, sizes, dead tuples. Reset the statistics once after deploying, so the week starts clean | S | the report runs against both environments; the date the week starts recorded here |
| DB4 ½ | **The review, a week after DB3 - split by decision 143.** First half done 2026-10-11 (#218 and the record PR; decisions 143-147); the second half reads the full week. Planned as: **The review, a week after DB3 - measure, then decide.** No code planned: the report, then one question at a time with a recommendation. Expected questions: the query behind `runs`' full scans and its index; `intents_ledger_idx` (no reader, decision 138) and other indexes with no scans across a full week; retention for `runs`. Each answer becomes a decision; any change is its own PR | — | the findings and the user's answers recorded as decisions |

**Considered and rejected:** an in-cluster CronJob for backups (decision 137); a backup operator
(CloudNativePG's WAL archiving, point-in-time recovery) - it needs object storage and replaces the
StatefulSet, for a database whose lost day costs one day of simulated history; PgHero for the
statistics - one more running service for a weekly read, where five SQL queries do it; a
scheduled sweep of `telegram_bind_tokens` (decision 139).

**Open, to settle in the PR that meets it:** whether `$HOME/Backups/traders` is inside Time Machine
or iCloud on the user's Mac (if so, the dumps get a second copy off the laptop for free - ask in
DB1); the extension's home (DB3).

### Stage 4 is complete (#186, #188, #197, #199, 2026-10-07/08)

**As built:** PR 5b #186 - a scan's proposal is announced with Approve/Reject past the severity
floor; Telegram Approve previews at the live price and Confirm fills at the price signed in the
button; refusals append a reason and keep Approve/Reject; the consolidated view shows pending trades
beside their ticker or above the table (D60-D63). PR 6 #188 - `GET /agents/:id/scans` and
`/scans/:scanId`, the *Decisions* tab as readable steps, *Run a scan now* waiting inline, schedule,
model budget and today's spend on Settings, *Waiting for a persona* (D64-D66). PR 7a #197 -
`installation_settings` and the agent-limit trigger (0047, D72). PR 7b #199 - the schedule
(D68-D71, D73, D74; decisions 124-129 here). **How it was verified:** every migration rehearsed on a
copy of the live database (up/down/up, row counts); the Telegram flow on a copy with the market open
(a refused Confirm recorded, the real one filled once); the trigger on a copy as `traders_app`
(fourth refused, restore refused, archive frees a place); the schedule with real services on a copy
(a scheduled scan proposed buying INTC; a failing slot retried twice and gave up once).

### Next session: after the debt fixes (history - superseded by "after the Insights work", 2026-10-11; D75's choice was saved 2026-10-08 19:45)

Ask the user before starting anything (the Stage 4 grant ended). In order of the user's last answer:
0. **The database sprint's review, DB4's second half - due on or after 2026-10-18** (see "Next
   session: the database sprint's review" below). No off-laptop copy exists, by the user's
   choice (decision 147) - do not ask again.
1. **Review the scheduled scans** once three trading days have run (09:00 New York each trading
   day, compose only): outcomes, refusals like 2026-10-08's "1,923", cost per day, from
   `agent_scan_runs` and `llm_calls WHERE purpose = 'agent_scan'`. Report before changing anything.
2. **Check D75's choice:** `SELECT * FROM llm_model_choices` on compose. No `explain` row means
   narration is still on the free route; remind the user (Admin -> "Narration and questions" ->
   *Use this model*). Once it is set, re-measure narration after a few days, as §14.4 did.
3. **IBI is gated by decision 135** - nothing until the 2026-10-15 check (or public news) shows IBI
   open to other MCP clients, and the user says go.
4. **The `/ask` assistant milestone** remains a candidate ("Planned: the assistant").

### Next session: after Stage 4 (history - task 17 and both debt fixes done; see above)

**Task 17 is done** (#198, D75, §14.4 - this line said "do first" because #200 was written beside
#198; the next session lost a few minutes finding that out). D75's one manual step, choosing Sonnet
for the *explain* scope on the Admin page, was still undone on 2026-10-08 19:00 UTC: if
`llm_model_choices` has no `explain` row, narration is still on the free route. Then ask the user
what follows. **Candidates, each to be asked
about one at a time, not assumed:**
- **Watch the scheduled scans for a few trading days** - outcomes, refusals ("1,923"), cost per day
  - before changing anything about them (debt rows above).
- **The two debt fixes the user has not yet approved:** the sentiment scorer reading "Sinks 22%" as
  neutral; the Admin model picker showing a model as chosen when none is.
- **IBI read-only sync (D67, `docs/PROPOSAL-IBI-SYNC.md`)** - planned by #190; its migration takes
  the next free number (0047-0049 were taken by PR 7 and `finding_episodes`).
- **The assistant milestone** (`/ask` with tools; "Planned: the assistant" below).

### The UI/UX sprint is complete (#189, #191-#195, 2026-10-08)

**As built:** UX1 #189 - `ChartTooltip` for all four charts, Allocation opens by holding
(`lib/allocationGrouping.ts`, `localStorage`), no outline on a clicked slice. UX2 #191 - `AppBar` in
the root route, Account menu / hamburger below `md`, Sign out behind a divider; top-level pages lost
"Back to portfolio". UX3 #192 - `/insights?tab=observations|digest`, the legacy `/?severity=`
redirect; Telegram and the digest carry no links into the app, so nothing else pointed at the feed.
UX4 #193 - migration 0046, `POST /notifications/digest/seen`, `DigestBanner` (decision 119). UX5
#194 - summary, charts row (2:1), holdings full width with `HoldingsActions`; `Drawer` and
`Disclosure` extracted (decision 121). UX6 #195 - Export JSON in the importer's shape (decision 120).
Each was checked in the user's Chrome in Hebrew at desktop and 375 px. The plan as agreed follows,
for its reasoning.

#### The plan (agreed 2026-10-07)

**Agreed with the user 2026-10-07**, item by item. The user said "merge" (then "admin merge") per PR. One branch off `main` per PR, in this order (each stands alone).

**What was decided, and why:**
- **The dashboard becomes summary -> two charts -> the holdings table.** Value over time and
  Allocation share a row (Allocation keeps its size; Value over time shrinks to the width the
  holdings table has today); the holdings card gets a row of its own, because a table needs width.
  On mobile everything stacks. Do not add cards back to it - that is the point of the sprint.
- **The holdings card owns its actions:** *Add holding* (primary button, opens a **drawer** on
  desktop, a full-screen sheet on mobile - the form is too long for a modal), *Targets* (a button;
  today a top-bar link to `/targets`), and *Import* / *Export* in a "⋯" overflow menu. Import and
  Targets leave the top bar.
- **Export is JSON only** (the user), in the **same shape the import wizard reads**, so an export
  re-imports cleanly. Quantities as decimal strings, money as minor units + currency - the stored
  values, never the displayed (rounded) ones.
- **Allocation:** default view **by holding** (not by class), the last choice remembered; no focus
  frame after a mouse click (it is the browser's outline on the SVG - keep a ring for keyboard
  focus, `:focus-visible`); the tooltip was black text on dark blue, the same blue as a slice.
- **One tooltip across the app** (the user): the one `EquityCurve` (`DayTooltip`) and `PriceChart`
  (`CloseTooltip`) already draw - `rounded-lg border bg-surface-raised shadow-lg`. Extract it once
  and use it in every recharts `Tooltip` (Allocation, AgentPerformance, the two above).
- **Observations and the digest leave the dashboard entirely** (the user: no observations on the
  main page, not even a count). They move to one **Insights** page in the app bar, two tabs
  (Observations, Digest) - one bar slot instead of two.
- **The digest is announced, not shown in a card:** a dismissible banner at the top of the
  dashboard when a new digest exists ("Today's digest is ready" -> Insights/Digest). Chosen over a
  modal on entry: a modal every morning gets dismissed unread. **"Seen" is stored on the server**
  (per user, the last digest id seen), not in `localStorage` - otherwise it returns on the phone.
- **The app bar is shared, not the dashboard's:** today every nav button is rendered inside
  `DashboardPage.tsx`. On mobile it collapses into a hamburger menu; **Sign out is separated** from
  the actions (bottom of the menu behind a divider on mobile, a user menu with Settings / Admin /
  Sign out on desktop).
- The empty state for no holdings already exists (Add / Import) - the user checked; keep it.

**The PRs:**

| # | PR | Size | Done when |
|---|---|---|---|
| UX1 | **Chart tooltip + Allocation fixes** - one shared tooltip component used by all four charts; Allocation defaults to by-holding and remembers the choice (per-viewer convenience, `localStorage` wrapped in try/catch is fine here); no focus frame on click | S | every chart shows the same tooltip in light and dark; a test pins the by-holding default |
| UX2 | **Shared app bar** - extract the bar from `DashboardPage` into the root route's layout so every page has it; hamburger below `md`; user menu with Sign out separated; Import and Targets removed from it (they reappear in UX5 - until then Import stays reachable from the empty state and the bar keeps Targets, so nothing is lost between PRs) | M | every route renders the bar once; mobile menu works by keyboard; RTL mirrors it |
| UX3 | **Insights page** - `/insights` with Observations and Digest tabs (the tab in the URL, so it can be linked); `ObservationsFeed` and the digest content move there; both leave the dashboard | M | dashboard shows neither; Telegram/digest links that point at observations still land somewhere sensible |
| UX4 | **The digest banner + "seen" on the server** - Alembic migration (a `digest_seen_id` / `_at` on `user_settings`, `user_id` as always), an endpoint to mark it seen, the banner on the dashboard | S-M | banner appears once per new digest, disappears after dismiss or opening it, on every device |
| UX5 | **Dashboard layout + the holdings card** - charts share a row, holdings full width; Add holding drawer (replaces the inline `AddHoldingForm`); Targets button; "⋯" menu with Import (opens `ImportWizard`) and Export (disabled until UX6) | M | layout matches the order above at desktop and phone width |
| UX6 | **Export holdings as JSON** - the same shape the import wizard reads; built from stored values | S | export -> reset -> import round-trips to identical holdings (a test) |

**Open, to settle in the PR that meets it:** whether Targets opens the `/targets` page or a drawer
(UX5); the export's filename and whether it carries cost basis per lot or per holding (UX6 - read
the import parser first and match it).

### Planned: the assistant - `/ask` with tools (after Stage 4)

**Agreed with the user 2026-10-07, one question at a time.** Today `/ask` routes a question with
fixed rules, answers from glossary passages, and lets the model write one checked paragraph; it
works with no model. The user wants an assistant instead: it chooses tools the way an agent's scan
does (Stage 4, D15), and shares that loop and its read-only tools rather than building a second one.

**Tools:** web search; tickers (the agent's quote, history, findings and news tools); the user's
account (agents, their proposals, performance, holdings); the product's capabilities, so it can
answer "what can I ask you?".

**Decided:**
- **A model is required.** No no-model path: a tool-using assistant cannot work without one, and
  keeping today's extractive path beside it would double the work. Without a configured model the
  page says the assistant needs one.
- **Conversation memory in Postgres** (`user_id` on every row, guideline 5), not S3: small text that
  must be listed and searched; S3 is for files. Each question sends the last few turns of the same
  conversation. **Kept 90 days, then deleted; a "delete this conversation" control.**
- **Guardrails:** read-only (it explains and links, never trades, approves or changes settings); no
  personalised advice - "should I buy X?" gets facts and context, never a yes or no (guideline 2);
  **its domain only** (markets, investing, the user's account, the product), anything else is
  declined politely; a daily spend limit like an agent's.
- **Prompt-injection defence, in layers:** web and news text is passed as labelled data the model
  is told never to obey; every tool is read-only, so a persuaded model can do nothing harmful;
  figures are checked against tool results (guideline 7); web results are reduced to plain text
  and trimmed before the model sees them; every conversation is logged for review.

**Added 2026-10-11 (the user, while drafting the test set in `docs/ASSISTANT_QUESTIONS.md`):**
- **A scan-replay tool** (read-only): reads a scan's recorded transcript (`agent_scans`,
  `llm_calls`) so the assistant can answer "what tools did my agent use to reach that?" step by step.
- **A universe tool**: the snapshot's date, counts, how it was screened, and whether a symbol is in
  it - so "when was the universe updated?" comes from data, never from the model.
- **The scope stays narrow** (re-confirmed): general news, weather, sport, travel and personal
  savings plans are declined; company and market news, and how events touch the user's holdings,
  are answered. Borderline cases are test cases O4-O10.
- **No memory across conversations.** Memory stays per conversation; asked about an earlier one,
  the assistant says it does not remember (test case M7).

**Build, agreed 2026-10-11 (the user chose each; grant in the auto-memory `traders-assistant-grant`):**
1a. AI service core - shared loop `app/llm/tool_loop.py` (the scan now uses it), `app/assistant/`
    (six own tools + six shared agent tools, the reply check, conversations, the daily limit),
    `POST /assistant/messages`, migration **0052**. 1b. Admin: the `assistant` model picker and
    the daily-limit field; orchestrator route; list/read/delete conversations (orchestrator SQL).
2. `replay_scan` + `get_universe_info`. 3. The `/ask` chat screen, 90-day retention. 4. The eval
    runner on a real model + cost measurement -> the real limit. 5. The `openai` package switch.
**Decided in 1a, each argued in its module's docstring:** the assistant has **its own scope**
(`assistant`) - until 1b adds the picker, no choice exists and calls use `LLM_MODEL`; a
**$0.50/day per user** limit in `installation_settings`, reset at the **user's midnight** (an
agent's budget keeps UTC days, D45); step limit 8, 2,500 output tokens, 120 s, history = last 6
messages (open - measure in PR 4); **one repair turn** when a reply fails its check, then the
user is told no checked answer exists (the text is kept for review, never shown); **sources are
built by the server from the tools that ran**, never by the model; **the user's own words count
as evidence** (so "not 50%" can correct them); **earlier tool results stay evidence** for
follow-ups, though they are not re-sent; no-model and budget are 200 outcomes, not errors.
**Measured on a live copy with the free route (2026-10-11), which changed the code:** a real
reply wrote every hyphen as U+2011 and "7‑day" was refused (dashes are now normalised for the
assistant's check only - **narration's and the agents' checks still refuse them; a candidate
fix**); a table of 20 holdings hit 1,500 tokens mid-JSON (now 2,500, and "keep replies short");
the model passed `"None"` as an agent name. After the fixes: answered with sources in one tool
call, and declined the weather with none. **It also said "EOSE is the only holding down" when
three others were** - a reasoning error no figure check can see; that is the eval's job (PR 4).
**1b (2026-10-12):** the `assistant` scope is offered for the agents' list (billed, tool-calling;
the free route is refused with a 422); `PUT /admin/settings` takes either setting alone;
`/assistant/*` in the orchestrator (`routes/assistant.ts`, `queries/assistant.ts`) - the model's
name, the cost and the tool transcript never reach the browser. **`/assistant` had to be added to
`PROTECTED_PREFIXES`** - `app.test.ts`'s walk over every route caught it; the route's own
signed-in test had passed only because the handler happened to refuse. **First paid measurement,
on a live copy with Gemini 3.5 Flash-Lite:** two questions (one a follow-up) took ~5 s each and
cost $0.0054 together (7 calls, 14,840 prompt tokens): ~$0.003 a question, so $0.50/day is ~180
questions. One copy run, not PR 4's measurement. No `assistant` choice exists live yet - the user
chooses it on the Admin page.
**A checker limit that made a test flaky by date:** `unsourced_figures` accepts a number quoted
in an evidence *string*, and timestamps are strings - so on 2026-10-12 an invented "12%" passed
because `price_as_of` read "2026-10-12T...". Small whole numbers (days, hours, minutes) are
effectively unchecked whenever a tool result carries a timestamp. The tests now invent figures
with two decimals; **the checker itself is unchanged - a candidate fix** (read dates as dates).
**PR 2 (2026-10-12): `replay_scan` and `get_universe_info`, and what a real model broke** (Flash-Lite
on a live copy, $0.045 for 55 calls including one real scan). Each fix is in `reply.py`/`tools.py`
with its measurement: an agent asked for as "Test" (named "Test agent") found nothing - names now
match exactly, else the one agent containing the word, never a guess between two; a turn that came
back with **no text** ended the question - a failed call is now made once more; numbered lists
("2.") were read as figures; a reply quoting a raw timestamp was refused for "57" - **dates are now
read as dates in the assistant's check** (a date the evidence states passes whole, and the
evidence's own dates are stripped so a timestamp's digits never source a figure: this closes the
"12% on the 12th" hole for the assistant; **narration and agents still have it**); link targets'
digits were read as figures; invented pages (`/universe`, `/guide`) - a link to a page not in
`product_guide.PAGES` (held equal to the router by a test) is reduced to its words, the reply
kept; a replayed scan was never a source because its result had an `error: null` field - a tool
refusal is now a result whose *only* field is `error`. **Still open, for PR 4's eval and the
model choice:** Flash-Lite declined "How was the universe made?" as cosmology 4 times in 6 even
with the app's meaning spelled out - prompt-tuning against three samples was stopped on purpose.
**PR 3 (2026-10-12): the `/ask` screen is the assistant.** Markdown by **`react-markdown` + `remark-gfm`**
(the user's choice under CLAUDE.md convention 5, over extending `conceptText.ts`; raw HTML and
images never render); suggestions and examples fill the box, never send (decision 70 kept); the
three no-reply outcomes are said in the page's language, not the server's English; history beside
the chat with delete (confirm). **Retention runs when a user starts a conversation** - their own
conversations untouched 90 days go first; no scheduled job (cost: a user who never returns keeps
theirs until they do). Checked live on a copy in the built-in browser, desktop and phone width,
with a follow-up; 4 questions $0.004. **Left on purpose:** the old `POST /ask` (extractive path) in
both services and its 35-case eval job still exist, unused by the web app - removing them belongs
with PR 4, whose eval runner replaces that job.
**Environment trap:** the worktree's `.venv` is a symlink to the main checkout's, whose editable
install points `app` at the main checkout - so `python scripts/export_openapi.py` silently
exported **main's** app. Run it as `PYTHONPATH=. .venv/bin/python scripts/export_openapi.py`.
**PR 4 (2026-10-12): the eval runner, decided with the user one question at a time.**
- **Grading `behaviour`: a model judge (Sonnet 5.5) plus the user reading** every failure and every
  judge/mechanical disagreement (the report lists them). Rejected: human only (85 turns per model per
  run); judge only (its mistakes go unseen). The judge costs ~$0.003 a turn - more than Flash-Lite.
- **The world is built, not copied** (`scripts/assistant_eval/world.py`): committed fixtures + rows
  written relative to the run's clock, one fresh account per case. A live copy would grade differently
  every week, and two models compared a day apart would not have seen the same world. The drawdown
  alert is `drawdown_findings` over the fixture prices (SMR, high), not a typed number.
- **Advice cases accept a decline** (`expect.or_decline`): the rule is "never a yes or no", not the
  label. A links entry may be a list of alternatives.
- **The test set was stale in two places**, fixed in PR 4: the real portfolio cannot hold cash (the
  ledger trigger refuses an `agent_cash` row for the primary agent), and Proposals is an Insights tab.
- **$0.50/day kept** (the user's choice over $0.25 and $1.00), now measured: Flash-Lite mean $0.0019,
  p90 $0.0031, max $0.0071 a question.
- **Haiku 4.5 rejected for the assistant**: worse (40% vs 51%), 6x the cost, 5x slower.

**Order (the user's):**
1. Follow-up questions (conversation memory), sources on every answer, suggested next questions.
2. Answers in the user's language - needs a decision amending guideline 1, which keeps `/ask` English.
3. `/ask` in Telegram.

**Web search is in question (the user, 2026-10-07):** the universe, its profiles, stored news and
the agents' tools may already answer most questions. Decide by measuring - run the test set below
with and without web search and keep it only if it answers questions the rest cannot. Without it,
the largest prompt-injection surface goes too.

**Before building:**
- **A test set for the assistant**, like `/ask`'s 35-case set (#47) and run in CI: ordinary
  questions, follow-ups, and attack cases - off-domain questions, "ignore your rules", a web page or
  news text carrying instructions, "should I buy X?". It is how the guardrails are shown to hold.
  **Written 2026-10-11:** `data/eval/assistant.json`, 80 cases (11 in the user's own words), from
  `docs/ASSISTANT_QUESTIONS.md`. Every case needs a model, so none runs on a PR yet; the runner is
  built with the assistant. What runs now is `test_assistant_eval_set_contract.py`: tool names
  against `app/agents/tools.py` (`exists` / `planned` - flip the status when a planned tool is
  built), links against the web router, no tools on a decline, and every user question present.
  The planned tools it names (`get_portfolio`, `get_agents`, `get_proposals`, `get_observations`,
  `get_topics`, `replay_scan`, `get_universe_info`, `get_product_guide`) are the assistant's tool
  list as far as the cases need it - a starting point, not a decision.
  **Written before #209 and #214 (2026-10-11), so update it when the assistant is built:** three
  cases expect a `/proposals` link and P4's tour lists Proposals as a page. `/proposals` now
  redirects to `/insights?tab=proposals` and Proposals is no longer in the bar (decision 134), so
  link the tab and tour Insights' four tabs. M2 ("what happened while I was away") can use the
  unread state: `GET /observations/days` and `insights_seen_at` (decision 133).
- **A cost measurement** on a few real questions once the account is funded; the assistant's daily
  spend limit is set from it, not guessed.

**A research agent, used as a tool by both the assistant and the trading agents** (the user,
2026-10-07). Agent C decides; it calls `research(question)`, and agent B investigates with the
read-only tools and returns a summary **with its sources**, so the evidence validator still checks
C's figures against real tool results, never against B's prose. Plain Python: the scan's loop made a
reusable function, called with a narrower prompt and tool set (D53); if agents multiply further,
the OpenAI Agents SDK ("agents as tools") is the framework to look at first - its catch is that it
makes its own model calls, so the recorder, the budget guards and the Admin page's model choice
must be wired into it (CLAUDE.md convention 5: the user decides). **Cost is measured, not assumed.**
Each step re-sends the conversation, so one agent doing research and decision carries every raw
result into every later step, while C carries only B's summary - a worked estimate (4,000-token
briefing, five 1,500-token results) came to ~46,500 prompt tokens for one agent against ~38,700 for
B+C, before running B on a cheaper model. It costs more when C asks for research repeatedly or B
needs the briefing too. **How the answer becomes accurate:** (1) real scans on the funded account
record every call's tokens and the full transcript (`llm_calls`, `agent_scans`); (2) replay those
transcripts as B+C on paper - same tool results, recomputed prompt sizes - for an estimate from real
sizes; (3) run both on the same agent and days and compare cost and the quality of the decisions.

**Future task, not in the first version: long-term memory** - what the assistant keeps across
conversations (preferences, what the user follows). Scope and storage to be decided when it starts.

**Open when it starts:** the web-search provider (behind an interface, guideline 6, and per
CLAUDE.md convention 5 a package is proposed to the user before anything is hand-written); how
many turns of history each question sends.

**Framework - decided with the user 2026-10-07: plain Python and the official `openai` package.**
The loop is our own (~25 lines, the same loop an agent's scan runs); the client becomes the `openai`
package pointed at OpenRouter's base URL, for chat and embeddings together - **this milestone pays
the "hand-written clients" debt row.** *Rejected:* LangGraph - the one feature the assistant would
use is streaming progress ("searching the web..."), which the `openai` package also gives; its
Postgres checkpointer stores opaque state, which makes the 90-day deletion, the delete control and
a readable history harder than two plain tables; and it adds `langgraph`, its checkpointer package
and `langchain-core`. LangChain - it would make its own model calls around the wrapper that records
each call, checks the budget and applies the Admin page's model choice. *Reopen if:* the assistant
grows into separate stages or several cooperating agents.

### Next session: Stage 4 PR 5b - Telegram, and the consolidated view's pending proposals (history - done as #186; then #188, #197, #199)

**Read first:** D47-D49, D55-D59 and §14.2-§14.3 in `docs/PROPOSAL-MULTI-AGENT.md`; then
`apps/orchestrator/src/services/tradeApproval.ts` (preview, confirm, `recordingRefusals`),
`services/tradeProposals.ts`, `telegram/updates.ts` (`handleCallback`, `/pending`),
`telegram/callbackToken.ts` (64-byte callback data, HMAC) and `notify/messages.ts`.

**What 5b builds (no migration expected):**
- **Telegram (D47):** a trade proposal is announced (it is not today - a manual scan raises it
  silently; decide with the user whether a manual scan notifies at all, and quiet hours per D5).
  *Approve* replies with the preview (agent's price, live price, distance, cost with fee, cash
  after) and a *Confirm* button carrying the previewed live price - the price must fit the signed
  64 bytes (measure: proposal id 16 bytes + action + nonce + MAC; a price as a varint). *Reject*
  as today. Refusals in the user's language from the catalogue, recorded as attempts with
  `surface: 'telegram'`. Replace `approve_with_preview` for Telegram with the real path.
- **The consolidated holdings view (D35):** pending trade proposals on a ticker shown beside it.
- **Questions to bring, one at a time:** does a *manual* scan's proposal go to Telegram (recommend:
  yes - it is the user who will approve it, and the dashboard is not always open); does a
  Telegram Confirm need a second tap at all (D47 says yes); what Telegram shows when the market is
  closed (recommend: the refusal with the next open, and no Confirm button).

**After 5b:** PR 6 - the agent page (*Decisions* tab, D50; Settings: schedule with cost per run,
LLM budget, *Run a scan now*, waiting-for-a-persona; D45, D46, D52), then PR 7 the schedule.
Task 18 (reset account) and the debt rows above whenever asked.

**Pending, not code:** redeploy #183; **task 17 (done 2026-10-08: 86% accepted since #179, but 24 s
per call; narration moves to Sonnet on the Admin page, D75 and §14.4)** - after 2026-10-08 10:15 UTC re-measure the free
model's narration rejection rate since #179 deployed (2026-10-07 10:13 UTC): `SELECT verdict,
count(*) FROM llm_calls WHERE purpose = 'narration' AND started_at > '2026-10-07 10:13+00' GROUP BY
1` on compose; record it in §14 and decide with the user whether narration moves to Sonnet
(~$0.02/day measured).

### Stage 4 PR 5 as built (history - #182, #183, 2026-10-07)

Measured first: three real scans, $0.036 average; every one found no news on the mover it looked
at. Asked one at a time, the user chose every recommendation: split PR 5 (D56); a buy cash cannot
cover is `invalid_answer` at the scan's end (D55); news on demand as its own PR (D57) from Yahoo,
hourly (D59). Found on the branch with real scans and fixed in 5a after asking: the validator
refusing "60-day" (a window the evidence names in a key) and a thesis's own quantity (D58) - the
first version exempted every number before a time unit, and the existing "worst day in 14
months" test caught it. Bugs caught on screen: an English thesis on a Hebrew page laid out right
to left (now `dir="auto"`); the closed-market message told an approver to "type a price".

### Next session: Stage 4 PR 5 - the trade proposal and its approval (history - done as #182, #183)

**Read first:** D26, D47-D49, D51, D54 and §14.2 in `docs/PROPOSAL-MULTI-AGENT.md`; then
`services/ai/app/agents/scan.py` and `answer.py` (what a scan's answer already guarantees), and
`apps/orchestrator/src/services/fills.ts` (`executeFill`, the only writer of fills) and
`services/proposals.ts` (`applyDecision`).

**What PR 5 builds (migration 0044):** `buy` / `sell` proposal kinds on simulated agents only (the
primary's allowlist stays `{'rebalance'}`, decision 104); `CHECK (source <> 'agent' OR proposal_id
IS NOT NULL)` on `fills` (the debt row); an `agent_scans` → proposal link; a `trade` scan becomes an
observation with the thesis and a proposal with the agent's quote, TTL from the next open (D4);
**cash for cost plus fee checked here (D54)**; Approve previews at the live price, refused beyond
300 bps of the agent's (D47); Confirm fills through `executeFill` in the approval's transaction;
Approve and Reject only (D48); a refused attempt stays pending and is recorded (D49); dashboard and
Telegram; the thesis in the user's language with CLAUDE.md guideline 1 amended (D51).

**Before merging PR 5, measure real scans** - the user funds OpenRouter and chooses the agents'
model on the Admin page; create a test agent with a persona and cash; run `POST /agents/:id/scans`
a few times; read `agent_scans` (steps, cost, outcome, transcript) and `llm_calls`. That replaces
§14.1's assumed cost (~$0.04-0.38 a scan), feeds D46's estimate, and is stage 1 of the research-agent
measurement ("Planned: the assistant").

**Pending on the user, not code:** redeploy #179/#180; ~a day after, re-run task 17's export
(`llm_calls` where `purpose = 'narration'` and `verdict = 'unsourced_figures'`) and record the new
rejection rate - the rehearsal and export blocks from this session are in the conversation history
only, so write them again: `docker exec traders-postgres-1 ...` (never `docker exec -i` inside a
`bash <<'EOF'` block - it swallows the rest of the script), and query a column only after the
migration that adds it (Postgres resolves names before any guard).

**After PR 5:** PR 6 the agent page (*Decisions* tab, D45/D46/D50/D52), then the handoff, then PR 7
the schedule.

### History: multi-agent Stage 4 - the agent that decides (opened 2026-10-06)

**Stage 3 is complete; Stage 4 builds the deciding agent** (D14-D16, D10, D12, D26 in
`docs/PROPOSAL-MULTI-AGENT.md` §10 - read them, and §6, before anything). **Confirm with the user
that the grant continues into Stage 4** (the user says "merge" per PR; verify by content; redeploy
compose and kind; every migration rehearsed on a live copy first), then **measure first and ask one
question at a time, each with a recommendation and a concrete example** - the user asked for this
form explicitly and answered every Stage 3 question that way. What Stage 4 has to settle, as
measured or decided so far:
- **The trade proposal kind and its approval** (D26): `BUY`/`SELL` proposals on simulated agents
  only (the primary's allowlist stays `{'rebalance'}`, decision 104), approval on the dashboard and
  Telegram through `services/fills.ts:executeFill` (decision 109 - never a copy), D3's range and
  D4's TTL starting at the next open (`marketCalendar` already answers it). Add `CHECK (source <>
  'agent' OR proposal_id IS NOT NULL)` on `fills` (debt row) in the same migration.
- **The scan** (D14, D15): a code-built briefing, then read-only tools the model picks, step limit
  12, the transcript stored as the decision log, evidence-validated thesis. **D10: build it once as a
  hand-written tool loop and once as core-only LangGraph, keep the smaller; no checkpointer.** The
  provider has no tool calling yet (`openai_compatible.py`).
- **Per-agent LLM budget** (D12, $0.25/day default, micro-USD): rename `llm_calls.agent` to
  `purpose` before adding `agent_id` (debt row). The free route cannot run an agent (§11: 70% of
  narrations rejected), so a paid model is a precondition - ask the user which.
- **What Stage 3 left for it:** the score (D39-D41) has only ever seen worked examples - the first
  `agent` fill is its first real input; the consolidated rows (D35) gain the agent's pending
  proposals; the shadow SPY's fees (debt row) whenever the user asks.

### Next session: multi-agent Stage 3, continued (history - PR 6 and 7 done as #167, #168; answers D32-D42)

**Two PRs left in Stage 3**, under the standing grant (the user says "merge" per PR; verify by
content; redeploy compose and kind; any migration rehearsed on a live copy first). Read
`docs/PROPOSAL-MULTI-AGENT.md` §10 D21-D31 and §13 before anything. **Measure first, then bring
these questions to the user with recommendations** (the user asks for plain explanations with a
concrete example, and wants questions asked before work starts):

- **PR 6 - the consolidated holdings view** (§4.3, D17, D18). One row per instrument across the real
  portfolio and every non-archived agent, expanding to the per-agent split; the `All / Real only /
  per agent` filter; real and simulated **never summed into one figure**; a paused agent badged.
  Questions: does it replace the dashboard's holdings table or sit beside it (recommend: a filter on
  the dashboard, `Real only` as today's default so nothing changes for a user without agents); what
  the headline shows under `All` (recommend: two figures, real and simulated, never a sum).
- **PR 7 - performance** (D24, §5.4). A daily value per simulated agent (cash + market value), SPY in
  the backfill, the shadow SPY (each deposit buys SPY at that trading day's close), P&L and return
  beside it, and the 30/60/90-day score over `source = 'agent'` fills (reads "no agent decisions
  yet" until Stage 4). Questions: one snapshot run over all agents or one per agent (recommend: the
  existing run, looping agents, one row each - `portfolio_snapshots` is already per agent); what
  "win rate over closed positions" means under average cost (recommend: a sell whose price beats
  the average cost at that moment is a win; measure on a worked example first).
- **Then: Stage 3's closing handoff**, and Stage 4 (the deciding agent: trade proposals and their
  approval through `executeFill`, D26; the tool loop vs core LangGraph, D10).

### Next session: multi-agent Stage 3 (history - questions answered as D21-D31, PRs 1-5 merged as #161-#165)

**Stage 3 = the ledger: cash, fees, fills, approval and scoring, proven with manual trades** (D16,
D17; spec §5 as amended by D3-D6), and **the consolidated holdings view** moved here by D17. Under the
standing grant; each migration rehearsed on a live copy. The decided rules to build to: notional
budgets (D2); fees 10 bps, $1.50 minimum, rounded up, both sides, `bigint` / `Decimal` (D6); USD
only (D7); whole shares (D9); a fill uses a live quote at approval inside a server-computed ±50 bps
range, within the TTL, with the exchange open, cash re-checked under a row lock in the same
transaction, rejected never resized (D3); the TTL starts at the next market open and a static
exchange calendar is part of this stage (D4); `manual_user_override` trades are excluded from
scoring (§5.3); net worth = cash + market value, fees shown but never subtracted twice (D6); the
consolidated view never sums real and simulated into one figure (§4.3), and a paused agent's
holdings stay in it, badged (D18). **Measure first, then bring these open questions to the user
before building:**
1. **How a manual trade is entered** - a form on the agent page; at what price: the live quote
   (the same path an approval will take - recommended) or a price the user types?
2. **Cash and budget edits** - an `agent_cash` row from `budget_minor` at creation (recommended) or
   at the first trade; once an agent has traded, is a budget change a recorded top-up (recommended)
   or refused?
3. **Undoing an approval whose fill is written** (spec §5.2 left it open) - refuse the undo once
   filled (recommended: simplest, and the ledger never rewrites), or write a reversing fill?
4. **The scoring benchmark** (§5.4) - which instrument (e.g. SPY), and is its price history already
   held?
5. **The exchange calendar's source** - a committed static file of NYSE holidays per year
   (recommended, decision 1's stance) and who refreshes it.

### Next session: multi-agent Stage 2 (history - done by #158-#159; the user's answers are D17-D20)

**Stage 2 = agents exist, and decide nothing** (D16; spec §4 as amended). Under the standing grant,
in PRs of the Stage 1 size, each migration rehearsed on a live copy (recipe in Local environment).
What it covers, from the spec: creating, naming, pausing and archiving an agent (notional
`budget_minor`, D2; USD only, D7); per-agent portfolios and observations (per-agent
`AnalysisThresholds` from an `agents.thresholds` column, §4.2); the consolidated holdings view (one
row per instrument, expanding to the per-agent split, **real and simulated never summed into one
figure**, §4.3) with the `All / Real only / per agent` filter; the primary's name through i18n
(debt table). **Measure first** (the user's rule): read-only counts of what a second agent would
change, and the UI surfaces that read holdings. **Open design questions to bring to the user before
building:** how a simulated agent gets holdings in Stage 2 at all (it cannot trade until Stage 3 -
an empty agent, or manual entry recorded as `manual_user_override`?); whether a paused agent's
holdings show in the consolidated view; and where agent management lives in the UI.

Mastra was retired after this handoff, at the user's request (D11, migration 0039).

### Next session: after Hebrew server text (history - the user chose the multi-agent sandbox, 2026-10-04)

**Ask the user what comes next, with a recommendation; then ask for a grant** (the last one ended
with this handoff). The options as they stand:
1. **The multi-agent sandbox** (`docs/PROPOSAL-MULTI-AGENT.md` stages 1-3). **The user wants to plan
   it together before anything is built** ("much bigger and should involve some planning on our
   side", 2026-10-02). So start with a planning conversation: re-read the proposal, measure the
   tables it touches read-only, and bring the open design questions - do not open a PR first.
2. ~~The Mastra startup warning~~ - fixed in #150 (2026-10-04, the user's request after the
   handoff): `disableInit` on the composite store, fallbacks in start and decide, an app-role
   test. The run left suspended since 10-01 is closed by the next sweep.
3. **The debt table**, notably the owner's password in every container and the integration suite
   borrowing `traders_app`'s password (which is what bit this session twice - see Local environment).
4. **A real deployment** (Telegram's webhook leg, ReadWriteMany storage) - a milestone the user
   would write.
5. **More Hebrew** (the debt row "A Hebrew reader still meets some English server text"), only if
   asked. Hebrew wording corrections are edits to `he.json`, `hebrew_templates.py` or
   `notify/messages.ts` alone; changed templates do not rewrite stored rows.

### Hebrew server text is complete, and how it was verified

- **Measured first** (2026-10-02, read-only): all 78 stored observations re-rendered from their
  stored evidence with no error (the only diffs were 14 old drawdown rows written before a wording
  fix, and the 12 model-written ones); the model wrote 11 of the last week's 36; ~30 fixed English
  strings in the orchestrator.
- **#147:** 0035 run on a copy of the live database first (78/78 rows got Hebrew), served on a
  branch stack for the user to read; after merge both environments migrated (compose 78/78,
  kind 5/5). CI's Postgres job, run as `traders_app`, passed.
- **#148:** no message went through the real bot; Hebrew behaviour is pinned by tests (webhook
  taps, `/pending`, `/portfolio`, fan-out, narration notice, digest). Compose and kind rebuilt at
  `42e927e`; the user's live language is `he`, so the next real alert or digest is the live check.

### Next session: after Hebrew (history - the user chose Hebrew server text, 2026-10-02)

**Ask the user what comes next, with a recommendation; then ask for a grant** (the last one ended
with this handoff). The options as they stand:
1. **The multi-agent sandbox** (`docs/PROPOSAL-MULTI-AGENT.md` stages 1-3: the `agents` table and
   `agent_id` everywhere, deterministic agents, budget/fills/scoring) - an approved spec, unbuilt,
   and named as the likely next milestone since M8. The `queries.ts` split (#140) was done partly
   for it. **Recommended**: it is the only item with an approved spec, and it is a milestone.
   Start the way every milestone here starts: measure the tables it touches, then propose slices.
2. **Hebrew for server-generated text** (decision 96): the deterministic templates first, then
   the digest and Telegram; narration in Hebrew needs the evidence validator to read Hebrew
   number formats. Only if the user wants Hebrew beyond the interface.
3. **The debt table**, notably the owner's password in every container and the integration
   suite borrowing `traders_app`'s password.
4. **A real deployment** (Telegram's webhook leg, ReadWriteMany storage) - a milestone the user
   would write.
Before any of them: if the user sends Hebrew corrections, they are edits to `he.json` alone.

### Hebrew and RTL is complete, and how it was verified

- **Measured first** (2026-10-01, read-only): ~640 hard-coded strings in 44 files; 120 physical
  direction classes in 12 files and none logical; `formatMoney` defaulting to en-US with a
  hand-built `formatPercent`; dates hard-coded `en-GB`; 8 back arrows and a chevron that point.
- **Slice 1 (#142):** the English pages looked identical; RTL checked page by page in Chrome at
  desktop and 375 px with `?dir=rtl` (since removed).
- **Slice 2 (#143):** the visible text of every page (dashboard 347 lines, admin 690, holding
  287, ...) compared line by line between the branch and `main`, both served against the same
  live API; identical apart from relative ages. Two intended English changes: real plurals for
  "row(s)" and a snooze bug ("snoozed, back in expiring now").
- **Slice 3 (#144):** Hebrew chosen and saved in Settings switched the page at once; every page
  checked in Hebrew at desktop and 375 px against a copy of the live database. Five faults found
  and fixed on screen (the reversed range, names' full stops, the Ask examples' question mark,
  English admin reasons, the snooze/reject clash). CI caught the missing seed row.

### M3 is complete, and how it was verified

Every slice was verified by running it against the real database and, where it mattered, the real
embedding endpoint — not by reading it and not only by the hermetic suite, which structurally
cannot reach any of the SQL. What exists end to end:

- **The corpus** (`data/corpus/concepts/`, 9 documents, CC0), hash-compared ingestion that moves
  no chunk id on an unchanged run, and concept chips that open the document behind them (#42).
- **Hybrid retrieval**: `vector(1536)` sized for `openai/text-embedding-3-small`, `BaseEmbedder`
  and `VectorStore` behind Protocols, RRF over pgvector cosine and Postgres full-text, with the
  lexical half strict when the vector half is semantic and wide when it is the fixture (#44, #45).
- **`POST /ask`**: intent routing, citations quoted verbatim, a three-state relevance floor, three
  named ways to decline plus `advice`, arithmetic-only portfolio answers, and a hedge in the text
  of every weak match (#46, #47).
- **The eval set**: 35 cases in `data/eval/ask.json`, held out from the thresholds, run by
  `scripts/run_eval.py` — 16 keyless on every PR, all 35 when `OPENROUTER_API_KEY` is a repo
  secret. Last keyed run: **35/35**; last keyless: **16/16**.

The paid embedder is live in *this* installation's database and costs about a hundredth of a cent
per full re-embed. A fresh clone and CI use the keyless fixture, on purpose.

### Previewing a worktree's web app against the live stack

The stack's orchestrator allows browser requests only from `127.0.0.1:5174`, and its images are built
from the main checkout, so a worktree's UI change is invisible there. What worked (task 3): a
native orchestrator on **8083** with `SCHEDULER_ENABLED=false TELEGRAM_UPDATES=off
TELEGRAM_BOT_TOKEN=`, `ALLOWED_ORIGINS=http://127.0.0.1:5179`, `REDIS_URL=redis://127.0.0.1:6379`
and `DATABASE_URL`/`AI_SERVICE_URL` pointed at the host ports; and `vite --port 5179` with
`VITE_API_BASE_URL=http://127.0.0.1:8083`. The session cookie is per host, not per port, so the
in-app browser's existing sign-in carries over and nobody types the passphrase. A
`.claude/launch.json` for `preview_start` is **not gitignored** - delete it before committing.

**The recipe as rebuilt in the M6 session (worked all session):** two tiny scripts in the session
scratchpad, named in `.claude/launch.json`, and `.claude/launch.json` added to
`$(git rev-parse --git-common-dir)/info/exclude` so it can never be committed. The orchestrator
script does `set -a; source /Users/a/projects/Traders/.env; set +a`, exports the overrides above
plus `ORCHESTRATOR_PORT=8083` and `DATABASE_URL=postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:55432/$POSTGRES_DB`,
then `cd apps/orchestrator && exec pnpm start`; the web script runs
`VITE_API_BASE_URL=http://127.0.0.1:8083 pnpm exec vite --port 5179 --strictPort --host 127.0.0.1`.
Pitfalls that cost time: **a new worktree needs `pnpm install`** before either starts;
`pnpm start` does **not** reload, so restart the orchestrator preview after editing its code (vite
does reload); the in-app browser pane counts as a **hidden page** when not in front, so TanStack
Query's interval refetches never fire there (prove intervals in a test instead); and a screenshot
of a scrolled page sometimes shows a blank band - measure with `getBoundingClientRect` instead.
**This Mac runs in `Asia/Jerusalem`; the containers run in UTC** - a native preview is the only
place a timezone bug shows (it is how #95's day-early dates were found).

### M5 is complete, and how it was verified

**Exit:** *a free-text topic resolves to a sensible confirmed instrument set and produces topic
observations; a rejected auto-proposal does not return within the rejection cooldown.*
- **Resolve, confirm, observe** - #53-#57, checked live against the real universe and embedder,
  including a race for the last topic slot; `topic_scan` writes `topic_move` findings.
- **A real theme proposed** - 2026-09-29, after the market feed (decision 60): "data center" and
  "bond yields" (confident), then "interest rates", "canadian imports", "anthropic ipo", "short
  interest" (weak; the last two are the debt table's). Seen on the Topics page, toggle included.
- **A rejection holds** - "canadian imports" rejected in the UI; the next run with a fresh run
  key recorded *matches rejected topic "canadian imports" by words* in `runs.stats`.

What the feed and discovery look like now: GDELT's raw files feed two filters (followed names;
market tags AND market words, minus named ticker networks and press-release wires); discovery
reads linked and market headlines over 7 days, drops one company's news (decision 59) and one
foreign country's press (decision 61), resolves at most 8, and proposes in two bands with two
caps (decision 62). Every phrase not proposed carries its reason in `runs.stats.notProposed`.

**How to reproduce a feed measurement (read-only):** download `https://data.gdeltproject.org/
gdeltv2/<YYYYMMDDHHMMSS>.gkg.csv.zip` for past slots into a scratch directory (~3 MB each, 96 a
day); parse as `app/news/gdelt.read_gkg` does (tab-separated, `csv.field_size_limit(sys.maxsize)`,
title from `<PAGE_TITLE>` in column 26, outlet column 3, URL column 4, themes column 8); keep rows
with `market_feed.is_market_headline` and not `is_excluded_outlet`; attach
`outlet_countries.load_outlet_countries(...)` codes to `Headline`s; call `recurring_phrases`, and
resolve the top phrases through the live `/topics/resolve`, which stores nothing. The scripts
lived in the session scratchpad and are gone - about 100 lines, all of them glue around those
functions.

### M6 is complete, and how it was verified

**Exit:** *every PRD user-facing FR reachable from the UI; no dead ends or unhandled error states.*
Checked 2026-09-30 against `docs/PRD.md`, FR by FR, in the running app:

| FR | Where it is in the UI |
|---|---|
| 1 import | Dashboard "Import": preview, per-row errors, confirm |
| 2 holdings CRUD | Add form; quantity edit and remove per row / card. **Cost basis is changed only by adding the symbol again** (the insert updates the holding) - a debt row, not a dead end |
| 3-4 instruments, valuation | Holdings table / cards, holding page: FX, P&L, price age and delay |
| 5 snapshots | "Value over time" (decision 66) |
| 6, 8 findings | Feed, paged and filtered (decision 71); holding page |
| 7 news | Holding page (decision 68); topic cards |
| 10-12 topics | Topics: resolve, confirm, suggestions from the news, tone |
| 13 digest | **Dashboard "Daily digest"** (decision 74) - the one gap the check found; and Telegram |
| 14-16 concepts, Q&A | Concept chips on every finding; `/ask` (decision 70) |
| 17-19 proposals | Inbox with history, `/proposals/$id` with the audit trail (decision 69) |
| 20-21 Telegram | Settings "Telegram"; the "Open in app" link waits for `WEB_BASE_URL` (M7) |

Error states: every query-reading component shows its failure (a sweep of every `use*Query` call
site, 2026-09-30); the dashboard's portfolio failure covers the summary, allocation and holdings;
the narration badge hides when unknown (the server already degrades to `unknown`). Dead ends: every
page links back, an unknown address is the portfolio, a stale holding or proposal link says so.

### M7 is complete, and how it was verified

**Exit:** *a clean deploy to a local kind cluster, a CronJob firing a real run, docs that let a
stranger run it.*
- **Clean deploy** - `bash scripts/k8s-up.sh` from nothing: on this Mac repeatedly (last from the
  main checkout at `a13f662`), from a fresh clone of #118's branch (1 min 58 s, warm build cache),
  and on a fresh Linux runner on every PR (`kubernetes (kind)`, ~4 min cold).
- **A CronJob fires a real run** - all nine on their own schedule, 11:51-12:16 UTC on 2026-09-30:
  13 Jobs owned by their CronJobs, 13 `runs` rows with `trigger = 'cronjob'` (backfill wrote 1,797
  real Yahoo closes). CI creates one from `run-proposal-sweep` on every PR.
- **Docs a stranger can follow** - the README's Kubernetes section followed literally in a fresh
  clone with no `.env`, no `secrets.env`, no descriptions: deploy, sign in with the printed
  passphrase, import the demo portfolio (10 of 10 priced at real prices). Two exceptions, stated:
  `brew install` could not be replayed (already installed), and the import made the dialog's two
  requests with curl (the in-app browser cannot pick files). Every runbook command was run first.

**Not proven, deliberately:** Telegram's webhook leg (debt table). **The user decided
(2026-09-30) to test it in a real cloud environment with HTTPS, not on the laptop** - do not set it
up through a tunnel. It needs `setWebhook` on the real bot (which stops any polling stack),
`getWebhookInfo` at once, `TELEGRAM_UPDATES=webhook`, `WEB_BASE_URL` for "Open in app", and the
signing secret different from the webhook secret (decision 20). The #98 crypto-close check (below) was
also still pending at the close.

### M8 is complete, and how it was verified

**Exit** (`docs/MILESTONES.md`, as reworded by decisions 85 and 89-91), checked 2026-10-01 on the
running systems, not only in tests:
- **A non-admin session gets 403 on every `/admin/*` route.** `adminGuard.test.ts` enumerates
  `app.routes`; the kind CI job demotes the admin. Live in kind: all six routes (five reads and
  `POST /admin/universe/rescreen`) answered 200 as admin and **403 with the same cookie** after
  `UPDATE users SET role='user'`; the role was restored.
- **The rescreen button and the CronJob produce the same single run.** Kind: the button's run
  `universe-rescreen:2026-10-01` (ok, 22 dropped); the CronJob's own tick, a Job made from it,
  and a later button press all answered *already claimed (ok)*; one rescreen row in `runs`.
- **The panel shows per-agent latency, tokens, cost and fallback reasons from real calls.**
  Compose: narration 3 calls (2 accepted, 1 unsourced), p50/p95 5.7 s / 34.1 s, 1,507/293
  tokens, "free route"; ask 1 call; the reconciliation agreed reason by reason (2/2, 1/1); TTFT
  and cache hit rate stated as unmeasured.
- **A searched missing ticker appears as a gap event and is profiled within one fetch.** Compose
  (#127): an import preview of BYND and GPRO profiled both within a second; SAP.DE, outside the
  screen, was not fetched; "plant-based meat" still resolved without them.

### Next session: Hebrew and RTL (history - done by #142-#144)

The user asked for it on 2026-10-01, after the queue. **Ask for a grant first** (the last one ended
with #140). Then, in the order the user's working agreement asks for (measure, decide, build):
1. **Measure, read-only.** Hard-coded UI strings in `apps/web/src` (JSX text, `aria-label`,
   `title`, `placeholder`, error fallbacks such as `errorMessage(..., 'Could not ...')`); left/right
   assumptions in Tailwind classes (`ml-`/`mr-`/`pl-`/`pr-`/`left-`/`right-`/`text-left`/
   `text-right`, `-mx-4`...) against their logical forms (`ms-`/`me-`/`ps-`/`pe-`/`start-`/`end-`/
   `text-start`); number, money, percent and date formatting (`formatMoney`, `formatPercent`,
   `relativeTime.ts`) and which locale they use; charts (Recharts axes) and the icons that point a
   direction (chevrons, arrows). Server-produced text the UI shows - observation headlines and
   explanations, Telegram messages, the digest - is a separate question: it is generated in
   English by templates and validated by the evidence validator.
2. **Decide with the user**, a recommendation each: the CLAUDE.md guideline-1 amendment (proposed:
   code, comments, docs and commits stay English; UI copy is translatable with English the
   default); a library (`react-i18next` is the common choice; formatting through `Intl` with the
   chosen locale) or none; whether Hebrew covers server-generated text in v1; where the language
   setting lives (`user_settings`, so Telegram and the digest can follow it).
3. **Build in slices**, one PR each: the RTL-safe layout first (logical classes, `dir` on `<html>`),
   which is invisible in English and testable at 375 px in both directions; then extraction of
   strings; then Hebrew.
After that, the likely next milestone is the multi-agent sandbox (`docs/PROPOSAL-MULTI-AGENT.md`
stages 1-3, an approved spec, unbuilt); the `queries.ts` split was done first partly for it.

### Next session: the post-M8 queue, continued (history - done by #140)

Tasks 12-15 remain in "Independent tasks queue", in the approved order. **The grant ended with this
handoff; ask the user again** (last time: one PR per task, merge on green, verify on `main` by
content, rebuild compose and kind). Notes for each, from reading the code this session:
- **12, a dead rescreen across days:** `claimRun` reclaims a stale heartbeat only under the same
  run key; the one-running partial index (0031) blocks a new day's key while yesterday's dead run
  holds it. The hourly CronJob's ask is the natural place to reclaim it.
- **13, `secrets.env` recovery:** `docs/RUNBOOK.md` section 1 has the commands; `k8s-up.sh`
  already upgrades a file in place (#133), so it now has a "file exists" and a "file missing" branch
  - recovery belongs in the second, before generating anything.
- **14, close a decided proposal's workflow** on the direct-apply fallback path.
- **15, split `queries.ts`:** decided by the user; amend CLAUDE.md's rule in the same PR. Pure
  move. Do it last in the queue so 12-14's SQL lands before the move.
Then **Hebrew and RTL**: measure first (hard-coded strings in `apps/web`, left/right assumptions
in Tailwind classes such as `ml-`/`pr-`/`text-left`, number and date formatting), then bring the
guideline-1 amendment and a design to the user. After that the likely next milestone is the
multi-agent sandbox (`docs/PROPOSAL-MULTI-AGENT.md` stages 1-3; approved spec, unbuilt).

### Next session: after M8 (history - the user chose the debt sweep, 2026-10-01)

`docs/MILESTONES.md` has no milestone after M8. **Ask the user what comes next**, with a
recommendation; the options as they stand:
1. **A debt sweep into the independent-tasks queue** (it is empty), the way it was done on
   2026-09-28 - the debt table has grown through M8 (ReadWriteOnce volume, a dead rescreen waits
   for a trigger, on-demand profiles never refreshed, the `:free`-suffix rule, the 0.007 topic
   gate). Recommended first: it is how the last queue was built, and it is cheap.
2. **The items deliberately left out of the queue** ("Not in the queue, and why"): everyday-word
   company names, ", LP" names, citing news in observations, splitting `queries.ts` - each was
   held for the user's decision or for data.
3. **A real deployment** (decision 20's signing secret, Telegram's webhook leg, ReadWriteMany
   storage or a pinned rescreen node) - a new milestone the user would write.
Also open: **rescreening compose** (ask; or let it fall due on 2026-12-24).

### Next session: M8, continued (history - superseded by "M8 is complete")

**Where M8 stands** (2026-09-30 ~22:40 UTC): PRs 1-5 of the agreed ten are merged (#120-#124).
The #98 check is done (see the header). Before any code this session measured the running system
read-only and found **six things that changed the plan** - every one is now a decision or a PR:
1. no server-side session exists (the cookie is signed, uid only) -> decision 83;
2. the app's DB role is a superuser -> `REVOKE` is void -> triggers, decision 84, debt row;
3. `/internal/runs` executes inside the request and `STALE_RUN_MINUTES = 30` would **reclaim a
   live ~1 h rescreen and start a second** -> PR 8;
4. the `universe` container re-ingests the committed snapshot on every start, replaces ETF
   holdings from the file and never deletes a profile -> **a runtime rescreen would be half
   undone by the next restart** -> PR 8;
5. a missing ticker is already priceable (lookup asks Yahoo live); it lacks a *profile* -> PR 7
   and the exit wording;
6. model calls happen on compose (OpenRouter key; ~45 narrations/week) -> the panel's exit is
   shown on compose, not in the keyless cluster.

**The eight decisions the user accepted ("recommendations", 2026-09-30):** (1) role read from the
DB per admin request; (2) `admin_audit` append-only by trigger; (3) the rescreen runs async - the
endpoint answers 202, the AI service runs it in the background with a `runs.heartbeat_at`, a run
is dead only when its heartbeat is stale, and a DB rule allows one running rescreen; the fetch
cache makes a killed copy resumable; (4) run key `universe-rescreen:<date>` for **both** the
button and the CronJob (the plan's `<quarter>` for the CronJob could never be "the same single
run" as a click); (5) the rescreen writes a complete snapshot to a **writable volume** (a
PersistentVolumeClaim in kind), the loader loads whichever snapshot is newest by `as_of` - image
or volume - never an older one over the DB, and dropped listings become `membership='dropped'`
(holdings reference instruments, so no delete); the committed snapshot stays the fixed input for
CI and the eval; (6) the fast path fetches a **profile** in the background, marked
`membership='on_demand'`, excluded from topic resolution, and the exit is reworded to "profiled
within one background fetch"; (7) universe status against the loader's own counts - done, #123;
(8) `llm_calls` via a factory wrapper - done, #124.

**Next, in order, one branch off `main` each:**
- ~~PR 6 - the LLM panel~~ **Done, #126 (decision 88).** Measured first on compose (30 Sep
  22:21 UTC): `llm_calls` held **one** row (the #124 `/ask` demo) - narration only calls on a
  *new* finding, ~45 a week - and 45 observations carried a reason (17 unsourced, 16
  provider_error, 10 model-written, 2 malformed; 28 older ones none). Shown on compose data
  through a native preview: the ask row as "free route", 14.3 s, and the 30-day history equal to
  the measurement. **The reconciliation had no narration call to show yet** - the first scan
  that narrates a new finding is the one to look at (`/admin`, "Model calls"). The original plan
  for the PR: `GET /admin/llm` + a card: per agent - calls, p50/p95 latency, tokens,
  cost (say "free route" when the model id ends `:free`, debt row), outcomes and verdicts;
  fallback reasons for narration from `observations.fallback_reason` beside `llm_calls.verdict`
  (the milestone asks for that query, not a new log). Say plainly that TTFT and semantic-cache
  hit rate do not exist (no streaming, no cache) rather than showing zeros. **This closes the
  panel exit condition** - show it on compose.
- ~~PR 7 - the on-demand profile fetch~~ **Done, #127 (decision 89)** - including a change to
  the plan below: on-demand profiles are counted apart on the status card, not shown as a
  negative remainder. The original plan: `instrument_profiles.membership`
  (`screened`/`on_demand`/`dropped`), a background fetch when a gap event is `not_in_universe`
  (BYND and GPRO are live examples), excluded from `search_profiles`; update the exit wording in
  `docs/MILESTONES.md`. The status panel's negative remainder (decision 86) is how an on-demand
  profile shows - say so on the card.
- ~~PR 8 - the rescreen run~~ **Done, #128 (decision 90)** - shown in kind; **compose has not
  been rescreened** (it rewrites the real universe: ask first). Original plan (decisions 3-5): `universe_rescreen` run kind (a migration of
  `runs_kind_check` - use the `KINDS`/`PREVIOUS_KINDS` pattern `test_run_kinds_contract.py`
  reads), `runs.heartbeat_at`, the 202 path, the volume, the newest-snapshot rule in
  `ingest_universe.py`, the button on the Admin page, and **the first real `admin_audit` row**.
  Measure the build's real duration first (the ~1 h is the plan's figure, not a measurement).
- ~~PR 9 - the quarterly CronJob~~ **Done, #129 (decision 91)** - hourly asks, due by snapshot
  age. Original plan: the quarterly CronJob, in `cronjobs.yaml` **and** `scheduler.ts` (or
  `cronJobContract.test.ts` fails); prove the button and a CronJob-made Job claim one run.
- **PR 10 - exit check and M8's closing handoff.**

**Conventions this session relied on:** all admin routes live in `http/routes/admin.ts` and are
guarded and audited by being there; the Admin page is `/admin` in the web app (`/api/admin/*` on
the wire). Admin writes are POST under `/admin` - the gate audits them before they run. A
migration constant named `KINDS` is read as a run-kind migration by a contract test; name others
differently (0027 uses `EVENT_KINDS`).

How M6-M8 worked, and it held up: **measure first** (read-only, on the running system), then
propose with a recommendation per decision, then one PR per change, each proven live (kind for
most, compose where keys or real data matter) before its PR is opened. Never click a real
decision or save real settings; never touch the real Telegram bot without asking.

### Next session: M8 (history - superseded by "Next session: M8, continued")

What M7 left for M8: `/internal/runs` + a CronJob is the pattern for the quarterly rescreen; the
rescreen needs somewhere outside the image for the licensed descriptions it fetches; a new admin
page reaches the orchestrator through `/api/*` like every other.

### M7, continued (history - superseded by "M7 is complete")

**Where M7 stands** (2026-09-30 ~12:30 UTC): PRs 1-5 of the agreed seven are merged (#109-#113).
The plan and every decision behind it were agreed with the user at the start of the session -
"recommendations" to all seven: clean cluster DB + demo import; keyless providers; Telegram off
in the cluster (webhook leg only as an opt-in last PR, **with the user's explicit go-ahead**); HPA
on the AI service only; Kustomize; a standard Ingress served by Traefik; a kind job in CI.

**Next, in order, one branch off `main` each:**
- ~~PR 6 - the AI service's HorizontalPodAutoscaler~~ **Done after the handoff, in the same
  session** (decision 82): metrics-server v0.9.0 from its pinned release manifest plus
  `--kubelet-insecure-tls` (`infra/k8s/kind/metrics-server/`), an HPA of 1-3 copies at 70% of the
  `100m` request, and no `replicas` on the Deployment. Shown scaling under load and back.
- ~~PR 7~~ **Split in two after the handoff, same session.** PR 7 (#116): the `kubernetes (kind)`
  CI job - `k8s-up.sh` on a fresh Linux runner, the front door, `/internal` refused, a
  CronJob-made Job recording a run; first run green in 4 minutes. PR 8: the root README
  (Kubernetes section, a mermaid architecture diagram, cost notes), `docs/RUNBOOK.md`,
  `docs/DECISIONS.md` (generated from this file by `scripts/build_decision_index.py`; a test
  fails when it is stale - **re-run the script after adding a decision here**), and the
  stranger test. Between them, a measured fix: the autoscaler's one-minute scale-up window
  (decision 82).
- (original plan, kept) **PR 7 - documentation a stranger can follow**: root README with an architecture diagram, the
  runbook (rotate keys, replay a run, recover a stuck proposal), an ADR index over "Decisions",
  cost notes. **The kind CI job** (debt row) fits here or in PR 6. **Verify by following the README
  literally** in a fresh clone with a deleted cluster.
- **Optional PR 8 - Telegram's webhook leg**, only if the user says so (a tunnel, `setWebhook`,
  `getWebhookInfo` at once, `TELEGRAM_UPDATES=webhook`; decision 20: the signing secret differs
  from the webhook secret). Otherwise it waits for a real deployment.
- Then M7's closing handoff.

**The #98 check (from the M6 handoff) is not done yet.** At 10:14 UTC on 2026-09-30 exactly two
future-dated rows existed (BTC-USD, ETH-USD at 2026-09-30 20:00), both from the 06:45 run; the
07:18 run on #98's code wrote none. The first backfill able to repair them fires at the first
hourly tick after 21:00 UTC (the daily bucket is the user's local date). Run the query below after
that; expect crypto's 30 Sep close to be a ~21:00 price until the next night (debt table).

**Previous text of this section (M6's handoff), kept for the query and the M7 list:**

**First, a two-minute check left from #98:** a 06:45 UTC backfill on 2026-09-30 wrote BTC-USD
and ETH-USD rows dated **2026-09-30 20:00 UTC** (in the future then). #98 stops new ones and makes
the backfill replace its own rows, so the first scheduled backfill after 30 Sep 20:00 UTC should
have rewritten both with the finished day's close. Confirm with
`SELECT i.symbol, q.as_of, q.price_minor FROM quotes q JOIN instruments i ON i.id = q.instrument_id
WHERE q.as_of::date = '2026-09-30' AND q.delay_seconds = 0` and `runs` (`kind = 'backfill'`,
`stats->>'written'`); nothing dated after `now()` should exist. If the stack was down all night,
run a manual backfill (`POST /internal/runs {"kind":"backfill"}`) - it is idempotent.

**M7** (`docs/MILESTONES.md`): manifests, image pipeline, migration ordering, a one-command kind
cluster, and a README a stranger can follow. **Exit:** a clean deploy to a local kind cluster, a
CronJob firing a real run, docs that let a stranger run it. Start from `infra/k8s/README.md`, which
already lists the two rules the manifests must keep (`SCHEDULER_ENABLED=false`; the orchestrator
at `replicas: 1` while import previews live in memory). What else the cluster must carry, all
already decided here:
- **every container the compose stack runs**, not only the three services: `migrate` (Alembic,
  before anything starts), `corpus` (re-ingest on every start - see CLAUDE.md), `universe`;
- **CronJobs for every run kind** the local scheduler offers (`scheduler.ts`: backfill first, then
  the scans, the sweep, and the digest last - the order is argued there), posting to
  `/internal/runs` with `x-internal-key` - the same single trigger path;
- **the first real test of Telegram's webhook leg** (debt table): once an Ingress gives a public
  https URL, `setWebhook`, then `getWebhookInfo` for `last_error_message` at once; switch
  `TELEGRAM_UPDATES` to `webhook` (never both - Telegram refuses);
- **`WEB_BASE_URL`** set to that https origin turns on the "Open in app" link (decision 69);
- **decision 20:** `TELEGRAM_SIGNING_SECRET` must differ from the webhook secret, in the Secret too.

How M6 worked, and it held up: **measure first** (read-only SQL, the live endpoint, the browser at
1280 and 375 px), then decide, then build; each correctness bug went in as its own PR ahead of the
screen that exposed it, and four of five were found only by measuring live data. **Never click a
real decision or save real settings**; pin the request with a test instead.

**CI note:** a `docker compose smoke test` failure inside `corepack` downloading pnpm (an undici
`assert(!this.paused)`) was transient on #93; `gh run rerun <id> --failed` passed. Check the PR does
not touch dependencies before assuming that.

Standing permissions do not carry across sessions: ask again about merging, rebuilding, deleting
data and acting in the UI.

### Left unfinished, deliberately

The **notification on narration state change** is now built (independent task 2, decision 58) and was
verified with a real message in the bound chat on 2026-09-28, not only to the ledger.

Whichever is next, the seams M4 leaves are: `notifications.ref_kind` already anticipates a third
referent, `Notifier` takes another channel without touching the fan-out, and `PROPOSABLE_KINDS` in
`services/proposals.ts` is the entire policy for what becomes a question — one map, deliberately
short, and the place to argue about before adding to it.

**Before the first real deployment**, read decision 20 and set `TELEGRAM_SIGNING_SECRET` to a value
that is not the webhook secret. An unset signing secret degrades to a null notifier with a stated
reason rather than booting broken, so the mistake is visible — but a *shared* value would not be.
