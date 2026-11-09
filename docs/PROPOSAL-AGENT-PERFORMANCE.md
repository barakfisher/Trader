# Proposal: improving the agents' performance

Status: **proposed, 2026-11-09. Nothing here is accepted except where section 2 says so.** It records
a review of a Warren Buffett prompt for one agent, what that review found in the code, and the work
plan that follows. The only code written so far is the four shared rules in section 5 (D394).

Open first: section 2 (what is decided) and section 8 (the plan).

---

## 1. Where this started

The user proposed a detailed Buffett system prompt for one agent (appendix A) and asked four things:
is it clear, what should be added, which rules belong in the prompt shared by all agents, and should
the shared prompt carry "trends" such as "history says buy at hour X or on day Y".

**Answer in short:** the prompt reads clearly, but it cannot run as written. It is over the length
limit, and most of its tests need financial data no agent has. The trends do not belong in the
shared prompt.

## 2. Where each question stands

| Topic | State | Who decides next |
|---|---|---|
| Four shared rules | **Merged** (D394, #386), not deployed | Deploy: the user |
| Warren template | **Changed on the user's word** (D395), not deployed | Deploy: the user |
| Add a statements source (not replace yfinance) | **Chosen by the user, 2026-11-09: SEC EDGAR beside yfinance** | Done; recorded as a decision with the PR that builds it |
| `edgartools` or a hand-written mapping | **Chosen by the user, 2026-11-09: our own bounded mapping**, because `edgartools` covered less (section 4.2) | Done; recorded as a decision with the PR that builds it |
| Instructions limit, 4,000 to 8,000 characters | Recommended, not agreed | The user |
| Optional `analysis` field, `hold` and `watch` verdicts | Recommended, not agreed | The user |
| Watchlist and scans triggered by it | Recommended after the DCF, not agreed | The user |
| Base-agent fixes, section 7 | Recommended, not agreed | The user |
| Baseline (phase 0) | **Measured 2026-11-09**, section 8; too small to judge results. Production's starts after D396 | Next step: the user |
| Trends | **Deferred by the user**: "we will check later what to do and how" | Revisit in phase 7 |

## 3. What the review found

### 3.1 What blocks the prompt in the system

| Problem | What happens |
|---|---|
| **Length** | The prompt is about 5,230 characters; `MAX_PERSONA_LENGTH` is 4,000, so saving it fails. |
| **No financial data** | Tools give quotes, about a year of daily closes and at most 7 days of news. There are no statements, ROIC, FCF, EBIT or insider figures, in any provider or tool. |
| **The figure check will not catch this** | D227 makes the user's instructions a source. "ROIC above 15%" passes because 15 is in the prompt, though nobody measured it. "ROIC is high" passes because it has no number. |
| **DCF** | The scan prompt says "never compute new figures", and a value the model computes is refused as unsourced. The calculation has to live in code. |
| **Output format** | The server requires JSON with a thesis of two to four sentences, so the prompt's six-section format conflicts with it. |
| **Watchlist** | None exists. A scan is told only its last three decided scans (D354), and those are not a source. |
| **"Autonomous", "buy order"** | The agent proposes and the user approves (guideline 2). |

### 3.2 Contradictions inside the prompt

- **No "Hold" verdict.** A good held company at a fair price fits none of Buy, Watchlist or Exit.
- **Zero-based thinking against long holding.** "Would I buy this today?" with a required 25% discount
  fails almost every holding. The discount has to be the test for buying only.
- **"Immediate Rejection" against the sell triggers.** A ROIC of 14% leads to rejection and an exit
  recommendation, yet it is none of the three "exclusive" triggers.
- **Allowed sectors fail the hurdles.** ROIC and debt to EBIT do not fit banks and insurers, and
  utilities will mostly fail on high debt and low returns.
- **Missing exact values.** "25% to 30%" is a range rather than a threshold, and "absurd" is undefined.
  The DCF has no discount rate, terminal growth or projection length, and without them the model can
  reach nearly any result.

### 3.3 What the prompt should add

- A rule for missing data: "I do not have it, so I do not buy", never filling the gap from memory.
- Brand and cost advantage among the moats.
- Treating movers as noise: every scan opens on the day's gainers and losers (`briefing.py`).
- A stated reason for holding cash: above the buffer, a pass that does not quote the amount or percent
  goes back once (D236).
- No tax argument for now: M12 has not started and the agent has no tax data.

Some rules are better as agent settings than as prompt text, because the server enforces those limits
on buys: long horizon, ETFs off, allowed sectors, position limit, cash buffer. A schedule of one scan
after the close also fits the strategy and costs less.

## 4. Measurements (2026-11-09, six symbols, read-only)

Symbols: KO, AAPL, JPM, BRK-B, DUK, TSM.

| | yfinance | SEC EDGAR (`companyfacts`) |
|---|---|---|
| **Depth** | 4-5 annual columns, oldest 2021-2022 | About 15 years in the main fields, where the field exists |
| **Meets 5-10 years** | Barely | Yes, where the field exists |
| **TSM** | Has data | No `us-gaap` facts: it reports under IFRS |
| **Gaps** | No EBIT for JPM | No operating income or capex tag for JPM; operating income only 2011-2012 and no long-term debt tag for BRK-B; long-term debt in 6 filing years for AAPL |
| **Insider ownership** | `heldPercentInsiders` is present | Not checked |

EDGAR counts are by filing year, so they are approximate. Gaps are by exact tag: a company may report
the same concept under another tag, which is what a mapping has to solve. Paid providers were not
checked or priced.

### 4.1 A direct mapping on the universe (2026-11-09)

`companyfacts` against a short list of tags per concept: operating cash flow, capex, EBIT, debt, equity and
shares. A company counts when every field has at least 5 years of annual filings, one of them recent.

| Measured | Result |
|---|---|
| Universe stocks with a SEC company number | 2,528 of 2,592 |
| 120 random stocks, 10-K only | 105 with `us-gaap`; **27 of those have all six fields** (21 at 10 years) |
| 100 largest stocks, 10-K, 20-F and 40-F, wider shares tag | 89 with `us-gaap`, 11 without |
| Of those 89, non-financial | **46 of 75 have all six** (41 at 10 years) |
| Of those 89, financial | **0 of 14** |
| A company's `companyfacts` file | median 3.1 MB |

**What this shows:** a short tag list is not enough, even for the largest companies. The field missing most often is
EBIT: JNJ, CVX, MRK, GE and LLY have no match under the listed tags, so it would have to be derived, for example from
pre-tax income plus interest. The random sample also holds young companies, for which missing years are correct.

**What it does not show:** the coverage a longer list or derived fields would reach. It is a sample with one list of tags.

### 4.2 `edgartools` against a direct mapping (2026-11-09)

Version 5.62.1 in a scratch environment outside the project, through `Company.get_facts()` and its annual statements. Both
sides used the same concepts and forms. The direct side also filtered flows to periods of about a year and took the latest
filing for each year. Shares here include the weighted average, so these counts differ slightly from section 4.1.

| Companies with all six fields | Direct, 5 years | `edgartools`, 5 years | Direct, 10 years | `edgartools`, 10 years |
|---|---|---|---|---|
| 100 largest, non-financial (75) | **47** | 30 | **40** | 14 |
| 100 largest, financial (14) | 1 | 1 | 1 | 1 |
| 120 random, `us-gaap` (105) | **44** | 34 | **34** | 15 |

| Latest values against yfinance, largest non-financial | Direct | `edgartools` |
|---|---|---|
| Within 2% | 278 | 266 |
| Differ by more | 48 | 34 |
| Absent | 45 | 71 |

**What this shows:** on this route `edgartools` does not close the gaps. It covers less, and the worst loss is at 10 years,
which is what the prompt asks for. It costs 42 installed packages and 256 MB in a clean environment.

**What it does not show:**

- **Which values are right.** yfinance is a comparison, not the truth. Some differences are definitions, such as JNJ's capex
  (4.83B against 5.22B) and debt. Others may be errors on either side, such as AMD's operating cash flow on the direct side
  (6.49B against 7.71B). None was checked against a filing, so about one comparison in seven is unexplained.
- **The library's other route.** Its standardized statements per filing were not measured, and its concepts were matched by
  name, which could undercount.
- **A figure to check.** JNJ's FY 2025 R&D came back as 109M from `edgartools`, which looks wrong, and its first probe had no
  FY 2022 column. Neither was checked against a filing.

**XOM, diagnosed:** SEC's ticker map now points XOM to a new registrant, "ExxonMobil Holdings Corp" (CIK 2115436), with no annual
history on the direct side. History presumably sits under the predecessor, which was not checked. A mapping needs a way to
follow a successor, or it reports such a company as having no data.

**Recommendation:** our own bounded module over `companyfacts`, using `httpx` (already a dependency): a concept map with fallbacks,
annual-period filtering, derived EBIT and `null` for what is missing. Financial companies stay out of ROIC, EBIT and the DCF. The
first PR should re-run this measurement with derived EBIT, and check a sample of differences against filings.

**Before production:** SEC asks for a declared `User-Agent` with a contact, so that needs a setting. The measurement used a
placeholder one. Fetch only the symbols agents ask about and store the result, given the file size.

**Cost figures.** Prices come from `app/llm/pricing.py`: Gemini 3.7 Flash $0.75/$3.75 and Claude Sonnet
5.5 $2/$10 per million input/output tokens. A scan was measured at $0.036 on 2026-10-07. The estimates
below assume 5 turns a scan and about 4 characters a token; neither was measured here.

| Change | Flash | Sonnet 5.5 |
|---|---|---|
| 4,000 more instruction characters, per scan | ~$0.004 | ~$0.01 |
| Output ceiling from 1,500 to 2,500 tokens, per answer, if fully used | ~$0.004 | ~$0.01 |
| 10 watchlist rows in the briefing, per scan | ~$0.001 | ~$0.003 |

**Earlier readings worth re-measuring:** 56 of 75 scans on compose passed after a pass (before D354);
2.3 of 12 tool calls a scan over 16 model scans, with `search_universe` never called (D228, whose
re-measurement is due at about 50 model scans). Both are re-measured under phase 0 in section 8.

## 5. Built: four shared rules

`JUDGMENT_RULES` and `PRICE_MOVE_RULE` in `services/ai/app/agents/scan.py`; tests in
`services/ai/tests/test_judgment_rules.py`.

1. Do not state a company's financial figures or recent events from memory; say what is missing, and
   do not rest a decision on it.
2. Keep evidence and judgment apart.
3. In each recommendation, say what would prove you wrong.
4. A price move alone is not a reason to trade (scans only: research does not open on the movers).

Rules 1-3 reach scans, re-checks (they share the scan prompt) and research. **The server cannot check
them.** The assistant's Ask prompt is separate and was not read or changed.

**Checks run:** ruff check and format pass; 1,296 pytest tests pass. **Not run:** 322 tests were
skipped, at least some for lack of `TEST_DATABASE_URL`; `tests/test_llm_tracing.py` does not load
because `langfuse` is missing from the local venv; no real model has run these rules, so whether they
change behaviour is unknown.

**Rejected for the shared prompt:** any investing philosophy or numeric threshold, because they differ
between agents; and a not-advice line, which comes from the catalogue (D385).

Recorded as D394 in `.claude/MEMORY.md`.

## 6. The recommended designs

### 6.1 Data: add a source, do not switch

| Data | Provider |
|---|---|
| Quotes, price history, movers | yfinance, unchanged |
| Financial statements, 5-10 years | SEC EDGAR, new |

SEC has no prices, so it cannot replace yfinance. It sits behind a new `FundamentalsProvider`
(guideline 6). If it is unavailable, statement figures are `null` and the agent says it lacks them;
prices and scans carry on (guideline 7). The cost is a second external dependency and mapping
different reporting tags to one concept. Foreign filers such as TSM stay without data at first;
yfinance could fill them later, with its 4-5 years.

### 6.2 DCF: what it is, and why code computes it

A Discounted Cash Flow estimates what all the cash a business will produce is worth today. 100 received
in a year is worth about 91 today at a 10% discount rate. Summing those years gives the intrinsic value;
a market price 25-30% below it is the margin of safety.

**It is very sensitive to its assumptions.** With cash flow of 100, a 10% discount rate and 3% growth
give about 1,471; 9% and 4% give about 2,080, which is 41% more from one point on each. So the
assumptions are constants in code, never the model's, and the arithmetic uses `Decimal` (guideline 3).
Banks and insurers answer "not available": the method does not fit them.

### 6.3 Output: optional detail, JSON kept

- An optional `analysis` field holds the six sections; a section that does not apply is left out.
- It shows collapsed under the thesis. Telegram keeps the short thesis.
- Its figures pass the same check, and its labels come from the catalogue (guideline 1).
- `hold` and `watch` verdicts are added.
- `MAX_OUTPUT_TOKENS` goes from 1,500 to about 2,500.

### 6.4 Watchlist

Keeps value, reason and date, which today vanish after three scans. Code can then compare price to value
without a model and run a scan only when a price crosses the threshold. It needs a table with `user_id`,
a bounded write tool, a screen and a place in the briefing. Without a DCF it is only a list with reasons,
so it comes after one. The saving is unmeasured: a long-horizon agent that scans only on a trigger may
save more than the watchlist costs.

### 6.5 Trends (deferred)

Why they were not recommended for the shared prompt:

- **No data.** The system stores daily closes (`interval="1d"`), so an hour-of-day pattern cannot be
  measured. A year gives about 50 observations per weekday.
- **The agent does not choose when.** It proposes; the fill is at the live quote when the user approves;
  a proposal expires 60 minutes after creation or the next open (`TRADE_PROPOSAL_TTL_MS`).
- **The model would invent.** With no measured figure it would recall a "pattern" from memory, which
  guideline 7 forbids.
- **Doubtful value.** From general knowledge, not measured here: such effects have weakened and are hard
  to profit from after costs. Timing barely matters to a long horizon, and there is no day-trading
  horizon (D166).

Options to weigh in phase 7: an earnings calendar ("do not buy the day before results", needs a new data
source); multi-week trends, where 5, 20 and 60-day returns already exist and an agent's own instructions
can use them; a code-computed tool reporting sample size and costs, for short-horizon agents only.

## 7. Recommended fixes to the base agent

Beyond the four rules, by importance:

1. **Close the D227 gap.** Log figures whose only source is the instructions, measure how often that
   happens, then decide whether to tighten.
2. **Make the movers depend on the agent.** A long-horizon agent opens on its watchlist instead. This also
   shrinks the briefing.
3. **A verdict per holding**: `hold`, `watch` or `exit`, so "did nothing" can be followed over time.
4. **An evaluation before deploying.** A fixed set of scans through Langfuse, before and after a prompt
   change, since such a change reaches every agent.
5. **Check Ask.** Read its prompt and see whether the same rules are missing there.

The idle-cash rule (D234) stays: it is the user's own rule, and the Warren draft gives it the reason it asks
for.

## 8. Work plan

One branch off `main` at a time, no stacked PRs. Each PR updates the handoff and records its decisions. Each
phase needs the user's word: nothing below is a grant. Paid model runs, deployment and reading a live database
are asked for separately (standing rules), and every deploy goes to compose before production. **Since 2026-11-09,
measurements read the user's own account on production, SELECT only, without asking each time (the user's word).**

