# Review — Analyst / investor (2026-11-10)

Read-only review of the financial substance, at `95e4c6e`. Nothing was run: no stack, network,
model or database. Every finding cites what was read; what could not be settled is under
"Unverified".

## Summary (5 lines max)

- The bookkeeping is unusually honest (integer money, `null` for unpriced, sourced figures, a shadow
  benchmark on the same deposits). The analysis on top of it is thinner than the wording suggests.
- A Buy more / Trim / Sell view on the real portfolio rests on 60 days of prices and a word-count
  news score: no fundamentals, no valuation, no position weight.
- Corporate actions do not exist in the model: a split breaks quantities, alerts and agent net worth.
- The real portfolio, the one with real money, has no return, no benchmark and no realised P&L.
- Agents chase the day's movers with no statements data and a fee that small budgets cannot carry.

## What is strong and should stay

- **Unpriced is `null`, uncosted is named, never zero** (`apps/orchestrator/src/services/valuation.ts:166-172`,
  D14, D230). Most retail tools get this wrong.
- **The shadow benchmark buys SPY with the same deposits on the same days**
  (`apps/orchestrator/src/services/performance.ts:138-160`, D24, D37). That is the right comparison
  for an account with top-ups; it is not fooled by a deposit.
- **Everything is recomputed from an append-only ledger and stored closes** (`performance.ts:1-27`, D36),
  and a missing close makes the figure unavailable rather than partial (`performance.ts:128-131`).
- **The sigma rule's guards** - today's return left out of its own sample, a minimum move, a floored
  denominator with a capped severity (`services/ai/app/analysis/sigma_move.py:9-31`) - and the market
  line chosen by fit, not SPY for everything (`apps/orchestrator/src/services/marketBenchmarks.ts:4-14`, decision 149).
- **Approval is a preview at the live price**, refused 300 bps from the agent's price, filled within
  50 bps of what was shown, expiring an hour after the next open
  (`apps/orchestrator/src/services/tradeApproval.ts:70`, `tradeProposals.ts:47-54`, D3, D4, D47).
- **The figure check and the "nothing from memory" rules** (`services/ai/app/agents/scan.py:105-109`, D394),
  and a team that writes down that its own baseline is too small to judge
  (`docs/PROPOSAL-AGENT-PERFORMANCE.md:379-388`). Keep that discipline; several findings below ask for
  it to reach the user-facing figures too.

## Findings (ranked)

### 1. Research views on the real portfolio are price momentum and headline tone, worded as an advisor's call — High

- **Evidence:** `services/ai/app/research/evidence.py:42-44` (7 days of news, 60 trading days of prices),
  `evidence.py:90-92` and `:138-141` (sector and stock "sentiment" are averages of the lexicon score);
  `services/ai/app/news/sentiment.py:3-7` (the scorer's own text: it scores "cut costs" and "cut
  guidance" the same); `services/ai/app/research/run.py:137-139` ("You are told nothing about the size
  or cost of the position"); `services/ai/app/research/rating.py:54-57` (Buy more, Trim, Sell and Buy
  raise a proposal). Recorded as D392; the missing statements data is recorded for agents in
  `docs/PROPOSAL-AGENT-PERFORMANCE.md:43`.
- **What goes wrong:** "Trim" is a statement about position size, and the model is told nothing about
  the size. "Sell" and "Buy more" are valuation calls, and there is no earnings, margin, debt, multiple
  or guidance in the evidence. What the model can actually see is whether the stock went up or down
  over 60 days and whether headlines used positive words. The result is a trend-following signal with
  an analyst's vocabulary, raised as an Approve/Reject card on real money. The not-advice line does not
  fix the substance.
- **Do I agree with D392?** With the mechanics (acknowledge-only, word change raises the card, 7-day
  expiry) yes. With raising actionable views on this evidence, no.
- **Proposed improvement:** until statements data exists, (a) add to the evidence, computed in code, the
  holding's weight in the portfolio and its unrealised gain percent, so "Trim" can be about
  concentration; (b) put a fixed, catalogue-worded line on every rating saying what it was based on
  ("price history, rule findings and a week of headlines; no financial statements"); (c) consider
  holding back proposals for Sell / Buy more until fundamentals are in the evidence, keeping the word
  on the Research page.
- **Effort:** S for (a) and (b); (c) is a decision.

### 2. No corporate actions: a split or a dividend is invisible to the ledger and visible to the prices — High

