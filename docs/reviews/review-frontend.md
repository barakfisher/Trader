# Review — Frontend (2026-11-10)

Scope: `apps/web` and the parts of `packages/shared` it uses. Read-only review of `main` at
`95e4c6e`. Nothing was built, run or opened in a browser: every finding is from source, and what
only a running page can settle is under **Unverified**.

## Summary (5 lines max)

The data layer, the money and i18n discipline and the per-page states are better than most
production SPAs; the weaknesses are around the edges of the app shell, not in its core.
There is no error boundary and no client error reporting, and a failed session check is shown as
"signed out". Everything ships in one bundle with no lazy route. There is no linter and no
browser-level test, so the classes of bug the handoff itself says "jsdom cannot see" have no gate.
Modal, tab and menu primitives are hand-rolled several times with incomplete keyboard/ARIA behaviour.

## What is strong and should stay

- **Server state vs client state is drawn correctly.** TanStack Query owns every response, MobX
  holds drafts and in-flight UI only (`src/queries/queryClient.ts:1-10`), and `CacheMirror`
  (`src/queries/cacheMirror.ts:24-38`) lets a store compute from the cache without copying it.
- **One key registry with hierarchical keys** (`src/queries/queryKeys.ts:10-86`): invalidating
  `['portfolio']` reaches cash, snapshots and the consolidated view by construction.
- **Retry and mutation policy are argued** (`queryClient.ts:32-46`): no retry on 4xx, no automatic
  retry of a write. Decisions on proposals are deliberately not optimistic
  (`src/stores/ProposalsStore.ts:27-33`), while cheap idempotent marks are
  (`src/queries/insightsDays.ts:39`, `src/queries/digest.ts:34`). That asymmetry is right.
- **Conditional polling only** (`src/queries/agents.ts:57-63`, `src/queries/research.ts:24`,
  `src/queries/proposals.ts:108-109`): nothing polls while idle.
- **Money never touches a float in a decision path.** `minorToNumber` is used only for chart
  coordinates (`PriceChart.tsx:75`, `EquityCurve.tsx:58`); inputs are regex-validated decimal
  strings sent as strings (`AgentAccount.tsx:76-92`, `lib/targetWeights.ts:72,108`). No
  `parseFloat`, no `toFixed` on money anywhere in `src`.
- **i18n is complete in the JSX.** A grep for literal text, `placeholder=`, `title=`, `aria-label=`
  with English found nothing; formatting goes through `src/i18n/format.ts`; the `t` outside React
  is a MobX dependency (`src/i18n/index.ts:132-140`), which is a subtle thing to get right.
- **RTL is logical throughout.** No `ml-/pr-/text-left/left-N/border-l/rounded-l` class in `src`;
  the two physical rules that exist are for the notch and say why (`src/index.css:42-47,66-69`).
- **TypeScript is strict where it matters** (`tsconfig.base.json:7-8`: `strict`,
  `noUncheckedIndexedAccess`). No `any`, no `@ts-ignore`; four `as unknown as` in total.
- **Model-written text is rendered safely**: `react-markdown` with `skipHtml`, images disallowed,
  external links `noopener noreferrer` (`src/components/AssistantText.tsx:63`); no
  `dangerouslySetInnerHTML` anywhere. One optional `VITE_` variable, not a secret
  (`src/api/client.ts:18`).
- **The four states are present on the pages checked**: Dashboard (`DashboardPage.tsx:117-147`),
  Holding incl. not-found (`HoldingPage.tsx:86-104`), Proposal incl. not-found
  (`ProposalPage.tsx:57-75`), Agent/Agents, Admin incl. a non-admin branch (`AdminPage.tsx:118`).
- **D391 (manifest only, no service worker)**: agreed. Offline prices would contradict guideline 7.

## Findings

### 1. No error boundary and no client-side error reporting — High — effort S

- Evidence: `src/main.tsx:13-21` renders `<App />` with no boundary; the root route has a
  `notFoundComponent` but no `errorComponent` (`src/router.tsx:42-63`), and `createRouter` sets no
  `defaultErrorComponent` (`router.tsx:123-125`). A grep of `src` for `ErrorBoundary`,
  `errorComponent`, `componentDidCatch`, `onerror`, `console.error` returns nothing.
