# Proposal: one-time IBI portfolio sync over MCP

Status: **accepted as D67 (2026-10-08)** - read-only broker sync is in scope; PRD P1 is amended.
Nothing here is built yet. **Gated (2026-10-08, the user; MEMORY decision 135):** nothing IBI is
built - not even the Excel mapper of section 8, PR 2 - until the section 0 probe shows that a
third-party MCP client can connect to IBI's server. The probe goes first.

---

## 0. What has to be true first (and what is known today)

The whole design depends on one fact we do not yet have: **can a third-party MCP client connect to
IBI's MCP server at all?**

What is known (October 2026, press only, no IBI developer documentation found):

- IBI launched an AI connection in **IBI SMART** that uses MCP. It is **view-only**, and the
  customer authenticates "like logging into the app". At launch it was offered **only to ChatGPT**.
- No public endpoint URL, developer portal, client registration process or tool list was found.
- No IBI entry was found in public MCP directories (the "IBKR" servers there are Interactive
  Brokers, an unrelated firm).

A connector that is built for ChatGPT can still be open to other clients. That depends on how its
OAuth server registers clients:

| IBI's authorization server supports...                                  | Can Traders connect?                |
|-------------------------------------------------------------------------|-------------------------------------|
| Dynamic Client Registration (RFC 7591) or Client ID Metadata Documents | Yes, with no involvement from IBI   |
| Pre-registered clients only (allowlist)                                 | Only if IBI registers us            |
| Not standard MCP auth (proprietary session, IP allowlist)               | No                                  |

**Step 0 is therefore a read-only probe, not a feature**, in line with "measure before building":