**"Performance" here means three things, in this order:** decisions that are honest about their evidence;
scans that finish and are usable; and results against the shadow SPY the Performance tab already computes
(D115). Results come last on purpose: months of a long-horizon agent's returns say little, and tuning a prompt
to them would be fitting noise.

### Phase 0: baseline (read-only)

Measure before changing anything, per agent:

- **Reliability:** share of `invalid_answer` and `rule_rejected`, refusals by kind, `cash_unjustified`, passes after
  a pass.
- **Usefulness:** proposals per scan; approved, rejected and expired; tool calls per scan (D228's re-measurement).
- **Results:** agent against the shadow SPY, and the return at 5, 20 and 60 trading days of **every** proposal against
  SPY, approved or not, so a rejected idea is judged too.
- **Cost:** per scan and per proposal, by model.

*Done when:* a table is in this document, with sample sizes, and a statement of what the data is too small to show.

#### Baseline, measured 2026-11-09

**Source.** Compose, all of it, on a throwaway copy of its stopped database (no network, read-only transactions,
removed afterwards); compose itself stayed stopped. Compose is at migration `0084`. Its 81 scans run from 2026-10-12 to
2026-10-30, every agent is paused, and all of them used `google/gemini-3.5-flash-lite`. "Model scans" below are the 79
with a cost: of the other two, one failed on a connection error and one is a hand-made test trade (AAPL, Test agent),
so that trade counts in no model figure.

**What this baseline is not.** The last scan predates D353-D355 (deployed 2026-10-31) and D394, so **no scan here saw
scan memory or the new rules**, and the D354 re-measurement cannot be done on compose. Production has run scans since
then: 14 from 2026-11-02 to 2026-11-06, 10 of them from an agent set to `anthropic/claude-opus-5.5`, and no proposal.
Only those counts were read from production.

**Reliability and usefulness**

| Agent (name as stored) | Model scans | Pass | Trade | `invalid_answer` | `rule_rejected` | Pass after a pass | Proposals per scan | Approved / rejected / expired | Tool calls per scan (scans with none) |
|---|---|---|---|---|---|---|---|---|---|
| `agressive` | 50 | 43 (86%) | 6 | 1 (2%) | 0 | 39 of 49 | 0.12 | 3 / 1 / 2 | 0.82 (30) |
| Test agent | 14 | 11 (79%) | 1 | 2 (14%) | 0 | 8 of 13 | 0.07 | 1 / 0 / 0 | 1.36 (5) |
| Warren | 12 | 11 (92%) | 0 | 1 (8%) | 0 | 9 of 11 | 0 | 0 / 0 / 0 | 0.83 (5) |
| George | 3 | 1 | 2 | 0 | 0 | 0 of 2 | 0.67 | 0 / 0 / 2 | 2.67 (0) |
| **All** | **79** | **66 (84%)** | **9** | **4 (5%)** | **0** | **56 of 75** | **0.11** | **4 / 1 / 4** | **0.99 (40)** |

- **The earlier 56 of 75 reproduces exactly**, so this is the same data read the same way, not a new reading after D354.
- **Refusals that ended a scan (4):** unsourced figures 3, malformed answer 1, mandate 0. Test agent's two are the threshold
  case D227 has since fixed.
- **Sent back to the model (5):** figures 3, idle cash 1, mandate 1. No scan hit `step_limit`.
- **`cash_unjustified`: 0 of 58** passes with idle cash. This shows only that the figure was quoted, not that the reason is
  good: D354 recorded eight near-identical "cash 141.28, 14.5%" passes from one agent in one day, and the flag passes them all.
- **Passes get little research:** 38 of 66 passes called no tool. The week of 2026-10-26 was 48 passes of 50 scans, mostly the
  hourly `agressive`.

**D228's re-measurement (79 scans, due at about 50).** 0.99 tool calls a scan against 2.3 at the last reading, at most 5 of the
12 allowed, no `step_limit`, and `search_universe` still never called (`get_quote` 35, `get_news` 29, `get_price_history` 11,
`get_position` 3). A keyword search of the 74 stored theses found none saying it lacked information. Nothing here argues for a
research sub-agent or a tool picker, on this model and these prompts.

**Results: agent against the shadow SPY**, computed by the real `agentPerformance` (D115) to the close of 2026-11-06. Compose's
stored prices stop on 2026-11-02, so closes came from yfinance; they agree with the stored last price within 0.5% on all 130
overlapping symbol-days.

| Agent | Sessions | Fills | Agent | Shadow SPY | Difference (points) | Note |
|---|---|---|---|---|---|---|
| `agressive` | 15 | 3 | -9.77% | -4.07% | -5.70 | Fees of $22.50 on a $1,000 budget are 2.25 points of it; the benchmark pays none (recorded debt) |
| Test agent | 18 | 2 | +2.39% | -4.46% | +6.85 | $10,000 budget; one of the two fills is the hand-made AAPL test |
| Warren | 15 | 0 | 0.00% | -4.07% | +4.07 | Never bought: this is cash in a falling market, not skill |
| George | 14 | 0 | 0.00% | -4.39% | +4.39 | Its two proposals expired: the same |

**Results: every model-written proposal against SPY.** The start is the first session close at or after the proposal, the same
rule as D115, for the symbol and for SPY.

| Proposal date | Agent | Symbol | State | 5 trading days | SPY | To 2026-11-06 (sessions) | SPY |
|---|---|---|---|---|---|---|---|
| 10-19 | `agressive` | IRON | expired | -1.6% | -0.1% | 0.0% (14) | -4.1% |
| 10-19 | `agressive` | IRON | approved | -1.6% | -0.1% | 0.0% (14) | -4.1% |
| 10-20 | George | GM | expired | +4.5% | +0.1% | +11.8% (13) | -4.4% |
| 10-20 | `agressive` | IRON | approved | +0.5% | +0.1% | -0.7% (13) | -4.4% |
| 10-21 | Test agent | GM | approved | +8.4% | -0.1% | +13.2% (12) | -4.9% |
| 10-21 | `agressive` | SMCI | approved | +0.7% | -0.1% | -19.1% (12) | -4.9% |
| 10-21 | George | RCUS | expired | -3.9% | +0.7% | -5.6% (11) | -3.8% |
| 10-27 | `agressive` | SOFI | rejected | +2.3% | -2.0% | -1.2% (8) | -4.5% |
| 10-29 | `agressive` | IOVA | expired | -5.2% | -2.7% | -5.2% (5) | -2.7% |

| Set, at 5 trading days | n | Mean above SPY (points) | Median | Beat SPY |
|---|---|---|---|---|
| All | 9 | +0.9 | +0.4 | 5 |
| Approved | 4 | +2.1 | +0.6 | 3 |
| Not approved | 5 | 0.0 | -1.5 | 2 |
| Distinct agent and symbol (IRON counted once) | 7 | +1.3 | +0.8 | 4 |

**20 and 60 trading days: n = 0.** The first 20-day reading is due about 2026-11-16 and the first 60-day about 2027-01-14.

**Cost, by model**

| Model | Agent | Scans | Total | Per scan | Per proposal |
|---|---|---|---|---|---|
| `google/gemini-3.5-flash-lite` | `agressive` | 50 | $0.1001 | $0.0020 | $0.0167 |
| | Test agent | 14 | $0.0256 | $0.0018 | $0.0256 |
| | Warren | 12 | $0.0196 | $0.0016 | none made |
| | George | 3 | $0.0101 | $0.0034 | $0.0051 |
| | **All** | **79** | **$0.1554** | **$0.0020** | **$0.0173** |
| `anthropic/claude-sonnet-5.5` | Test agent | no scan rows | $0.1341 | unknown | unknown |
| `anthropic/claude-opus-5.5` | production agent | 10 | not read | not read | no proposal |

The Sonnet line is 15 calls on 2026-10-07 and 08, in `llm_calls` with no matching row in `agent_scans`, so it is left out of the totals.

**What the data is too small to show**

- **Whether any agent is good.** 9 proposals over 5 trading days, three of them the same IRON idea, in a market where SPY fell about
  4%. One GM trade moves the approved mean by more than the whole gap between approved and not approved.
- **Whether the user's approvals add anything:** 4 against 5.
- **Any 20-day or 60-day return, or any realised result:** no agent has ever sold, so the Performance tab's score has nothing to score.
- **Warren, George, or a long-horizon agent in general:** 12 scans and 3 scans. Warren's 0 proposals fit "no statements data" and also fit
  12 quiet days; these numbers cannot tell them apart.
- **Any model other than Flash Lite**, including what production's Opus agent costs or does.
- **The effect of D354, D394 or D395:** no scan here ran them.

**What it does show.** Reliability is not the problem: 5% invalid and no final mandate refusal. The weakness is usefulness: 84% passes,
half the scans with no tool call, and a cash check that a repeated sentence satisfies. **A scan on this model costs about $0.002**,
so measuring is cheap and need not wait.

**Superseded in part by the production reading below.** Next is phase 1's evaluation (section 7.4), on the budget the user approves, before D394 reaches production: fixed
briefings, before and after, on Flash Lite first, reading passes without tools and repeated reasons. Then deploy compose first, then
production, and read production's scans in full once it has about 50. Do not tune to the results above.
D228 stays deferred. The statements work does not depend on this and can run in parallel, but its worth for Warren has not been shown here.

#### Production, read 2026-11-09 at `34919e4` on `0084`

The user's own account, SELECT only. **No agent could propose a trade before 2026-11-09 13:11 UTC**, because production had no instrument
profiles (D396). So these 14 scans, from 2026-11-02 to 2026-11-06, are not a baseline of agent behaviour: they show the cost and the tools only.

| Agent | Model | Scans | Pass | `invalid_answer` | Proposals | Tool calls per scan | Total | Per scan | Agent against shadow SPY |
|---|---|---|---|---|---|---|---|---|---|
| George | `anthropic/claude-opus-5.5` | 10 | 7 | 3 | 0 | 4.6 | $0.94 | $0.094 | 0% against -2.24% |
| Warren | `google/gemini-3.5-flash-lite` | 4 | 4 | 0 | 0 | 0 | $0.004 | $0.001 | 0% against -2.53% |

- **All 37 `search_universe` calls came back empty**, and `get_quote` said not tradable. Both agents hold only cash, so the SPY column is the market's fall.
- **`search_universe` was never called on compose and was called in every George scan here.** That may be the model or the agent: one agent on each
  cannot tell them apart. So D228's reading above holds for Flash Lite only.
- **All 3 invalid answers are Opus writing prose before the JSON**, which `parse_answer` refuses.
- **Scan memory reached all 14 scans.** The pass-after-pass rate (8 of 12) means nothing while passing was the only answer.
- **Too small or not read:** everything about decisions. Read the scans after the load, which still run the prompts before D394.

### Phase 1: prompt and settings, no new data

- **Merged:** the four rules (section 5), with this document, in #386.
- **PR:** raise the limit to 8,000 in `apps/orchestrator/src/http/routes/agents.ts` and
  `apps/web/src/components/InstructionsField.tsx`, if the user agrees.
- **Done on the user's word, 2026-11-09:** appendix B is the Warren template in English and Hebrew
  (`agents.templates.warren.persona`). A template fills new agents only: **an existing Warren agent keeps its stored text**, so
  the user pastes appendix B there and sets the settings in section 3.3. This text describes today's tools, so phase 3 has to
  change it.
- **Build the evaluation** (section 7.4) and run it on these rules first, as a paid run the user approves.

*Done when:* the evaluation shows the rules' effect, including a thesis that says what would prove it wrong.

### Phase 2: measure the evidence gap

- **PR:** log figures sourced only from the instructions (section 7.1).

*Done when:* a week of scans gives a rate, and the user decides whether to tighten.

### Phase 3: financial statements

- **Decided:** our own bounded mapping over `companyfacts` (section 4.2). The first PR's scope is agreed with the user before it starts.
- **PR:** `FundamentalsProvider`, shared stored statements, `get_fundamentals`; ROIC, FCF and debt to EBIT computed in code,
  in research evidence too.

*Done when:* a thesis can quote a ROIC the validator traces to a tool result; a missing field is `null` and the agent says
so; tests stay hermetic on fixtures. Empty, stale and source-down cases are covered.

### Phase 4: the DCF

- **PR:** `get_intrinsic_value`, assumptions as constants, returning the inputs and the discount to price.

*Done when:* the calculation is deterministic and tested against constants; banks and insurers answer "not available".

### Phase 5: output format

- **PR:** `analysis`, `hold` and `watch` (section 6.3), through the validator, the web and the catalogues.

*Done when:* an absent section shows nothing, every language passes CI, and Telegram is unchanged.

### Phase 6: watchlist and triggered scans

- **PR:** the watchlist (section 6.4) with empty, loading, error and permission-denied states.
- **PR:** scans triggered by a price crossing, and movers by agent (section 7.2).

*Done when:* the cost per agent is measured against phase 0.

### Phase 7: the full Buffett prompt and trends

- Rewrite appendix A: fix section 3.2's contradictions, drop what the system already says, and use phases 3-6. Tax waits for M12.
- Weigh the trend options in section 6.5.

*Done when:* the prompt saves, passes the evaluation and the instructions check finds no conflict with its settings.

### Order

Phases 0-2 cost little and improve every agent, so they come first. Phases 3 and 4 are what make the Buffett prompt real. Phases 5
and 6 depend on them. M12 (tax) and D228 (research sub-agent, tool picker) stay where they are.

### Non-goals

No order execution or broker API (guideline 2). No figure from a model. No tax advice before M12. No foreign filers in the first
statements PR. No day-trading horizon (D166).

---

## Appendix A: the prompt as proposed by the user

Kept unchanged. It does not run as written: see section 3.

```text
## System Prompt: The Warren Buffett Autonomous Investment Agent

### Core Directive & Role
You are an autonomous long-term investment agent operating strictly under the philosophy of Warren Buffett and Charlie Munger. Your ultimate objective is to compound capital at high rates over the long term by identifying and acquiring extraordinary businesses trading below their intrinsic value, with the intent of holding them indefinitely.

For you, **inaction is the default**. Most of the time, you do nothing. You act with absolute patience and ignore market noise, daily price fluctuations, and transient macroeconomic trends.

---

### 1. Circle of Competence
You are strictly prohibited from analyzing or investing in businesses outside your circle of competence.
- **Allowed:** Simple, understandable business models with predictable economics (e.g., consumer goods, traditional manufacturing, insurance, established financial services, utilities, proven B2B software).
- **Prohibited:** Pre-revenue growth companies, biotechnology in early clinical trials, cryptocurrency, highly leveraged entities (such as complex investment banks), and industries undergoing hyper-rapid technological disruption where future winners cannot be reasonably forecasted.

---

### 2. The Economic Moat Test
A company must clearly demonstrate at least two of the following structural advantages to pass initial screening:
- **Pricing Power:** Proven ability to raise prices during inflationary environments without losing market share or customer loyalty.
- **Switching Costs:** Deep customer integration where switching to a competitor entails severe operational or financial friction.
- **Network Effects & Scale:** Dominant market positioning that creates insurmountable barriers to entry for new competitors.

---

### 3. Quantitative Financial Hurdles
Review 5 to 10 years of historical financial statements. A company is automatically rejected unless it meets the following minimum thresholds:
- **Return on Invested Capital (ROIC):** A consistent historical average of at least 15% over time.
- **Cash Flow Quality:** Continuous generation of stable Free Cash Flow (FCF) that genuinely substantiates reported accounting earnings.
- **Controlled Leverage:** Total interest-bearing debt must be easily coverable within less than 3 years of operating income (EBIT).

---

### 4. Intrinsic Valuation & Margin of Safety
Never overpay for an excellent business.
- **Intrinsic Value Calculation:** Must be performed exclusively via a conservative Discounted Cash Flow (DCF) model, utilizing growth rate assumptions below historical averages.
- **Purchase Condition:** Issue a buy order ONLY when the prevailing market price is at least **25% to 30% below** the calculated intrinsic value. If no margin of safety exists, place the company on a watchlist only.

---

### 5. Capital Allocation & Management Quality
Evaluate how management allocates shareholder capital:
- Prioritize management teams with meaningful insider ownership ("skin in the game").
- Assess whether capital is reinvested into high-return projects, directed toward intelligent share buybacks executed strictly below intrinsic value, or distributed via steady dividends—rather than wasteful, value-destroying M&A activity.

---

### 6. Holding, Exit Rules & Position Auditing
- **Patient Holding:** Treat stock ownership as owning a fractional share of a premier local enterprise. Disregard daily market sentiment and macro commentary.
- **Existing Position Audit (Zero-Based Thinking):** When evaluating an existing portfolio position (especially one currently at an unrealized loss), evaluate it strictly as if holding equivalent cash today. Disregard anchoring to the initial buy price or unrealized loss percentages.
- **Tax-Loss Harvesting Consideration:** If an existing holding receives an "IMMEDIATE REJECTION" verdict due to fundamental deterioration or moat collapse, explicitly recommend an exit/sell. Note the structural benefit of harvesting capital losses to offset future taxable capital gains, freeing up capital for allocation into high-ROIC compounders.
- **Exclusive Sell Triggers:** Liquidate or exit a position ONLY under three conditions:
  1. **Structural Moat Destruction:** A fundamental paradigm shift permanently erodes the company's long-term competitive advantage.
  2. **Severe Ethical/Management Breach:** Management acts in direct, systematic disregard of shareholder interests.
  3. **Extreme Overvaluation:** The market price vastly exceeds intrinsic value to an absurd, distortionary degree.

---

### 7. Required Analysis Output Structure
Whenever asked to analyze a company, output your response in this exact structured format:
1. **Circle of Competence Check:** (Yes/No with brief justification)
2. **Economic Moat Analysis:** (Identified structural advantages)
3. **Key Financial Metrics:** (ROIC, leverage, cash flow stability)
4. **Valuation & Margin of Safety:** (Conservative DCF valuation vs. current market price)
5. **Existing Position Guidance & Tax Efficiency:** (Zero-based assessment and tax-loss harvesting recommendation if evaluating a held position)
6. **Final Verdict:** (Buy, Watchlist, or Immediate Rejection / Exit)
```

## Appendix B: the version that fits today's data

About 2,150 characters, so it saves under today's limit. Its example phrases carry no figures, because D227 would make any figure here a source for a thesis. Not yet run on a model. Without statements it does not really test a company: it gives a
qualitative judgment and says so.

```text
You invest in the spirit of Warren Buffett and Charlie Munger: you own extraordinary businesses for years and buy them only when the price is sensible. Doing nothing is your normal scan.

What you can know
- Your tools give prices, about a year of daily closes and a week of news. They give no financial statements, so you cannot measure ROIC, free cash flow, debt or intrinsic value.
- Never state or imply such a measure, from memory or otherwise ("a high ROIC", "well below intrinsic value"). If you need one, say you do not have it.
- You may use what you generally know about how a business makes money and why its customers stay. Call it your judgment, never evidence.

Which businesses
Simple, predictable businesses you can explain in two sentences. Never pre-revenue companies, early-stage biotech, crypto, heavily leveraged companies, or industries where the future winners cannot be reasonably forecast.

Moat
Name at least two lasting advantages: pricing power, switching costs, network effects, scale or cost advantage, brand. If you cannot, do not buy.

Noise
The movers list is not a source of ideas. A day's move, market mood and macro commentary are no reason to act. News matters only when it changes the moat or how management treats shareholders.

Buying
Buy only when the moat is clear and the price has fallen for a reason you judge temporary, with nothing in the news showing lasting damage. A fall alone is not a margin of safety; say plainly that the bargain is your judgment, not a calculation. Otherwise propose nothing. When cash sits above your buffer, the reason is that nothing met this bar: say so.

Holdings
Ask one question: is this business as good as when you bought it? Ignore your cost per share and any unrealized gain or loss. Being not cheap today is no reason to sell; a discount is the test for buying. Sell only if:
1. the moat is permanently damaged;
2. management systematically acts against shareholders;
3. the price is absurdly far above what the business could plausibly be worth, which you state as judgment.

In every thesis
Say what would prove you wrong. Do not argue from taxes: you have no tax data.
```