- Failure: any render-time throw (a wire value this build has never seen, a chart given an odd
  series, a markdown edge case) unmounts the whole tree to a blank dark page. In the installed
  standalone app (D391) there is no address bar and no reload button, so the user must kill the
  app. Nobody is told: the error exists only in that device's console.
- Improvement: a root boundary (around `RouterProvider`) plus `defaultErrorComponent` on the
  router so one page fails without losing the bars; both show a catalogue sentence, the header
  version (D352) and a Reload button. Report to a small `POST /api/client-errors` (message, stack,
  route, app version; no user text) logged by the orchestrator, since Langfuse is not a frontend
  error sink. `react-error-boundary` would replace about 30 lines of class component; ask per
  convention 5.

### 2. A failed session check is treated as "signed out" — High — effort S

- Evidence: `src/stores/AuthStore.ts:94-98`: `catch { this.user = null }` for every failure of
  `GET /auth/session`, then `App.tsx:48` renders `LoginPage`.
- Failure: reload during a deploy, a 502 from nginx, or a phone with a weak signal, and a
  signed-in user sees the sign-in form (in the browser's language rather than their own, because
  the language reaction at `AuthStore.ts:66-70` falls back to `signedOutLanguage()`). They retype
  a password for an account that was never signed out. It also hides outages as auth problems.
- Improvement: only `authenticated: false` means signed out. On `status === 0` or `>= 500`, keep
  `initialised = false`, show "cannot reach the server" with Retry, and retry with backoff. Moving
  the session into a query (`queryKeys.session`) would give the retry policy for free.

### 3. One bundle: no lazy route, admin and charts and both languages in the entry chunk — Med — effort M

- Evidence: every page is a static import (`src/router.tsx:28-38`), including the 1,192-line
  admin-only `AdminPage`. `recharts` is imported by four components, `react-markdown` +
  `remark-gfm` by `AssistantText.tsx:2-3`. Both catalogues are bundled regardless of language
  (`src/i18n/index.ts:27-28`; `en.json` 124 KB + `he.json` 160 KB on disk), as are both languages'
  legal texts. No `import(` or `lazy(` exists in `src`. The only build artefact on disk is one
  603 KB JS file dated 14 Sep (`dist/assets/index-BKIEcoZg.js`), from before most of M9-M11.
- Failure: a phone on first open downloads and parses the admin panel, the chart library and a
  second language before it can draw the sign-in form.
- Improvement, in order of return: (a) lazy route components for `/admin`, `/research`, `/ask`,
  `/agents/$agentId` (TanStack Router `lazyRouteComponent` or `createLazyRoute`); (b) the Hebrew
  catalogue as a dynamic import awaited before first render when the session says `he` (English
  stays bundled as the typed source); (c) `manualChunks` for `recharts`. With chunks, add a
  `vite:preloadError` listener that reloads once: after a deploy an open tab will ask for a chunk
  hash that no longer exists. Measure first (see Unverified).

### 4. Modals do not contain focus; the concept dialog does not return it — Med — effort S-M

- Evidence: `Drawer.tsx:46-48` and `ConceptDialog.tsx:65-66` declare `aria-modal="true"` but
  neither traps Tab, sets `inert` on the page, nor locks body scroll. `Drawer` restores focus to
  its opener (`Drawer.tsx:29-34`); `ConceptDialog` only moves focus in (`ConceptDialog.tsx:46-48`).
  Each registers its own Escape listener on `window`/`document`, so a concept opened over a drawer
  closes both on one Escape.
- Known: the Drawer half is in the handoff's debt table (`.claude/MEMORY.md:7704`). I agree with
  the diagnosis but not with "only a hardware keyboard reaches it": screen-reader swipe navigation
  on a phone reaches the covered page too. The ConceptDialog half is not listed.
- Improvement: one `Modal` primitive on the native `<dialog>` with `showModal()`: the browser
  provides the focus trap, inertness, Escape, top-layer stacking and focus return, with no
  dependency. Drawer and ConceptDialog become two skins of it.

### 5. There is no linter; `lint` is the type-checker — Med — effort S

