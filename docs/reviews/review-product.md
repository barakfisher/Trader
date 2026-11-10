# Review — Product, design and user journey (2026-11-10)

Reviewed from source and documents only (read-only, stack not run). Catalogue references are
`apps/web/src/i18n/locales/en.json:<line>` with the key quoted. Anything that needs the running UI
is listed under "Needs eyes on the UI".

## Summary (5 lines max)

- The product is trustworthy by construction (evidence checks, "unpriced" honesty, undo, audit trail) but it is still shaped for its owner: a stranger gets no pitch, no first-run path and a hidden paid prerequisite.
- The "aha" (an agent proposes a trade you approve) sits behind about ten steps, an external paid account, and a scan that ends in "No trade" 84% of the time.
- Retention rests on Telegram alone, and the daily digest carries counts, not content or a link back.
- Copy is precise but long, uses several words for one thing, and in a few places contradicts what the product now does (Ask, research language, tab names).
- There is no product analytics at all; before public signup I would build onboarding, the digest and five metrics ahead of deeper agent work.

## The first-run journey, step by step

| # | Step | What the user meets | Friction / dead end | Evidence |
|---|---|---|---|---|
| 1 | Arrive signed out | The sign-in form is the landing page. Pitch: "Portfolio copilot. Sign in with your email and password." | No explanation of what TikLens is, no picture, no reason to join. | `login.intro` en.json:23; `LoginPage.tsx:45`; `index.html:10-11` |
| 2 | Sign up | "New here? Ask to join". Email, password twice, legal checkbox, time zone read from the browser. Intro: "Depending on this installation, you get in at once or the admin approves you." | The user is told the outcome is unknown; "installation" and "admin" are self-hosting words. | `login.askToJoin` :35; `signup.intro` :44 |
| 3 | Email | "Check your email", 24-hour link. | Fine; spam hint present. | `signup.received` :50 |
| 4 | Open the link | Types the password a third time, presses Confirm (D309). | Wait for the mail; no auto-continue. | `verify.confirmSignup` :95-98; `VerifyPage.tsx` |
| 5 | Confirmed | "Your account is ready. Sign in with your email and password." Verification signs nobody in (D259). In approval mode: "Your request is with the installation's admin." | Password typed a fourth time. In approval mode an open-ended wait, with no promise of an email when approved. | `verify.activated` :65-68; `verify.awaiting_approval` :69-72 |
| 6 | Legal gate | Only for Google sign-ups or a new version; email sign-ups accepted at step 2. | Fine. Decline path (export, delete) is good. | `LegalAcceptancePage.tsx:40-80` |
| 7 | Empty dashboard | "No holdings yet. Import a CSV or JSON file from your broker, or add a position by hand. The demo portfolio in data/fixtures/demo-portfolio.csv works with no API keys." Import button + add-holding form. | Developer copy (a repository path). Nothing about agents, Telegram or the key. No "what happens next". | `dashboard.emptyBody` :981; `DashboardPage.tsx:135-147` |
| 8 | First holding | Symbol search, quantity, cost; price prefilled. Dashboard fills in. | Good. But the first finding arrives only when a rule fires; a calm day shows "Nothing to report" (well worded). The equity curve starts after the first daily close. | `addHolding.*` :158-178; `feed.quietBody` :534; `equity.coverage.none` :238 |
| 9 | Discover agents | Agents page lists only "Main portfolio" plus a warning bar: scans "run on your own OpenRouter API key, and none is saved". | First mention of the key. No link to OpenRouter, no steps, no cost estimate. This is where most strangers leave. | `ownKeyNotice.no_key` :2118; `AgentsPage.tsx:96`; no `openrouter.ai` URL in `components/` or `pages/` |
| 10 | Get a key | Leave the app, create an OpenRouter account, add credit, make a key, paste it in Settings. | Unguided, off-site, paid. | `settings.ownKey.intro` :1170 |
| 11 | Create an agent | Drawer: name, paper budget, template, risk, horizon, thesis style, three limits, ETFs, company size, sectors, blocked tickers, instructions. | A long form before any value. Templates help. | `agents.fields` :1496-1502; `agents.mandate` :1816-1880 |
| 12 | Agent page | Opens on the Holdings tab: "Nothing held yet. Use Trade to buy into this agent's paper account." | The empty state points at manual trading; "Run a scan now" is on the Scans tab (or the row action on the list). | `agents.holdingsEmpty` :1545-1548; `AgentPage.tsx:53,62` |
| 13 | First scan | "Scanning… this takes up to a minute." Cost shown beforehand. | Wait has feedback. Outcome is usually "No trade: nothing fit the persona today." Measured: 66 of 79 scans passed, 0.11 proposals per scan. | `agents.scans.running` :1682; `result.no_trade` :1691; `docs/PROPOSAL-AGENT-PERFORMANCE.md:306-310` |
| 14 | First proposal | Thesis, "Evidence checked", price distance, paper-only and not-advice lines. Approve checks the live price, then Confirm. | Works only while the US market is open; expires 60 minutes after it (or after the next open). 4 of 9 baseline proposals expired unanswered. | `proposal.trade.*` :645-731; `tradeProposals.ts:48-54`; PROPOSAL-AGENT-PERFORMANCE.md:310 |
| 15 | Connect Telegram | Optional, in Settings; never suggested during the journey. | Without it nothing is ever pushed, so step 14's deadline is easy to miss. | `telegram.notConnected` :765 |