- **Evidence:** `services/ai/app/providers/yfinance_provider.py:253-257` (`auto_adjust=False`, decision 5);
  `services/ai/app/analysis/backfill.py:22-31` and `:55-66` (a stored close is replaced by the provider's
  current answer); `apps/orchestrator/src/services/performance.ts:112-131` (net worth is ledger quantity
  times that day's close); a search of `services/ai/app`, `apps/orchestrator/src` and `packages/shared/src`
  for split or dividend handling finds none; `.claude/MEMORY.md:5890` (D340: "a dividend is not tied to
  a holding ... simulated agents keep top-ups only").
- **What goes wrong:** on a 10-for-1 split the holding keeps its old quantity and old per-unit cost
  while the price falls 90%: the dashboard shows a collapse, the price-move, sigma and drawdown rules
  fire at "high", and a simulated agent's net worth and score are wrong from that day on. Decision 5's
  stated aim (a quoted close never changes) is also not what happens if the provider restates closes
  for splits, because the backfill deliberately rewrites its own rows (see Unverified 1). For
  dividends: agents never receive them and SPY is read price-only, so both sides are price return; an
  income-style agent (the Warren template) is understated against a growth one, and the real
  portfolio's income is a manual cash entry with no link to the stock that paid it.
- **Do I agree with decision 5?** Keeping printed closes for alerts is defensible. Having no
  corporate-action record beside them is not.
- **Proposed improvement:** a `corporate_actions` table (split ratio, cash dividend, ex-date) behind
  the provider interface. Apply a split to holdings and to the replay in `holdingsAt`; suppress or
  relabel the move rules on an ex-date; credit dividends to agents as `income` movements and compare
  against SPY with its dividends, or say "price return, dividends excluded" under both figures.
- **Effort:** L (M for split detection plus an alert guard alone).

### 3. Agents decide without statements, valuation or an earnings date — High (known; agree, with additions)

- **Evidence:** the tool list is quotes, closes, findings, news, position, universe search and concept
  text (`services/ai/app/agents/tools.py:164-455`; history capped at 252 days `:57`, news at 7 days `:67`).
  Known and measured: `docs/PROPOSAL-AGENT-PERFORMANCE.md:43` and section 4; SEC EDGAR with an own
  mapping was chosen on 2026-11-09 (`:27-28`).
- **What goes wrong:** every thesis today is a reading of price and headlines, whatever the persona says.
  A "value" agent cannot know a price is cheap.
- **Additions an analyst would ask for, in order:** (1) the next earnings date and whether results came
  in the news window - buying two days before a report without knowing it is the most avoidable
  mistake here (the doc lists it only under deferred trends, `:248`); (2) a handful of point-in-time
  multiples and quality figures computed in code (P/E, EV/EBIT, FCF yield, net debt/EBITDA, ROIC, share
  count trend), each with its fiscal period end and filing date so nothing reads as fresher than it is;
  (3) financials: the measurement found 0 of 14 mapped (`:103`), so banks and insurers need their own
  short set (P/TBV, ROE, CET1) or an explicit "not covered" that blocks a buy thesis from citing
  quality.
- **Look-ahead warning for the EDGAR work:** `companyfacts` returns restated values. Store the `filed`
  date with every fact and give a scan only facts filed before its `as_of`, or any later replay or
  evaluation of old scans will see numbers the market did not have.
- **Effort:** L (already planned); the earnings date alone is S-M.

### 4. The real portfolio has no measured return, no benchmark and no realised P&L — High

- **Evidence:** performance is refused for the primary (`apps/orchestrator/src/http/routes/agentAccount.ts:91`,
  `simulated(...)`); the dashboard's cost and P&L cover current holdings only
  (`apps/orchestrator/src/services/valuation.ts:169-171`, `:230`); the account card's gain is
  `value - invested` as one absolute figure (`apps/web/src/components/AccountCard.tsx:120`); the daily
  snapshot stores the holdings' value without cash (`apps/orchestrator/src/services/snapshot.ts:103`).
  `docs/MILESTONES.md:340-344` records that realised P&L exists per agent only.
- **What goes wrong:** sell a loser and its loss leaves the P&L card: "unrealised P&L" improves by
  selling what went down. There is no answer to "what did I make this year, and against the index?",
  which is the first question an investor asks, and it is answered for the paper agents but not for
  the money that is real.
- **Proposed improvement:** the pieces exist. The primary has fills, a cash timeline with deposits,
  withdrawals, income and charges (D340), and stored closes. Run the same replay for it: realised P&L
  per sale (average cost, as today), a money-weighted return (XIRR on the dated flows) and a
  time-weighted one from daily values, the shadow SPY on the same flows (withdrawals sell SPY), since
  the date the cash was set. Say plainly that history before that date is not covered.
- **Effort:** M.

### 5. Ask reports the portfolio's 1/7/30-day "change" from snapshot totals that include the user's own buying and selling — Med

- **Evidence:** `services/ai/app/assistant/tools.py:55` and `:368-376` (`_window_change` is the latest
  snapshot total against an earlier one); the total is holdings only (`snapshot.ts:103`); the query
  reads `degraded` (`tools.py:169-170`) but `_window_change` does not use it.
- **What goes wrong:** buy 5,000 USD of stock from cash and Ask's evidence says the portfolio rose by
  that much over 7 days; sell and it "fell". A degraded earlier snapshot (a holding unpriced that day)
  becomes a gain. The figure passes the evidence validator because it is in the tool result - sourced,
  and wrong. The agents' month-to-date in the same file takes deposits out correctly
  (`tools.py:612-651`), so the method already exists.
- **Proposed improvement:** compute the window change from the ledger replay (finding 4), or subtract
  net trades and cash movements in the window; skip a degraded endpoint and say so.
- **Effort:** S-M.

### 6. The minimum fee makes small paper budgets unwinnable, and only the prompt guards it — Med

- **Evidence:** `packages/shared/src/fees.ts:26-28` (one cent a share, at least 7.50 USD);
  `services/ai/app/agents/scan.py:189-192` (the model is asked to "weigh it");
  `docs/PROPOSAL-AGENT-PERFORMANCE.md:336` (22.50 USD of fees on a 1,000 USD budget, 2.25 points);
  the shadow pays none (`.claude/MEMORY.md:7723`, D38, recorded debt).
- **What goes wrong:** at a 1,000 USD budget and a 10% position limit, a 100 USD buy pays 7.5% on the
  way in and 7.5% on the way out. No stock picker beats a fee-free index through a 15% round trip.
  The comparison then measures the budget, not the philosophy.
- **Proposed improvement:** a code check beside the mandate's: refuse (or send back once) a trade whose
  fee is above a set share of its notional, say 1%; tell the user at creation what the smallest
  sensible budget is for the chosen position limit; and settle D38 by charging the shadow one fee per
  deposit. I agree with keeping the real broker's fee - it is the honest number.
- **Effort:** S.

### 7. The agent is not shown its own positions' value, weight or gain, and is forbidden to work them out — Med

- **Evidence:** `services/ai/app/agents/tools.py:431-445` (a holding is symbol, quantity, cost per share,
  opened); `services/ai/app/agents/briefing.py:89-100`; `services/ai/app/agents/scan.py:212-214` ("never
  compute new figures").
- **What goes wrong:** the agent cannot say "this is now 30% of the account" or "up 40% since I bought"
  without a figure the validator will refuse. Sell discipline, trimming a winner and concentration
  awareness are all impossible to state, so they do not happen. The baseline fits: no agent has ever
  sold (`docs/PROPOSAL-AGENT-PERFORMANCE.md:384`).
- **Proposed improvement:** have code add, per holding: last price, market value, weight of net worth,
  unrealised gain in money and percent, days held, sector; and for the account: net worth, percent in
  cash, largest position, weights by sector. The proposed per-holding verdict (`docs/PROPOSAL-AGENT-PERFORMANCE.md:260`) needs exactly
  these.
- **Effort:** S.

### 8. Risk controls stop at single-name cost and a cash floor — Med

- **Evidence:** `services/ai/app/agents/mandate.py:56-69` (the whole mandate: position, cash buffer,
  holdings count, universe filters), `:259-260` (position measured at cost, D171); only buys are
  checked (`:19-20`, D165). The benchmark-fit code that measures co-movement exists but is used for
  alert wording only (`services/ai/app/analysis/market_context.py`).
- **What goes wrong:** five semiconductor names at 10% each pass every rule and are one bet. A position
  bought at 10% that doubled is 18% of the account and may still be added to if its cost is under the
  limit. Nothing forces a second look at a position after a large fall or when the thesis's own "what
  would prove me wrong" came true.
- **Do I agree with D171?** With the reason (a rule must always be answerable), yes. A limit at cost
  alone is still the wrong measure for a winner.
- **Proposed improvement:** check the position limit at the larger of cost and market value when a
  price exists, falling back to cost; add an optional per-sector cap in the mandate (profiles already
  carry sector); store each thesis's invalidation sentence with the holding and put it back in the
  briefing; a code-raised "review" finding when a holding is a set percent below cost. Warnings, not
  forced sells.
- **Effort:** M.

### 9. Discovery is the day's gainers, losers and most-active — Med (known; agree, raise its priority)

- **Evidence:** `services/ai/app/agents/briefing.py:30` and `:99`; `services/ai/app/agents/scan.py:176-177`.
  Known: `docs/PROPOSAL-AGENT-PERFORMANCE.md:67` and `:258`; the baseline's proposals were IRON, SMCI,
  SOFI, IOVA, RCUS, GM (`:346-354`) and `search_universe` was never called on compose (`:326`).
- **What goes wrong:** a movers list is the most attention-driven, highest-volatility corner of the
  market, and it is the only idea source every agent gets, whatever its horizon. A rule saying "a
  move alone is not a reason" (D394) fights the input instead of changing it.
- **Proposed improvement:** make the opening list depend on horizon, as the doc recommends; for
  medium and long horizons replace it with a small code-built screen from the mandate's own sectors
  and caps (for example the largest 60-day laggards and leaders inside the selection, later cheapest
  by a multiple). The idle-cash rule (D234) adds pressure to act on whatever is in front of the agent,
  which makes the quality of that list matter more.
- **Effort:** M.

### 10. Agent return is P&L over total deposits, undated and without risk — Med

- **Evidence:** `apps/orchestrator/src/services/performance.ts:300-301`; win rate over sells only
  (`:219-229`); deposits are the only flow kind (`:46`).
- **What goes wrong:** the comparison with the shadow is fair (same flows). The headline percent is
  not a rate: 4% over three weeks and 4% over two years read the same, and an agent that topped up
  late has its early gains diluted. There is no volatility, no maximum drawdown and no beta, so an
  agent that beat SPY by holding three small caps looks simply "better". Warren at 0% against -4% is
  shown as +4 points for holding cash (`docs/PROPOSAL-AGENT-PERFORMANCE.md:338`).
- **Proposed improvement:** from the series already computed, add a time-weighted return, the period
  in days beside every percent, maximum drawdown for agent and shadow, average percent in cash, and a
  "too few sells to mean anything" state for the win rate below a set count. Build the every-proposal
  5/20/60-day table from phase 0 into the Performance tab: it is the only measure that also judges
  rejected and expired ideas, and the user's own approvals.
- **Effort:** M.

### 11. A foreign holding's cost is converted at today's exchange rate — Med

- **Evidence:** `apps/orchestrator/src/services/valuation.ts:149-153` (cost times the current rate);
  `:139-144` (the previous close is converted at today's rate too). `docs/MILESTONES.md:347-348`
  records that no historical rates are held.
- **What goes wrong:** for a holding bought in EUR or ILS, P&L in the base currency leaves out the
  whole currency effect, and "today" leaves out today's currency move. For an Israeli investor
  holding USD assets the currency is often the larger part of a year's result, and M12's tax
  question needs the same data.
- **Proposed improvement:** store the daily rate series (the provider interface already has `fxRate`),
  record the rate on the purchase date with the holding (ask at import when unknown), and show price
  effect and currency effect apart. A shekel view (declined for now in `MILESTONES.md:333`) falls out
  of the same series.
- **Effort:** M.

### 12. Paper fills are at a delayed quote with no spread — Low-Med

- **Evidence:** `apps/orchestrator/src/services/fills.ts:58-59` (a quote up to 30 minutes old fills, to
  the cent, D28); no spread or slippage term anywhere in `fills.ts`.
- **What goes wrong:** the names agents pick are volatile movers. Filling at a 15-minute-old print,
  with the user free to see the live price elsewhere before confirming, flatters paper results a
  little every trade; it compounds with finding 6 in the other direction, so neither bias is visible.
- **Proposed improvement:** state it under the performance figures; optionally charge a fixed
  half-spread in basis points by market-cap band, recorded as its own decision.
- **Effort:** S.

### 13. The alert rules watch each holding alone, over 30 days — Low-Med

- **Evidence:** `services/ai/app/analysis/thresholds.py:76` (drawdown from a 30-day high),
  `:59` (sigma over 30 days); the volume rule of FR-6 is not built (`sigma_move.py:42-44`);
  allocation by instrument and asset class only (`valuation.ts:255-256`).
- **What goes wrong:** a stock that slid 45% over five months shows a small 30-day drawdown; a
  portfolio that is 60% one sector never hears it; a 9% fall on results reads the same as a 9% fall
  on nothing.
- **Proposed improvement:** portfolio-level findings from data already stored: sector weights and a
  concentration finding, the portfolio's own drawdown from its high, drawdown from the 52-week high
  per holding, and a tag on a move that falls on an earnings date (with finding 3's calendar).
- **Effort:** M.

### 14. Two definitions of cost: the holding's excludes the buy fee, the score's includes it — Low

- **Evidence:** `apps/orchestrator/src/services/fills.ts:113-121` and `:479` (average cost from price
  only); `apps/orchestrator/src/services/performance.ts:191` (the book's cost is notional plus fee).
- **What goes wrong:** the holdings table's P&L for a position and the score's unrealised P&L for the
  same shares differ by the fees, with nothing saying why. Small in money, confusing in a product
  whose promise is that every figure can be traced.
- **Proposed improvement:** pick one (fees in cost is the usual broker and tax convention) or label
  the table "before fees".
- **Effort:** S.

## Missing features worth building (ranked by value)

1. **Real-portfolio performance**: realised and unrealised P&L, money- and time-weighted return, the
   shadow index on the same flows, by period (finding 4). The highest-value gap for this user.
2. **Fundamentals and an earnings calendar with filing dates** (finding 3), feeding agents, research
   and the Holding page (multiples, next report date, last report's surprise if available).
3. **Corporate actions**: splits applied, dividends recorded per holding and credited to agents
   (finding 2); then yield on cost and total return per holding.
4. **Exposure and risk view**: sector and industry weights, top-5 concentration, look-through of ETF
   holdings (the universe build already fetches them, `services/ai/app/universe/screener.py:9`),
   portfolio volatility, beta to the fitted benchmark, maximum drawdown, a correlation table.
5. **A thesis journal per holding**: why it was bought, what would prove it wrong, a review date;
   shown at approval and re-read by the agent (finding 8). The proposed watchlist
   (`docs/PROPOSAL-AGENT-PERFORMANCE.md:226-228`) is its unheld half.
6. **Idea scorecard**: every proposal and research view tracked at 5/20/60 trading days against the
   index, approved or not, per agent and per rating word (finding 10). It answers "should I listen
   to this agent?" years before realised P&L can.
7. **Currency effect and a shekel view** (finding 11), which M12's tax work needs anyway.
8. **Price and valuation alerts set by the user** ("tell me under 150" or "under 15 times earnings"),
   the thing the rules cannot guess.

## Unverified

1. **Whether Yahoo's `Close` with `auto_adjust=False` is restated for splits.** My understanding is
   that it is (only dividends are left to `Adj Close`), which would mean a split rewrites the stored
   closes inside the backfill window and leaves older rows at the old scale. Check: fetch a symbol
   with a known recent split twice, with and without `auto_adjust`, and compare the closes before the
   split date with the stored `quotes` rows for those days.
2. **How many days each scheduled backfill re-reads**, which sets how much history a restatement
   would change. Check: the `days` the scheduler passes to `backfill_history`.
3. **How the Performance tab words the return** (whether it already says "since first deposit",
   "price only", "without fees"). I read the service, not the running UI. Check: open an agent's
   Performance tab and read `agents.performance.*` in `apps/web/src/i18n/locales/en.json`.
4. **What a real model does with the research evidence.** D392 records that no real-model run had
   been read (`.claude/MEMORY.md:6772`). Check: read 20 stored ratings and count how many rest on the
   60-day change or the sentiment average alone.
5. **How often a thesis cites a figure whose only source is the user's instructions** (D227).
   Already listed as the first base-agent fix (`docs/PROPOSAL-AGENT-PERFORMANCE.md:256`); not measured.
6. **How stale `instrument_profiles.market_cap_minor` is** when the mandate's cap bands are checked
   (`services/ai/app/agents/mandate.py:225-229`). Check: the profile's load date against today for a
   name near a band edge.
7. **Whether any held instrument is quoted in a currency other than USD today**, which sets how much
   finding 11 matters now. Check: `SELECT DISTINCT currency FROM holdings` on the user's account.
8. **Whether news evidence is headline and description only or includes the body.** I read the
   evidence assembly, not `get_news`'s fields in full. Check: `services/ai/app/agents/tools.py:350-405`.