- Evidence: `apps/web/package.json` `"lint": "tsc --noEmit"`; no ESLint or Biome config in the
  repo. `src/pages/AskPage.tsx:45` carries `// eslint-disable-next-line
  react-hooks/exhaustive-deps` for a rule nothing runs. Prettier is configured in the root
  `package.json` but CI runs only typecheck, tests and build (`.github/workflows/ci.yml:55-59`).
- Failure: stale-closure effects, conditional hooks, a missing `key`, an unlabelled icon button or
  a click handler on a `div` are found by reading, or not at all. Finding 12 is the kind of thing
  that slips through.
- Improvement: ESLint flat config with `typescript-eslint`, `eslint-plugin-react-hooks` and
  `eslint-plugin-jsx-a11y`, plus `prettier --check` in CI. A custom `no-restricted-syntax` rule
  can also enforce the project's own conventions (no physical direction classes; no `Intl.` outside
  `i18n/` and the few `lib/` date modules). Dev dependencies only; ask first per convention 5.

### 6. The server's English sentence is shown inside a translated page — Med — effort M

- Evidence: `src/api/client.ts:77-82` puts the response's `message` into `ApiRequestError`, and
  `errorMessage()` (`client.ts:103-105`) prefers it over the caller's translated fallback; 69 call
  sites use it. The orchestrator's messages are English literals (for example
  `apps/orchestrator/src/http/errors.ts:84`, `routes/settings.ts:128-130`). Trades and agents
  already do it properly, by code (`src/lib/agentPresentation.ts:95-130`).
- Failure: in Hebrew, every failure not mapped by code prints an English sentence in a
  right-to-left block without `lang="en"`. Guideline 1 promises a missing translation is a red CI
  run; this path is outside the catalogue, so nothing can go red.
- Improvement: make code-to-catalogue the default: `api.errors.<code>` keys, looked up in
  `errorMessage`, falling back to the caller's sentence (not the server's) for an unknown code.
  The server's `message` then becomes a developer aid. A test can assert every code the
  orchestrator exports has a key, in the style of `i18n/parity.ts`.

### 7. Tabs exist three times, with partial ARIA, and one of them is not in the address — Med — effort S-M

- Evidence: the same tab strip markup at `AgentPage.tsx:158-171`, `InsightsPage.tsx:99-105` and
  `AdminPage.tsx:120-131`. Each has `role="tablist"`/`role="tab"`/`aria-selected`, but there is no
  `role="tabpanel"` anywhere in `src`, no `aria-controls`, no roving `tabIndex` and no arrow-key
  handling. Insights and Admin keep the tab in `?tab=`; the agent page seeds `useState` from the
  address once (`AgentPage.tsx:136-137`) and never writes it back (`:165`).