1. Find the server URL (IBI SMART settings screen, or the URL ChatGPT's connector settings show).
2. `GET <server>` with no token. A spec-compliant server answers `401` with a
   `WWW-Authenticate: Bearer resource_metadata="..."` header.
3. Fetch that Protected Resource Metadata (RFC 9728), then the authorization server's
   `/.well-known/oauth-authorization-server`. Read `registration_endpoint`,
   `client_id_metadata_document_supported`, `scopes_supported` and `code_challenge_methods_supported`.
4. If registration is open: register a dev client, sign in with your own account, call
   `tools/list`, and save the **real** tool names and output schemas into a fixture file
   (with account numbers removed).

`get_portfolio` and `get_cash_balance` in the brief are guesses. Building the mapper against
guessed names is exactly the "invented data" failure guideline 7 forbids. The code below says
`<holdings tool>` wherever the probe has to fill in the real name.

**Plan B, if the server is closed to us:** IBI's website and app export holdings to Excel.
Adding an IBI column mapper to the existing F1 CSV/XLSX import delivers most of the value in
about a day, with no authentication surface at all. It is worth building first in any case: the MCP
path will reuse the same mapper.

---

## 1. Review of the proposed flow

### Scenario B (credentials in RAM): reject it

This is the most important finding. Each of the following is enough reason on its own:

1. **MCP remote servers authenticate with OAuth 2.1.** The protocol has no place for a password,
   so Scenario B would mean scripting IBI's *login page*. That is screen-scraping a broker, and
   IBI can break it with any front-end release.
2. **It turns Traders into a credential-harvesting service.** Users would type their broker
   password into a non-broker site. That trains them to fall for phishing, and it almost certainly
   breaches IBI's terms of use. The terms of Israeli brokerages generally forbid sharing access
   credentials.
3. **2FA makes "stateless" false.** IBI sends an SMS/OTP code, so the server must keep a
   half-authenticated session open while the user types the code. That is state holding a live
   session, which is worse than a token.
4. **"Discarded immediately" cannot be enforced in Node.js.** JS strings are immutable and the
   garbage collector decides when memory is freed. The password stays in the heap for an
   unknown time, and a heap snapshot or core dump contains it. The only sound way to keep a
   secret out of memory is to never receive it.

With Scenario A, IBI's own page handles the password and the OTP. Traders only ever sees a
scoped, short-lived, view-only token. **Ship Scenario A only. If IBI does not offer it, use the
file import (plan B).**

### Other issues with the flow

| # | Issue in the proposed flow | Fix |
|---|---|---|
| 1 | Step 5 writes straight into the portfolio. A broker snapshot that silently replaces holdings can delete positions the user entered by hand (crypto, a second broker). | Sync produces a **preview**. The user confirms **merge** or **replace**, exactly as F1 already does. |
| 2 | "Sync" suggests holdings missing from IBI should be deleted. | Only offer removals when the holdings fetch was **complete**. Removals are listed in the preview, never applied silently. |
| 3 | The primary portfolio has **no cash** by design (migration 0040, D1's fourth layer). Real broker cash in `agent_cash` would break the ledger invariants. | Store IBI cash in its own table (section 4). Do not touch the simulated ledger. |
| 4 | "HTTP/SSE". The standalone HTTP+SSE transport was deprecated in MCP spec 2025-03-26 and replaced by **Streamable HTTP**. | Try Streamable HTTP first and fall back to SSE only if the server is an old one. |
| 5 | IBI's server was built for an LLM. Its tools may return prose or markdown tables, not structured JSON. | Call the tools **deterministically, with no LLM in the loop**. Parse strictly and fail closed. The probe in Step 0 tells us which kind of output we get. |
| 6 | Israeli securities. IBI identifies them by **security number** (מספר נייר ערך). Yahoo quotes TASE in **agorot** (ILA), 1/100 of a shekel. Mutual funds (קרנות נאמנות) and bonds have no Yahoo ticker. FR-3 covers only equity, ETF and crypto. | Map security number → instrument. Normalise ILA → ILS **at the boundary, once**. Rows we cannot classify are shown as `unsupported`, never dropped and never valued at zero. |
| 7 | One-time token and no refresh means a full IBI login plus OTP on every sync. | That is the honest cost of "store no credentials", and acceptable for a manual action. Say so in the UI ("You'll sign in to IBI each time") so it reads as deliberate, not as a bug. |
| 8 | The phone reaches Traders over a Tailscale hostname (#171). The OAuth redirect URI must be registered with IBI. | The browser follows the redirect, so a tailnet hostname works, but registration must accept it. Check this during the probe. |
| 9 | Popups are blocked or awkward on iOS Safari. | Use a full-page redirect on every device. It is simpler and works the same everywhere. |

---

## 2. Architecture

The key decision: **a broker sync is a new *source* of `ImportRow`s, not a new pipeline.**
Everything after parsing already exists and is tested: instrument resolution, candidate picker,
per-row issues, `previewStore`, `merge|replace` in `importCommit`, the first snapshot and
universe-gap recording. The IBI adapter only has to produce rows.

```
Browser                     Orchestrator (TS)                         IBI
───────                     ─────────────────                         ───
[Sync with IBI] ──POST /broker-sync/ibi/start──▶ create sync (pending)
                ◀── { authorizationUrl } ──────  PKCE verifier + state → in-memory, 10 min
navigate ─────────────────────────────────────────────────────────────▶ IBI login + OTP
         ◀──────────────── 302 /broker-sync/ibi/callback?code&state ───
                            exchange code → access token (memory only)
                            MCP connect → tools/list → call holdings, cash
                            drop token, close session
                            map → ImportRow[] → buildRows/resolve
                            savePreview(...)  → sync = previewed
        ◀── 302 /portfolio/sync/:syncId
poll GET /broker-sync/:id  (fetching → previewed | failed)
Preview table (existing ImportWizard step) ── POST /imports/commit {previewId, mode}
```

Files (named after concepts, per convention 4):

```
apps/orchestrator/src/broker/
  ibiMcpSession.ts      MCP client: connect, call a tool, close. Knows nothing about holdings.
  ibiOAuth.ts           OAuthClientProvider kept in memory for a single sync.
  ibiPortfolioMapper.ts Tool output → ImportRow drafts. Pure, so it can be fixture-tested.
  pendingAuthStore.ts   state → { userId, syncId, verifier }, TTL 10 min (same pattern as previewStore)
apps/orchestrator/src/services/brokerSync.ts   orchestrates one sync end to end
apps/orchestrator/src/http/routes/brokerSync.ts
apps/orchestrator/src/db/queries/brokerSyncs.ts
```

`BrokerPortfolioSource` is an interface (guideline 6), so a second broker never touches a call
site:

```ts
// apps/orchestrator/src/broker/portfolioSource.ts
export interface BrokerPosition {
  /** The broker's own identifier - IBI security number, or ISIN when given. */
  brokerRef: string;
  symbol: string | null;
  name: string | null;
  /** Decimal string, never a number (guideline 4). */
  quantity: string;
  /** Per-unit cost in minor units of `currency`; null when the broker does not say. */
  costBasisMinor: string | null;
  currency: string;
}

export interface BrokerCash {
  currency: string;
  amountMinor: string;
}

export interface BrokerSnapshot {
  positions: BrokerPosition[];
  /** null = the cash call failed; never "zero cash". */
  cash: BrokerCash[] | null;
  /** True only when every page of positions arrived. Gates removal suggestions. */
  positionsComplete: boolean;
  fetchedAt: string;
}

export interface BrokerPortfolioSource {
  readonly provider: 'ibi';
  fetchSnapshot(accessToken: string, signal: AbortSignal): Promise<BrokerSnapshot>;
}
```

---

## 3. Backend

### 3.1 Dependency decision (convention 5: ask first)

`@modelcontextprotocol/sdk` would replace a hand-written JSON-RPC client, the Streamable HTTP/SSE
transports, session-id handling and the whole MCP OAuth discovery chain (RFC 9728 → RFC 8414 →
DCR → PKCE). That is several hundred lines of security-sensitive code.
**Recommendation: use it.** Cost: one dependency, and its auth helper assumes the provider stores
state, which we satisfy with an in-memory, single-sync provider (3.3).
*This needs your yes before implementation, and the answer goes into D67.*

### 3.2 MCP session

```ts
// apps/orchestrator/src/broker/ibiMcpSession.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const CALL_TIMEOUT_MS = 20_000;

export class BrokerUpstreamError extends Error {
  // `code` is ours and safe to log; the upstream message never is.
  constructor(readonly code: 'unauthorized' | 'rate_limited' | 'timeout' | 'protocol' | 'unavailable',
              readonly retryAfterSeconds: number | null = null) {
    super(code);
  }
}

export async function withIbiSession<T>(
  serverUrl: URL,
  accessToken: string,
  signal: AbortSignal,
  work: (call: (tool: string, args?: Record<string, unknown>) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  const requestInit = { headers: { Authorization: `Bearer ${accessToken}` } };
  const client = new Client({ name: 'traders', version: '1' });

  try {
    await client.connect(new StreamableHTTPClientTransport(serverUrl, { requestInit }));
  } catch {
    // Pre-2025-03-26 servers only speak HTTP+SSE.
    await client.connect(new SSEClientTransport(serverUrl, { requestInit }));
  }

  try {
    return await work(async (tool, args = {}) => {
      const result = await client.callTool({ name: tool, arguments: args }, undefined, {
        timeout: CALL_TIMEOUT_MS,
        signal,
      });
      if (result.isError) throw new BrokerUpstreamError('protocol');
      // Prefer structured output; text content is parsed strictly by the mapper.
      return result.structuredContent ?? result.content;
    });
  } catch (error) {
    throw toBrokerError(error); // maps 401/403/429/timeout, drops the upstream message
  } finally {
    await client.close().catch(() => undefined);
  }
}
```

Check the exact SDK signatures (`callTool` options, `authProvider`) against the installed version.
The SDK's API has changed between minor releases.

### 3.3 Token lifecycle: one token, one sync

- Ask for the **narrowest scope** that `scopes_supported` lists for read access. **Do not request
  `offline_access`**: no refresh token exists, so none can leak.
- The PKCE `code_verifier` and the OAuth `state` sit in `pendingAuthStore` (in memory, 10-minute
  TTL, single replica, the same reasoning as `previewStore`). This is the only server-side state,
  and it holds no credential.
- The callback checks that **`state` belongs to the signed-in Traders user** who started the sync.
  This stops a login-CSRF attack that would graft someone else's IBI portfolio onto your account.
- The access token lives in one local variable of `brokerSync.run()` and is never put in a
  `Map`, the DB, a log line or an error. When `run()` returns it is unreachable. As 1.B.4 notes,
  that is "unreachable", not "zeroed". It is acceptable for a short-lived, view-only token and
  would not be acceptable for a password.
- If the authorization server offers token revocation (RFC 7009), revoke the token in `finally`.
  Best effort; a failure here is logged by code only.

```ts
// apps/orchestrator/src/services/brokerSync.ts (shape)
export async function runIbiSync(syncId: string, userId: string, code: string, verifier: string) {
  const deadline = AbortSignal.timeout(SYNC_DEADLINE_MS);
  await markSync(syncId, 'fetching');
  let accessToken: string | null = await exchangeCode(code, verifier, deadline);
  try {
    const snapshot = await ibiSource.fetchSnapshot(accessToken, deadline);
    accessToken = null;                      // drop our reference as early as possible
    const rows = await resolveBrokerRows(snapshot.positions, userId);   // reuses importer resolution
    const preview = savePreview(userId, { filename: 'IBI', rows, counts: countByStatus(rows),
                                          removals: snapshot.positionsComplete ? await diffRemovals(userId, rows) : [] });
    await saveBrokerCash(userId, syncId, snapshot.cash);   // null stays null
    await markSync(syncId, 'previewed', { previewId: preview.previewId, counts: preview.counts });
  } catch (error) {
    await markSync(syncId, 'failed', { errorCode: brokerErrorCode(error) });
  } finally {
    if (accessToken) await revokeQuietly(accessToken);
  }
}
```

### 3.4 Mapping and money

- **No floats on the way in.** If the tool returns `structuredContent`, the SDK has already run
  `JSON.parse`, so `1234.56` is a double. Convert with `String(value)`, which gives the shortest
  round-trip representation and is exact for the 2-decimal amounts a broker reports, then pass it
  to the existing decimal → minor-units function. Never multiply by 100 in floating point.
  Text output is parsed by our own strict parser, which keeps numbers as strings.
- **Agorot.** If IBI reports TASE prices or costs in agorot, divide by 100 using integer
  arithmetic in the mapper. Record the unit next to the mapper with a fixture that proves it. This
  is exactly the bug that hides behind a believable number.
- **Validation.** Each position goes through a zod schema. A row that fails becomes an
  `ImportRow` with status `invalid` and an issue, so the preview shows it. **One bad row never
  fails the sync; a malformed envelope does.**

---

## 4. Database (migration 0049, AI service / Alembic)

```sql
CREATE TABLE broker_syncs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id),
  agent_id       uuid NOT NULL REFERENCES agents(id),   -- always the primary
  provider       text NOT NULL CHECK (provider IN ('ibi')),
  status         text NOT NULL CHECK (status IN
                   ('authorizing','fetching','previewed','applied','failed','expired')),
  error_code     text,             -- our enum only; never an upstream message
  positions_seen integer,
  positions_complete boolean,
  preview_id     uuid,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  applied_at     timestamptz
);
-- One sync in flight per user. This doubles as the rate limit on IBI.
CREATE UNIQUE INDEX broker_syncs_one_active
  ON broker_syncs (user_id) WHERE status IN ('authorizing','fetching');

CREATE TABLE broker_cash_balances (
  user_id      uuid NOT NULL REFERENCES users(id),
  agent_id     uuid NOT NULL REFERENCES agents(id),
  provider     text NOT NULL,
  currency     char(3) NOT NULL,
  amount_minor bigint NOT NULL,    -- may be negative (margin); this is not agent_cash
  sync_id      uuid NOT NULL REFERENCES broker_syncs(id),
  as_of        timestamptz NOT NULL,
  PRIMARY KEY (agent_id, provider, currency)
);

ALTER TABLE holdings
  ADD COLUMN source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual','file','ibi')),
  ADD COLUMN broker_ref text,         -- IBI security number, for the next sync's matching
  ADD COLUMN last_synced_at timestamptz;
```

What we do **not** store: tokens, account numbers, the raw tool payload (it is PII and we gain
nothing from keeping it), or upstream error text.

`broker_cash_balances` is **display-only** at first. Whether IBI cash counts in portfolio value is
its own decision. Counting it changes every allocation weight and drift observation, so it should
not ride in as a side effect of sync. Add both tables to the account-reset groups (#185).

---

## 5. Frontend

A state machine with one owner, driven by `GET /broker-sync/:id`:

```ts
// apps/web/src/features/brokerSync/syncState.ts
export type SyncState =
  | { kind: 'idle'; lastSyncedAt: string | null }
  | { kind: 'redirecting' }                          // button pressed, waiting for authorizationUrl
  | { kind: 'fetching'; syncId: string }             // back from IBI, polling every 1.5 s
  | { kind: 'previewed'; syncId: string; previewId: string }
  | { kind: 'applied'; syncId: string; counts: Record<ImportRowStatus, number> }
  | { kind: 'failed'; syncId: string | null; code: BrokerSyncErrorCode };

export type BrokerSyncErrorCode =
  | 'denied'          // user cancelled on IBI's page (error=access_denied)
  | 'auth_expired'    // took > 10 min, state gone
  | 'unauthorized'    // token rejected
  | 'rate_limited'    // shows "try again in N min" from Retry-After
  | 'timeout' | 'unavailable' | 'protocol'
  | 'already_running';
```

- **Entry:** a "Sync with IBI" button on the holdings page, next to the existing import. Its
  subtitle reads "Read-only. You sign in on IBI's site; Traders never sees your password."
  That one sentence answers the trust question before the user asks it.
- **Return page** `/portfolio/sync/:syncId` polls, then renders the **existing `ImportWizard`
  preview step** with the preview id, plus one new section: "In Traders but not at IBI" with
  per-row checkboxes, unchecked by default, shown only when `positions_complete`.
- **Each error code maps to one `t()` key** with a next step ("Sign in again", "Try at 14:32",
  "Import a file instead" linking to plan B). Never show raw upstream text.
- **Idle state shows "Last synced 3 days ago"** from `broker_syncs`, so stale holdings are
  visible, the same principle as a delayed quote.
- All copy goes in `en.json` + `he.json`, with logical directions. Security names from IBI arrive
  in Hebrew and render with `dir="auto"`.

---

## 6. Security checklist

| Threat | Control |
|---|---|
| Token in logs | Add `pino` `redact` for `req.headers.authorization`, `*.accessToken`, `*.access_token`, `*.code`, `*.code_verifier`. Log the callback route **without its query string** (`code` is there). |
| Token in error traces | `BrokerUpstreamError` carries our enum code only. `toBrokerError` throws away `cause`. Errors are never serialised with `cause` or upstream bodies. |
| Token or PII in an error tracker or OpenTelemetry span | Spans name the tool, never its arguments or results. |
| Heap dump / core dump | The container runs with `ulimit -c 0`. There is no heap-snapshot endpoint in production. The token's lifetime is one function call and its scope is view-only. |
| Login CSRF / grafted account | `state` is bound to the Traders user and single-use. PKCE S256 is mandatory. |
| Open redirect | The return URL is fixed server-side and never read from the query. |
| Token passthrough (MCP spec forbids it) | The IBI token is used only against IBI's resource (`resource` parameter, RFC 8707). It is never forwarded anywhere else. |
| Prompt injection via security names | There is no LLM in the sync path. Names are data and are rendered as escaped text. When the scan later narrates holdings, names are already structured evidence. |
| Hammering IBI | One active sync per user (unique index), a 2-minute cooldown after a sync finishes, and `Retry-After` honoured with **no automatic retry** on 429. One retry with jitter on a transient 5xx or timeout, inside the overall deadline. |
| Session timeout mid-sync | Overall `AbortSignal.timeout(60s)`. A 401 during the calls means `unauthorized`; there is no refresh to attempt. |

2FA/MFA needs no handling from us: it happens entirely on IBI's page under Scenario A.

---

## 7. Partial failures

The rule extends F1's existing one: **fail whole on envelope and auth, per row on content, and
never let a gap read as zero.**

| What failed | Result |
|---|---|
| Auth, connect, or `tools/list` missing the holdings tool | Whole sync `failed` with its code. Nothing written. |
| Holdings call fails or times out | Whole sync `failed`. Holdings are the point; a preview without them would mislead. |
| Holdings paginated and a later page fails | Preview the pages that arrived, with `positions_complete = false`: **no removal suggestions**, plus a banner saying the list may be incomplete. |
| Cash call fails | Holdings preview proceeds. Cash is shown as "unavailable" (`null`); the last known balance stays with its own `as_of`. |
| A row with an unknown security number or symbol | `ImportRow` `unresolved`, shown with the candidate picker. The sync continues and a universe gap is recorded (existing `recordMissingTicker`). |
| A row with an unsupported asset class (bond, mutual fund, option) | `ImportRow` `invalid` with an `asset_class` issue saying why - or a new `unsupported` status if the preview should group them separately (today's statuses: `ok`, `ambiguous`, `unresolved`, `invalid`, `duplicate`). Visible, not committed. |
| Resolved but no quote | Committed. It values as **unpriced**, the same as any holding today (guideline 7). |
| User abandons the preview | The preview expires in 30 minutes and the sync goes to `expired`. Nothing was written to `holdings`. |
| Commit called twice | Already idempotent: `commitImport` deletes the preview, and `broker_syncs.status = 'applied'` refuses a second apply. |

---

## 8. Delivery order (one PR each, no stacking)

1. **Probe** (no code merged): endpoint, auth metadata, registration, real tool schemas and a
   fixture. Write D67 with the result: go MCP, or plan B only.
2. **Plan B:** an IBI export column mapper for the F1 import, with a fixture-tested agorot and
   security-number mapping. It is useful on its own and builds the mapper the MCP path reuses.
3. **Migration 0049** (renumbered 2026-10-08: Stage 4 PR 7 took 0047 and 0048) + `brokerSyncs.ts` queries + account-reset groups.
4. **MCP session + OAuth + `brokerSync` service**, hermetic tests against an in-process fake MCP
   server built with the SDK's server half, so there is no network and no IBI in CI.
5. **UI**: button, return page, preview reuse, error copy in en/he.
6. **Cash display** (separate decision on whether it enters valuation).

## 9. Open decisions

1. ~~D67: read-only broker sync is in scope~~ - **decided yes, 2026-10-08** (MEMORY decision 118;
   PRD P1 and the out-of-scope list amended).
2. Add `@modelcontextprotocol/sdk` (section 3.1).
3. Whether IBI cash counts in portfolio value or is display-only (section 4).
4. Whether a synced holding the user later edits by hand keeps `source = 'ibi'` (and is
   overwritten on the next sync) or becomes `manual` (and is protected). Recommendation: it
   becomes `manual`, because a sync should never silently undo a deliberate edit.
