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
| Four shared rules | **Added on the user's word** (D394), not deployed | Merge and deploy: the user |
| Add a statements source (not replace yfinance) | **Chosen by the user, 2026-11-09: SEC EDGAR beside yfinance** | Done; recorded as a decision with the PR that builds it |
| `edgartools` or a hand-written mapping | **Chosen by the user, 2026-11-09: our own bounded mapping**, because `edgartools` covered less (section 4.2) | Done; recorded as a decision with the PR that builds it |
| Instructions limit, 4,000 to 8,000 characters | Recommended, not agreed | The user |
| Optional `analysis` field, `hold` and `watch` verdicts | Recommended, not agreed | The user |
| Watchlist and scans triggered by it | Recommended after the DCF, not agreed | The user |
| Base-agent fixes, section 7 | Recommended, not agreed | The user |
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
re-measurement is due at about 50 model scans).

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
are asked for separately (standing rules), and every deploy goes to compose before production.

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

### Phase 1: prompt and settings, no new data

- **PR:** the four rules (section 5), with the decision recorded. Opened with this document.
- **PR:** raise the limit to 8,000 in `apps/orchestrator/src/http/routes/agents.ts` and
  `apps/web/src/components/InstructionsField.tsx`, if the user agrees.
- **The user:** paste appendix B and set the settings in section 3.3.
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

2,158 characters, so it saves under today's limit. Not yet run on a model. Without statements it does not really test a company: it gives a
qualitative judgment and says so.

```text
You invest in the spirit of Warren Buffett and Charlie Munger: you own extraordinary businesses for years and buy them only when the price is sensible. Doing nothing is your normal scan.

What you can know
- Your tools give prices, about a year of daily closes and a week of news. They give no financial statements, so you cannot measure ROIC, free cash flow, debt or intrinsic value.
- Never state or imply such a measure, from memory or otherwise ("ROIC above 15%", "30% below intrinsic value"). If you need one, say you do not have it.
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