- Failure: a screen reader announces "tab, 1 of 4" and then the promised keyboard model does not
  work. On an agent's page a reload or Back loses the tab, and a second deep link
  (`?tab=scans&scan=...`, from a proposal's evidence) to the already-mounted page does not switch.
- Improvement: one `Tabs` component (strip + panel, arrow keys, URL-backed) used by all three.
  Small enough to write by hand; `@radix-ui/react-tabs` is the package alternative.

### 8. The typed router's search params are bypassed — Med — effort S-M

- Evidence: `useSearch({ strict: false })` plus a hand parser or a cast at `DashboardPage.tsx:39`,
  `AdminPage.tsx:105`, `AgentPage.tsx:136`, `AskPage.tsx:41`, `ProposalsInbox.tsx:72`; navigation
  cast with `as never` at `AssistantText.tsx:32` and `AskPage.tsx:366`. Only `/ask` declares
  `validateSearch` (`router.tsx:93-94`). The cause is stated at `DashboardPage.tsx:37-38`: the
  dashboard is also the `notFoundComponent` (`router.tsx:60-62`), so it cannot use its own route's
  types.
- Failure: a renamed search key compiles everywhere and breaks links silently, including the ones
  Telegram sends. Separately, the 404 reasoning ("a one-account app") predates M9/M10: a mistyped
  or outdated deep link now shows the portfolio at the wrong address with no hint the link was bad.
- Improvement: move the existing parsers (`adminTabFrom`, `holdingsScopeFrom`, `holdingsSortFrom`,
  `tabFrom`) into each route's `validateSearch` and read with `Route.useSearch()`; give unknown
  addresses a 10-line `NotFoundPage` with a link home. Both `strict: false` and both `as never`
  then disappear.

### 9. No test runs in a real browser — Med — effort M-L

- Evidence: 76 test files, 42 of them jsdom component tests (`apps/web/test/`), no Playwright or
  Cypress, no axe. The handoff records the gap itself: "jsdom cannot see it ... only a look at the
  page in Hebrew finds this class of bug" (`.claude/MEMORY.md:7690-7693`) and "The template
  creator's UI has not been seen in a browser" (debt table, same file).
- Failure: RTL truncation, 44 px targets, the bottom bar covering content, safe-area insets and
  focus order are exactly the D381-D391 work, and each regression is found by the owner on a
  phone after deploy.
- Improvement: a small Playwright suite against the compose stack with the fixture provider
  (already hermetic): sign in, dashboard, a holding, a proposal, Ask, at 375 px and 1280 px, in
  `en` and `he`, with `@axe-core/playwright` on each page. Start with assertions and a11y; add
  screenshots only once the pages are stable. New dev dependency and a CI job: ask first.

### 10. Three components carry most of the dashboard, twice — Med — effort M

- Evidence: `HoldingsTable.tsx` (626 lines: `HoldingRow`, `HoldingCard`, `HoldingDetails`, inline
  editor) and `CombinedHoldingsTable.tsx` (693 lines: `CombinedRow`, `CombinedCard`,
  `CombinedDetails`, `RealHoldingEditor`) implement the same table/card/editor shapes in parallel.
  `trimQuantity` is defined twice (`HoldingsTable.tsx:621`, `HoldingPage.tsx:278`); the micro-USD
  per cent constant twice (`AgentScans.tsx:33`, `SettingsPage.tsx:481`). `AdminPage.tsx` is
  1,192 lines holding about 30 components for four tabs; `ui.tsx:1` still says "kept in one file
  while there are only a few".
- Failure: D366 ("every view has the same toolbar and row menu") has to be kept true by editing
  two files identically; a phone-card fix lands in one and not the other.
- Improvement: extract the shared pieces by concept (`HoldingEditor`, `HoldingCardFrame`,
  `QuoteAge`), leaving the two tables as column definitions; split `AdminPage` into
  `pages/admin/{Users,Models,Operations,Settings}Tab.tsx`, which is also what finding 3 needs to
  lazy-load it. No behaviour change, so the existing tests are the safety net.

### 11. Quantities are formatted three different ways — Low — effort S

- Evidence: real holdings print the raw decimal string with zeros trimmed, ungrouped and not
  localised (`HoldingsTable.tsx:255`, `CombinedHoldingsTable.tsx:194`, `HoldingPage.tsx:133`);
  agent positions go through a float, `formatNumber(Number(q))`, at Intl's default three fraction
  digits (`AgentAccount.tsx:153,209`, `TradePanel.tsx:204`, `TradeProposalCard.tsx:157`); pending
  trades use eight digits (`SummaryCards.tsx:257`).
- Failure: the same position reads "1234.5" in one card and "1,234.5" in another. The float path
  is harmless today because agent quantities are whole shares (`QUANTITY_INPUT`,
  `lib/agentPresentation.ts:82`), but it silently rounds the day fractional quantities reach a
  simulated account, against guideline 4.
- Improvement: one `formatQuantity(decimalString)` in `i18n/format.ts`.
  `Intl.NumberFormat.prototype.format` accepts a decimal string at full precision in current
  engines, so no float is involved; set `maximumFractionDigits: 18`.

### 12. `border-border` is not a token — Low — effort S

- Evidence: `ConceptDialog.tsx:68,70,117` use `border-border`; the theme defines only
  `--color-border-subtle` (`src/index.css:10`). Every other component uses `border-border-subtle`.
- Failure: Tailwind 4 emits nothing for an unknown colour utility, so those three borders take the
  default border colour rather than the subtle one (see Unverified for the visual check).
- Improvement: rename the three classes. This is a one-line example of what findings 5 and 9
  would have caught.

### 13. API client: no cancellation, and a non-JSON body loses its status — Low — effort S

- Evidence: `request()` never receives an `AbortSignal` (`src/api/client.ts:45-55`) and no
  `queryFn` forwards one (grep for `signal` in `src` is empty), so `cancelQueries` at
  `ProposalsStore.ts:77` cannot stop the request on the wire. `JSON.parse(text)` (`client.ts:61`)
  runs before the status is checked, so an HTML error page from nginx (502, 413) throws a
  `SyntaxError` rather than an `ApiRequestError`; `shouldRetry` (`queryClient.ts:32-36`) then
  retries it whatever the status was.
- Failure: typing in the instrument search leaves superseded requests running; a 413 on an import
  is retried twice and reported with the generic fallback.
- Improvement: `queryFn: ({ signal }) => api.get(path, { signal })`; wrap the parse in try/catch
  and throw `ApiRequestError(fallback, response.status, 'invalid_response')`.

### 14. Reduced motion and failure announcements are per-component, not systemic — Low — effort S

- Evidence: only `ExpandingCard.tsx:16,55,125` honours `prefers-reduced-motion`; `Spinner`
  (`ui.tsx:115`) and the refresh icon (`DashboardPage.tsx:105`) spin regardless. `ErrorNote`
  (`ui.tsx:120-131`) has no `role="alert"`, while two call sites hand-roll one
  (`AgentReviewCards.tsx:77`, `TradePanel.tsx:218`).
- Failure: a failed save is silent to a screen reader on most forms; motion preferences are
  ignored outside one component.
- Improvement: one unlayered `@media (prefers-reduced-motion: reduce)` rule in `index.css`, in the
  style of the D384 phone block; `role="alert"` on `ErrorNote`.

### 15. A long-lived tab never learns a new version was deployed — Low — effort S

- Evidence: the version is compiled in (`vite.config.ts:53`) and only displayed
  (`AppBar.tsx:69`); `index.html` is `no-cache` (`infra/docker/nginx.conf:67-69`), which helps
  only on a reload. With no service worker (D391, agreed) there is no update event.
- Failure: the installed app on a phone can run last week's bundle against this week's API until
  the OS evicts it; after a wire-shape change that is finding 1's blank page.
- Improvement: serve the version as a tiny static `version.json` written at build; compare on
  window focus; show a "new version, reload" line in the bar. No worker needed.

## Unverified

- **Current bundle size and composition** (finding 3). `dist/` is from September. Check:
  `pnpm --filter @traders/web build` and read Vite's size table, or add
  `rollup-plugin-visualizer` for one run.
- **How `border-border` actually renders** (finding 12). Check: open any concept chip and inspect
  the dialog's computed `border-color` against a card's.
- **Scroll position on navigation.** `createRouter` is called without `scrollRestoration`
  (`router.tsx:123-125`) and nothing calls `scrollTo`. Check: scroll down the dashboard on a
  phone, tap a holding, see whether the holding page opens at its top; then Back, and see whether
  the dashboard returns to where it was.
- **Whether a visible, focused dashboard ever refreshes prices by itself.** The portfolio query
  has no `refetchInterval` (`queries/portfolio.ts:17-20`), so it should refresh only on focus,
  mount or the Refresh button, although `queryClient.ts:17-19` reads as if prices arrive unasked.
  Check: leave the dashboard visible for five minutes during market hours and watch the network tab.
- **Colour-only signalling.** Percent changes carry a sign through `formatPercent`
  (`i18n/format.ts:62-65`); money P&L goes through `Delta` (`ui.tsx:103-110`), which only sets a
  colour. Whether every money P&L also shows a minus/plus was not traced per call site. Check: the
  holdings table and summary cards in greyscale.
- **Re-render cost of the holdings tables.** Nine uses of `memo`/`useMemo`/`useCallback` in all of
  `src`, no list virtualisation. Likely fine at tens of holdings. Check: React Profiler on the
  dashboard with the largest real account while a refetch lands.
- **Which server messages actually reach the UI untranslated** (finding 6). The path is verified;
  the list of codes that are not mapped client-side was not enumerated. Check: grep the
  orchestrator's error codes against `en.json`.
- **Contrast of `text-text-muted` at the 11-12 px sizes** (`index.css:17-19`) on `surface-raised`.
  Check: axe or DevTools contrast on a card's secondary line.