Count: about 10 actions, 2 waits on other people or systems (email, optional admin approval), 1 off-site paid sign-up, and on average several scans before the first proposal.

## What is strong and should stay

- **Honesty as a feature.** "unpriced" instead of zero (`summary.unpriced` :750), "understated" snapshots (`equity.understatedDetail` :234), "No cost basis" left out rather than counted as profit (`summary.uncostedNote` :754), quiet days explained as normal (`feed.quietBody` :534). This is the product's real differentiator.
- **Evidence on proposals.** "Why the agent proposes it", "Evidence checked: …", the agent's price against the live price, refused approvals listed with reasons (`proposal.trade.checked` :650-670; `proposalPage.attempts` :1052-1066).
- **Agent scored against SPY with the same deposits**, and hand trades excluded from the agent's own score (`agents.performance` :1648-1677).
- **Undo, snooze, re-check** (D212, D215) and idempotent Telegram buttons; costs shown before a paid action (`agents.scans.runCost` :1683, `research.cost` :2209).
- **Disabled with a reason, never hidden** (D368) and error strings that mostly say what to do next (`proposal.trade.errors` :687-695).
- **Telegram menu** (M11): views that edit in place, signed deciding buttons, `/pending` to decide in chat.
- **Account lifecycle**: export, 7-day deletion grace, device list, decline path on the legal gate.
- **i18n discipline**: typed catalogue, logical directions, `bdi` around LTR values.

## Findings (ranked)

### 1. The own-key requirement is a hidden wall in front of every AI feature — High
- **Evidence:** D245, D280. `ownKeyNotice.no_key` en.json:2118 is rendered on Agents, Ask, Research and the scan card (`AgentsPage.tsx:96`, `AskPage.tsx:77`, `ResearchPage.tsx:169`, `AgentScans.tsx:107`) but not on the dashboard. `settings.ownKey.intro` :1170 explains storage and billing, not how to get a key. No OpenRouter URL exists in `apps/web/src/components` or `pages`.
- **User experiences:** signs up for "AI agents", lands on a portfolio tracker, and only on the Agents page learns they must open a paid account elsewhere. No guidance, no estimate of what a month costs.
- **Proposal:** I agree with D245 (strangers do not spend the owner's money). D280 ("told up front, where the work would start") is too late: say it on the sign-up screen and in a first-run checklist. Add a three-step guide with a link, a typical monthly cost from `llm_calls`, and the safety limit as part of the same step. Decision for the owner: a small trial allowance on the installation key (for example three scans and ten questions) so the aha comes before the paywall.
- **Effort:** S for copy and guide, M with a trial allowance.

### 2. There is no first-run path — High
- **Evidence:** `dashboard.emptyBody` :981 (names `data/fixtures/demo-portfolio.csv`); `DashboardPage.tsx:135-147` offers only import and add-holding. No onboarding, welcome or checklist code exists (grep over `apps/web/src`). FLOWS F1 still ends at "Dashboard live". Ask's own example "Give me a tour in the app" (`ask.examples.tour` :880) needs the key.
- **User experiences:** an empty table and a sentence about a file they do not have. Agents, Research, Ask and Telegram are discovered by clicking around.
- **Proposal:** a dismissible "Get started" card on the dashboard with four states read from existing data: add holdings (or "Load the demo portfolio" as a button), connect Telegram, add a model key, create a first agent. Replace the fixture path with that button.
- **Effort:** M.

### 3. The aha moment is far away and mostly ends in "No trade" — High
- **Evidence:** 66 of 79 scans passed, 0.11 proposals per scan (`docs/PROPOSAL-AGENT-PERFORMANCE.md:306-310`). `agents.scans.result.no_trade` :1691: "No trade: nothing fit the persona today." A new agent's page opens on Holdings with "Use Trade to buy into this agent's paper account." (:1545-1548; `AgentPage.tsx:53,62`).
- **User experiences:** pays for a scan, waits up to a minute, reads one line saying nothing happened. Repeats, or leaves. The page's first suggestion is to trade by hand, which is not what they came for.
- **Proposal:** after creating an agent, land on the Scans tab with "Run the first scan" as the primary action. Make a pass worth reading on the result line itself: what it looked at, the closest candidate and what was missing (the transcript already has this under "Decisions"). Consider a first-scan mode that always returns a short watchlist, clearly not a proposal.
- **Effort:** M.

### 4. Retention depends on Telegram, and the digest says almost nothing — High
- **Evidence:** digest title and body are counts: "Daily digest: 3 findings" plus "3 below your alert threshold" (`messages.ts:1084-1100`; `services/notifications.ts:380-391`, whose comment says figures are deliberately not restated). A notification gets buttons only when it has a `proposalId` (`telegram/client.ts:153-177`), so a finding alert or the digest has no "Open in app". FLOWS F7 promises "portfolio delta and equity curve, top N observations, pending proposals". Email is used for account mail only; D391 ships no service worker, so no web push. `telegram.notConnected` :765: "nothing is pushed to you."
- **User experiences:** without Telegram, the product is silent and proposals expire unseen. With it, the digest is a number that requires opening the app by hand to learn anything.
- **Proposal:** digest = today's value and change (already built for `/portfolio`), the top three findings by their stored, already-validated headlines, proposals waiting, and one "Open in app" button to `/insights?tab=digest`. Add "Open in app" to every finding alert, deep-linked to the holding. Add an email digest as a second notifier behind the existing interface. Prompt for Telegram in the first-run card.
- **Effort:** M.

### 5. A stranger is never told what this is — High
- **Evidence:** `login.intro` :23 "Portfolio copilot. Sign in with your email and password."; `login.askToJoin` :35; `signup.title` :43 "Ask to join" even in automatic mode; `signup.intro` :44; `login.errors.notActive` :32 "Ask the installation's admin."
- **User experiences:** a login box with a product name. "Ask to join" reads as a private club; the outcome of signing up is stated as unknown.
- **Proposal:** a public page above the sign-in form: one sentence of promise ("See why your portfolio moved, and test investing styles with paper money before you risk your own"), three proof points (never places orders; every figure checked; you approve everything), one screenshot. Make sign-up copy follow the mode ("Create account" when automatic). Lead with "Continue with Google", which skips the four password entries (signup twice, verify D309, sign-in D259). I agree with D309's reasoning; I would revisit D259 for the one case where the password was just proven on the verify screen.
- **Effort:** M.

### 6. Copy contradicts current behaviour in trust-critical places — Medium
- **Evidence:**
  - `ask.intro` :877 "it never tells you what to buy or sell" against `ask.draft.headline.buy_more` :909 "The assistant suggests: buy more {{symbol}}" (D393).
  - `settings.languageHint` :1159 "News, research reasons and concept explanations stay in English" against `services/ai/app/research/run.py:143` ("Write the rationale and the findings in {language}") and D392.
  - `digest.more` :205 "all on the Observations tab" while the tab is "All findings" (`insights.tabs.observations` :2031).
  - "Decisions tab" in `agents.intro` :1475 and Telegram (`messages.ts:763, 1027, 1031`), while the tabs are Holdings, Performance, Activity, Scans, Settings (:1538-1544).
  - `proposals.emptyBody` :1025 "When a finding needs a decision, it appears here. You can change what qualifies in Settings." Proposals now also come from agents, research and Ask, which Settings does not govern.
- **User experiences:** a promise on the Ask page that the next reply breaks; directions to tabs that do not exist.
- **Proposal:** fix the five strings (and Hebrew). Add a catalogue test that every tab or page named in a sentence is a real label.
- **Effort:** S.

### 7. Several words for one thing — Medium
- **Evidence (keys):** finding / observation / alert / insight (`feed.title` :519 "Observations", `insights.tabs.observations` :2031 "All findings", `holding.findings` :1008, `alerts.title` :2035). Persona / instructions / mandate / settings / limits / rules / brief (:1500 "Additional instructions", :1691 "persona", :1817 "Mandate", :697 "Outside the agent's limits", :1768 "Broke the rules", :1678 "Waiting for instructions or settings"). Simulated / paper / virtual ledger (:1480, :1498, `messages.ts:663`). Model budget / AI budget / AI spending / safety limit / spend limit / ceiling (:1748, :1098, :893, :1199, :784, :438). Pending / Open / waiting on you (:614, :1946, :1024). Main portfolio / real portfolio / Portfolio (:1478, :2073, :961). "Approve" for both a paper fill and an acknowledge-only view (:642, :733).
- **User experiences:** has to work out whether a mandate, the settings and the rules are three things; "Approve" on a real-portfolio research view feels like committing to a trade.
- **Proposal:** a twelve-term glossary in the repository, applied across both catalogues and `messages.ts`. Suggested canon: finding, alert (a pushed finding), proposal, instructions + limits, paper (adjective), AI budget (per agent, daily) and safety limit (per account, monthly), "waiting for you". Label acknowledge-only proposals "Noted" or "Got it" rather than "Approve".
- **Effort:** M.

### 8. Navigation: the one thing with a deadline is a sub-tab, and Research is a top-level place — Medium
- **Evidence:** places are Portfolio, Insights, Agents, Research, Ask (`components/places.ts:36-43`; five on the phone's bottom bar, `BottomBar.tsx:36`). Proposals live at `/insights?tab=proposals` (D134; `router.tsx:86-93`). Research needs "an agent you choose" as its lens (`research.intro` :2199, `research.noAgents` :2206, text with no link, `ResearchPage.tsx:163`), and its rating is already a dashboard column (D254).
- **User experiences:** "Insights" holds what I was told, what I must answer, the digest and everything else; the answer-by-deadline list is the second tab. Research, Agents and Ask each produce proposals, which is hard to hold in the head. Research has three vocabularies (Buy more/Hold/Trim/Sell; Buy/Wait/Avoid; Bullish/Bearish/Neutral, :2238-2248).
- **Proposal:** I agree with D134's tabs but not with the name or default: rename Insights to "Inbox", open it on Proposals whenever one is open. Fold Research into the portfolio (the Rating column plus the holding page) and keep its settings under the main portfolio's agent page; that frees a bottom-bar slot. Add a link in `research.noAgents`. Retire the unused rating words.
- **Effort:** M.

### 9. The dashboard opens on real money and paper money added together — Medium
- **Evidence:** D229, D231; `DashboardPage.tsx:40-57`; `combined.breakdown.hint` :2067 "The cards add your real portfolio and your agents' paper holdings together."
- **User experiences:** "Total value" on the first screen of a financial product is a figure nobody holds; the split is a click away. The charts below are real-only (`combined.chartsAreReal` :2056), so one page mixes two bases.
- **Proposal:** I disagree with D231 as the default for public users. Open on Real; show simulated agents as their own strip ("Paper accounts: $X across N agents"). Keep "All" as a choice and remember it per user.
- **Effort:** S.

### 10. Disclaimers stack until they stop being read — Medium
- **Evidence:** a trade proposal carries `proposals.ledgerOnly` :1021 (inbox), `proposal.trade.paperOnly` :648, `proposal.trade.notAdvice` :649 and the page footer `disclaimer` :20 (`TradeProposalCard.tsx:122-123`, `ProposalPage.tsx:102`). The Research page renders `<Disclaimer />` and `research.notAdvice` back to back (`ResearchPage.tsx:74-75`). Five near-identical sentences: :649, :734, :739, :905, :915, :2200.
- **User experiences:** three or four grey paragraphs saying "not advice / no order" around every decision; the one that matters (paper only, live price) is lost among them.
- **Proposal:** I agree with D385/D386 that each model output carries one catalogue line. Merge "paper only" and "not advice" into that one line per surface, and reduce the footer to the legal links on pages that already carry a contextual line. Final wording goes to the lawyer with D265.
- **Effort:** S.

### 11. The owner's setup is still everyone's setup — Medium
- **Evidence:** `holdings.trade.note` :345 "IBI's fee is added" and `packages/shared/src/fees.ts:4-11` (one broker's rate for all); `api.unreachable` :153 "Is the orchestrator running?"; `concept.missing` :189 "may not have been ingested in this environment"; `agents.scans.refusals.no_model` :1707 and `research.refusals.no_model` :2223 "Choose one on the Admin page" shown to non-admins; `agents.scans.basis.measured` :1687 "measured on 7 Oct 2026"; `narration.fund.title` :457 "about $0.45 a month"; header version and commit (`nav.version` :969, D352); "installation" in :32, :52, :71, :149, :2120; base currency "Fixed in this version" :1155; US listings only (:1638-1639).
- **User experiences:** operator vocabulary, another broker's fee on their trades, and instructions they cannot follow.
- **Proposal:** a public-copy pass over these keys; role-aware wording for the `no_model` strings; version label for admins only; fee as a per-user setting with presets (IBI, zero commission, custom).
- **Effort:** M.

### 12. Proposals expire faster than a retail user checks a phone — Medium
- **Evidence:** `TRADE_PROPOSAL_TTL_MS = 60 * 60 * 1000`, counted from the next open (`tradeProposals.ts:48-54`); `agents.scans.decisionsHint` :1740 "a proposal you approve within an hour"; 4 of 9 baseline proposals expired (PROPOSAL-AGENT-PERFORMANCE.md:310). Settings has "Keep a proposal answerable for" (:1128); I did not verify that it governs agent trades, and the constant suggests it does not.
- **User experiences:** the agent's rare proposal lapses during a meeting. Re-check (D212, D215) rescues it once, at the cost of another model call.
- **Proposal:** let the user choose the trade window (1 h, 4 h, until the close); the 3% price guard already protects a late approval. Send one "expires in 15 minutes" nudge. Say on the Settings field which proposals it covers.
- **Effort:** S to M.

### 13. Evidence is strong at the moment of decision, weak afterwards — Medium
- **Evidence:** agents have a score and a SPY comparison (:1648-1677). Research ratings show only age (`research.stale` :2252-2253); acknowledged research and Ask proposals record that the user saw them (:733, :738) and nothing more. Rejected and expired trade proposals show their trail (`proposalPage.trail` :1050) but not what the price did next.
- **User experiences:** cannot answer "has the research agent been right?" or "was I right to reject that?", which is what builds or removes trust in a model.
- **Proposal:** computed by code, never by the model: price change since each rating and since each closed proposal, on the proposal page and as a small "track record" line on Research. Feeds the agent-performance plan's evaluation phase too.
- **Effort:** M.

### 14. Notifications are controllable by size, not by kind — Medium
- **Evidence:** two severity floors (`settings.proposalFloor` :1127, `settings.notifyFloor` :1133, with the explanation at :1134), quiet hours and mute (:1135-1144). No switch per source. System notices are pushed as alerts: "Explanations are written by the model again" (`messages.ts:1036-1070`), model fallbacks (:1074-1082), scans that did not run (:1026-1028).
- **User experiences:** cannot say "agent proposals yes, price moves digest-only, system status never". The first push a new user gets may be about narration templates.
- **Proposal:** three toggles (my portfolio's findings, agent and research proposals, system notices), each push / digest / off; system notices default to digest. Rename the two floors in plain words ("Ask me to decide when…" is good; show both on one scale).
- **Effort:** M.

### 15. Creating an agent is a long form, and the templates borrow real names — Medium
- **Evidence:** fields at :1496-1502 and :1816-1880; then schedule, decisions per scan, model budget and model on the Scans/Settings tabs (:1739-1751, :2157). Templates "Warren", "George", "Ray", "Cathie", each "in the spirit of" a named living investor (:1515-1530).
- **User experiences:** a dozen decisions before seeing anything; after creation, more settings in another tab.
- **Proposal:** two-step create: pick a style and a budget, create with the template's defaults, offer "Customise" afterwards. Before public signup ask the lawyer (with D265) whether real investors' names may label a product feature; style names ("Quality at a fair price", "Macro contrarian", "All-weather", "Disruptive growth") avoid the question.
- **Effort:** S to M.

### 16. Explanations are correct and too long — Low
- **Evidence:** `targets.intro` :824 (about 90 words), `targets.explainer` :843, `targets.unpriced_one` :829, `narration.states.rejected.consequence` :433, `telegram.bearerWarning` :774, `admin.rescreenWarning` :1267. Targets is reachable only from an icon in the holdings toolbar whose label is screen-reader-only on a phone (`HoldingsActions.tsx:39-44`).
- **User experiences:** paragraphs of reasoning where one sentence and a "Why?" would do; a feature (targets, which drives drift findings and the rebalance table) that few will find.
- **Proposal:** a lead sentence of at most 25 words, the rest behind the existing `Disclosure` component. Mention targets in the first-run card and in the drift finding's empty state.
- **Effort:** S.

### 17. Phone, Hebrew and accessibility are handled as layout, less as experience — Low
- **Evidence:** one dark theme (`apps/web/src/index.css:3`), no `prefers-reduced-motion` or light scheme rule found; manifest has icons only, no shortcuts or screenshots (`public/manifest.webmanifest`); no service worker (D391). Hebrew users read English news and English concept explanations (`settings.languageHint` :1159), and the concept explanations are the "educational" half of the promise (PRD FR-14 to FR-16).
- **User experiences:** installed app cannot notify; a Hebrew reader taps a term and gets English.
- **Proposal:** I agree with D391 for installability, but a service worker for web push would give non-Telegram users a channel (finding 4). Translate the concept corpus for Hebrew before promoting Hebrew publicly. Manifest shortcuts to Inbox and Ask.
- **Effort:** M to L.

## Metrics to instrument first

**None exist.** A search of `apps/`, `services/ai/app`, `packages/` and `docs/` finds no product analytics library or event table. What exists is operational: `llm_calls`, `runs`, `notifications`, proposal audit rows, last sign-in in the admin user list, Langfuse traces (D375). D162 rightly keeps the admin out of users' holdings, so these should be first-party, server-side, aggregate counts with no portfolio content, and named in the privacy policy.

1. **Activation funnel**, per signup cohort: signed up → email verified → first holding → Telegram connected → model key saved → first agent → first scan → first proposal → first decision, with the median time between steps.
2. **Time to first value**: signup to first valued holding, and signup to first proposal seen.
3. **Proposal outcomes** by source (agent, research, Ask, finding) and surface (app, Telegram): approved, rejected, snoozed, expired. The expiry rate is the health number.
4. **Scan yield and cost** per active user: scans per week, share ending in a proposal, cost per proposal, share stopped by key or limit.
5. **Return and reach**: week-1 and week-4 return, share with Telegram connected, notifications sent per user per day, open-in-app taps per notification, `/mute` and `/stop` rates.

## Roadmap suggestions

Before public signup (M10 PR 16), in this order:

1. **Add: first-run path, key guide and a landing section** (findings 1, 2, 5). Without them public signup measures only how many people give up.
2. **Add: a digest with content and links, and an email channel** (finding 4).
3. **Add: the five metrics**, so the launch teaches something.
4. **Reorder: bring M13 (advice or observation mode) ahead of public signup.** D386 made advisory output the behaviour for everyone; a stranger should start in Observation and opt in. MILESTONES already notes what is not wired (the assistant's prompt, research vocabulary).
5. **Close the "self-use only" exceptions** recorded as such: Yahoo descriptions (D396) and Langfuse text capture (D375); and the lawyer's items (D265): the not-advice wording, plus the investor-named templates (finding 15).
6. **Copy pass**: findings 6, 7, 10, 11, in both catalogues and `messages.ts`.

Defer or cut for the public release:

- **M12 capital gains tax**: Israeli rules, shekel real gains, form 867. Valuable to the owner, irrelevant or risky for a general audience; keep it owner-scoped or behind a country setting.
- **Agent-performance phases 3 to 7** (EDGAR statements, DCF, the full Buffett prompt): depth for one persona. For new users the problem is the 84% pass rate and the empty first scan (finding 3); do phase 1 and the "useful pass" first.
- **IBI sync**: already gated; keep it there.

Housekeeping: PRD still reads "Draft v0.1", "single-tenant-first" and lists Telegram v1 commands; FLOWS F1 and F7 describe a journey and a digest that are not what ships. A stranger joining the project reads these first.

## Needs eyes on the UI

- Empty dashboard at 375 px: is the import card or the add-holding form first, and does the fixture path wrap?
- Agents page for a brand-new user: how the own-key warning, the intro paragraph and a single "Main portfolio" row read together.
- A trade proposal card and the Research page: how many disclaimer blocks are visible at once on a phone (finding 10).
- Dashboard under "All" with one agent: does "Total value" visibly say it includes paper money without opening the breakdown (finding 9)?
- Insights tabs on a phone: four tabs scroll horizontally with a hidden scrollbar (`InsightsPage.tsx:99`); is "All findings" discoverable?
- Settings: length and order of the cards on a phone; whether the two severity floors read as one idea.
- Create-agent drawer on a phone: scroll length, and whether the template picker is seen before the fields.
- Agent page after a "No trade" scan: what is visible without expanding the transcript.
- Hebrew: mixed-direction lines with tickers and money in proposals and Telegram; English concept dialogs inside a Hebrew page.
- Contrast of `text-text-muted` helper text on the dark surface, and whether gain/loss is signalled by more than colour.
- Bottom bar with five places plus count badge and dot at 320 px.
- Installed app on a real phone (owed per D390/D391): safe-area insets, back navigation from a proposal opened by a Telegram link.

## Seen in the running UI (lead reviewer, local compose, 2026-11-10)

Signed-out screens first; the signed-in pass follows in the next section.

Looked at, at the pane's desktop width and at 375 x 812: sign-in, "Ask to join", the privacy
policy.

- **Sign-in is the landing page, confirmed.** The whole pitch is one grey line ("Portfolio
  copilot. Sign in with your email and password."). The not-advice box is longer and visually
  heavier than the product description, so the first thing a stranger learns is what the product
  is not. Supports finding 5.
- **The primary button reads as disabled.** "Sign in" and "Ask to join" are a muted indigo with
  dark text on a dark card, both empty and focused. Check the contrast of the label against the
  button (it looks under 4.5:1) and give the enabled state a clearly brighter fill.
- **"Ask to join" explains the installation, not the outcome.** "Depending on this installation,
  you get in at once or the admin approves you" is the operator's vocabulary. The page knows the
  sign-up mode; say the one that applies ("You'll get an email once the owner approves you").
- **The title and the button are the same words** ("Ask to join" / "Ask to join"), and the
  password is typed twice here before the two further times the journey table counts.
- **The time-zone line is a nice touch** ("Time zone, from this browser: Asia/Jerusalem") - keep.
- **An unknown signed-out path shows the sign-in form with the wrong URL left in the bar**
  (`/legal/privacy` was tried; the real path is `/privacy`). No 404 state. Low.
- **The privacy policy and terms are visibly a template** ("Draft - not yet published", "To
  write: ..."). Known (D265, the lawyer's wording), and right to block public signup on; it is
  also what a curious visitor reads today on the production domain if they click the link.
- **Mobile layout of these three screens is sound**: one column, comfortable targets, no
  horizontal scroll, language switch reachable on the legal page.

## Seen in the running UI, signed in (lead reviewer, local compose, Hebrew, 2026-11-10)

Looked at 375 x 812 in the built-in browser: dashboard (with the source breakdown), Insights
(alerts, proposals, digest), Agents, one agent (holdings, performance, scans), Research, Ask,
Settings, Targets. Desktop: the owner's own screenshot of the dashboard at about 2000 px, plus
page text at 1280 x 800 (the pane was too narrow for legible desktop screenshots). Data is the
local compose copy, in Hebrew. Read-only: nothing was submitted, run or changed. **Not seen:** a
holding's detail page, a pending proposal, an Ask answer, the admin page, the new-agent form, the
English layout at these sizes, a real phone.

### Defects

1. **Ask overflows sideways on a phone - High.** At 375 px the document is 596 px wide
   (`scrollWidth` 596 vs `clientWidth` 375) and opens scrolled, so the logo, the page title and
   half of every sentence are off-screen, and the fixed bottom navigation is 597 px wide too. The
   widest elements are the conversation list's rows: a `block truncate` title inside a
   `min-w-0 flex-1` button whose `li` (`flex items-start gap-1`) is 546 px, so an ancestor (the
   section's grid or flex column) lacks `min-w-0` and a long question sets the page width.
   Measured in Hebrew with a long English question in the history; not re-checked in English.
   **Fixed in the working tree the same day** (`apps/web/src/pages/AskPage.tsx`: the grid's
   tracks are now `minmax(0, ...)`); re-measured at 375 px: `scrollWidth` 375. Not yet merged.
2. **"Account" is larger than "Total value", and its caption is wrong - High.** The dashboard
   shows Total value $170,654.91 and Account $179,538.89 captioned "holdings only: the cash at the
   broker is not set". The difference is exactly the agents' uninvested paper cash
   (7,742.70 + 1,000.00 + 141.28 = 8,883.98). So the card called "Account", on the real
   portfolio's side of the screen, silently includes paper money while saying it is holdings
   only. This is D231's mix made visible; the product review already disagrees with that default.
   At minimum the caption must say what is in the number.
3. **The digest banner leads nowhere - Med.** The dashboard says "Your daily digest is ready: 18
   findings, sent 9 days ago" with an Open link. The digest tab it opens says "Nothing is waiting
   for the next digest" and one line of counts ("18 findings - 7 held in quiet hours, 11 below
   your threshold"). The 18 findings are not listed there. "Ready" and "9 days ago" also
   contradict each other. Confirms finding 4 from the screen.
4. **The agent page's tab row is cut off on a phone - Med.** Five tabs do not fit 375 px; the
   last reads "הגדרו" with no fade or arrow to say it scrolls. The tab is also not in the URL, so
   a reload or a shared link always lands on Holdings (seen: every navigation needed the click
   again).
5. **Negative money reads `$ -1,768.50` - Low.** The minus sits between the symbol and the digits
   (the DOM has bidi marks around both). Whatever `Intl` produces for `he`, the result on screen
   is not how a loss is written; check `i18n/format.ts` for the sign position in RTL.

### Noise and hierarchy

6. **Timestamps carry seconds and a zone everywhere**: "30 באוק׳ 2026, 16:30:00 GMT+2" in the
   proposal history, the scans list and the digest. A relative time, or date and hour:minute, is
   enough; the zone belongs in a tooltip.
7. **"11 hours ago" is printed under every price** (25 times on the desktop table) as well as in
   the page header. Show it per row only when a row differs from the header.
8. **The "real" badge is on nearly every row** of the holdings table. Mark the exception
   (simulated), or drop the column when the filter is "real only".
9. **The header shows a build stamp as if it were a date**: "26.11.10 09:44*" on desktop,
   "09:44*" on a phone (D352). Meaningful to the owner, cryptic to anyone else; move it into
   Settings or the account menu before strangers arrive.
10. **Research opens with the disclaimer twice** (the boxed not-advice line, then a paragraph
    saying the same) before any content, and the page footer repeats it a third time. With no
    agent chosen, two thirds of the first screen is caveat.
11. **Every page starts with a paragraph of explanation** (Agents: six lines; Targets: six lines;
    Ask; Research). Good for a first visit, pure scrolling on the hundredth. Make them
    dismissible or collapse them after the first visit.
12. **Alert cards say the same sentence twice**: the bold title ("TWLO moved -15.2%, 3.8 standard
    deviations...") and the body below it restate each other. Ten-day-old alerts still carry a
    "new" dot.
13. **Concept chips are English inside Hebrew cards** ("Z score", "Standard deviation",
    "Volatility"). Known and decided (guideline 1: the corpus stays English), but on the screen it
    is the one thing a Hebrew reader cannot use.
14. **The agents list uses two unlabeled play icons per card**, one of them disabled, beside a
    "..." menu. Nothing says which is "scan now" and which is "resume". Labels or one primary
    action.
15. **Scans tab: seven "No trade" rows in a row**, each with a cost ("$0.0011 - 0 steps") and no
    reason visible without opening it. Confirms finding 3: the most common outcome is the least
    explained. "0 steps" on a scan that cost money also invites a question.
16. **Settings is ten closed accordions of equal weight.** The OpenRouter key, which gates every
    AI feature, is sixth. Open the section a user still has to complete, or show a status on each
    header (key set / not set, Telegram linked / not).

### What works on the screen

- The agent's account card: cash, market value, net worth, P&L and fees, with one sentence
  saying how P&L is defined. The clearest money panel in the app.
- The source breakdown drawer, once opened, explains the totals honestly, including the "paper
  cash not invested" line per agent. The summary cards should borrow its wording.
- The proposals empty state: a clear sentence and a button to the setting that controls it.
- Bottom navigation on a phone: five items, clear icons, the active one is obvious, RTL order is
  right.
- The "Set cash" link inside the card that is missing the figure.
- Gain and loss carry a sign as well as a colour.
