# M10 PR 1 - what public access would expose (measured 2026-10-22)

M10's first step ([MILESTONES.md](MILESTONES.md#m10--public-access-roadmap-added-2026-10-18-decision-155)):
what is reachable today, what a stranger could reach and spend, and what the app holds about them,
with where it is. Read-only. Nothing here is decided. The decisions come at the end, each with its
options, their costs and a recommendation, and this document is what they are argued from.

**How it was measured.**
- The middleware stack, the cookie and every auth route, read by hand: `http/app.ts`,
  `http/auth.ts`, `http/routes/auth.ts`, `http/password.ts`.
- Every route registration under `http/routes/` and `telegram/webhook.ts`: 100, 50 GET and 50 writes. Each write route
  was checked for a read of the signed-in user, either `currentUserId` or a helper, and each
  flagged one was read by hand.
- Which AI-service endpoints each route reaches, and which of those call a model, an embedding
  model, a market-data provider or a news provider.
- The live exposure on this Mac:
  - `tailscale serve status` and `tailscale funnel status`;
  - `docker ps` port bindings;
  - kind's Ingress and Services;
  - `APP_ENV` read inside both running orchestrators.
- argon2id's cost, timed inside the running compose orchestrator: 20 sequential and 20 concurrent
  verifies.
- Compose's Postgres, read in sessions with `default_transaction_read_only = on`:
  - users by status;
  - `installation_settings`;
  - every table and whether it has `user_id`;
  - the foreign keys to `users`;
  - LLM spend by role, purpose and payer;
  - what is stored, and how old the oldest row is.
- `git grep` for outbound email, security headers, rate limiting, retention and export.

Kind runs the same images (`c7e23ee`, read 2026-10-22). Its database was not read for this
document; M9-MEASUREMENT showed both databases have the same shape.

**The short answer.** The data layer is ready, and no route was found that reads or writes
another user's rows. What M10 needs is everything around it. The app has never faced a stranger:
1. It is not built to be served in public. Cookies are not `Secure`, there are no security
   headers, and compose serves the Vite dev server.
2. Nothing limits how often anything is asked. That covers login, signup and every route that
   costs money (D182 left this debt to M10).
3. There is no outbound email. Reset and verification both need it.
4. Signing out does not end the session.
5. A user cannot be deleted, and their data cannot be exported. Deletion is blocked by seven
   foreign keys and by an undeletable reset backup.
6. One user can use up the installation's daily LLM ceiling for everyone.
7. The isolation proof (D240) covers read routes only.

## 1. Exposure today

| Path | What reaches it | Measured |
|---|---|---|
| Phone -> `https://<mac>.<tailnet>.ts.net` | Tailscale-signed-in devices only | `tailscale serve`: `/ proxy http://127.0.0.1:80`, **"tailnet only"**. `tailscale funnel status` is also "tailnet only", so Funnel is off |
| `127.0.0.1:80` -> kind | This Mac | Traefik Ingress `traders` for `traders.localhost` and the tailnet name. Then nginx (production build) serves the page and `/api/*`, and `/api/internal/*` answers 404 |
| Compose | This Mac | Every Traders port is bound to `127.0.0.1`: web 5174, orchestrator 8080, AI service 8001, Postgres 55432, Redis 6379 |
| Kind Services | Inside the cluster | All `ClusterIP`; kind's API server and port 80 are bound to `127.0.0.1` |
| Telegram | Telegram's servers | Compose polls, so nothing is reached inbound. The bot ignores chats with no binding in silence (`telegram/updates.ts:277`) |

**TLS today.** Tailscale terminates it on the Mac with a `ts.net` certificate. Everything behind
it is plain HTTP on loopback.

**If the app were on the public internet**, these hold as the code stands:

| | Today | Where |
|---|---|---|
| **Cookie** | `HttpOnly`, `SameSite=Lax`, path `/`, 168 h. `Secure` only when `APP_ENV=production`, and **both running orchestrators read `development`**. The k8s README says it must stay so while the cluster serves plain HTTP | `routes/auth.ts:96-103`, `config.ts:190`, `infra/k8s/README.md:123` |
| **CSRF** | `SameSite=Lax` plus an Origin check on non-GET requests. A request **with no `Origin` header passes** the check; only a foreign Origin is refused. `/internal/*` is exempt and uses its key | `http/app.ts` (the `bad_origin` middleware) |
| **CORS** | An exact list, `ALLOWED_ORIGINS`, with credentials. Compose: three localhost origins. Kind: `traders.localhost` plus the tailnet name, added per deploy | `http/app.ts`, `config.ts:41`, `scripts/k8s-up.sh` |
| **Security headers** | **None.** No CSP, HSTS, `X-Frame-Options`/`frame-ancestors` or `X-Content-Type-Options`, in nginx or the orchestrator (`git grep`: no match) | `infra/docker/nginx.conf` |
| **What compose serves** | The **Vite dev server** (`Dockerfile.web` target `dev`, `host: true`), whose proxy forwards `/api/internal/*` too. Only kind serves the production build | `infra/compose/docker-compose.yml:196-209`, `apps/web/vite.config.ts` |
| **Client IP** | Not used by anything except the admin audit, which records the whole `X-Forwarded-For` chain as claimed. Behind Tailscale -> Traefik -> nginx, which hop is the client is **unknown** (not measured) | `http/adminAudit.ts` |
| **Secrets** | `SESSION_SECRET` and `INTERNAL_API_KEY` are generated per deploy (`openssl rand`). Compose's app database role uses the compose file's default password (`APP_DB_PASSWORD` is unset in `.env`), reachable only from loopback | `scripts/lib/dev-common.sh:34`, `scripts/k8s-up.sh:142-146` |
| **Host** | A Mac running Docker Desktop: kind and compose side by side. Its uptime and whether it sleeps were **not measured** | - |

## 2. Auth as M9 built it

| Part | As built | Where |
|---|---|---|
| Credentials | Email and password; argon2id from `@node-rs/argon2`, **m=19456 KiB, t=2, p=1**. Passwords are 12-128 characters with no composition rules (D181) | `http/password.ts`, `packages/shared/src/password.ts` |
| Cost of one guess | **65 ms** per verify (mean of 20 in a row), and **20 concurrent verifies took 566 ms** (10 CPUs). So about 35 unthrottled guesses a second | timed in `traders-orchestrator-1` |
| Login | One answer for "no such email" and "wrong password", with the same argon2 work for both (a decoy hash). `pending` gets its own code only with the right password (D187) | `routes/auth.ts:110` |
| **Rate limit** | **None, on any route** (D182). `git grep` finds no limiter; the orchestrator already depends on `ioredis` and `bullmq`, so Redis is there | `apps/orchestrator/package.json` |
| Signup | Always answers `received` (D185); only a new email messages the admin. **The password is hashed before the "closed" check**, so every request costs one argon2 hash. Compose: **`max_pending_signups = 0`**, so sign-up is closed | `routes/auth.ts:144`, `installation_settings` |
| Session | `base64url({uid, ver, exp}).hmac`, 168 h. Every request reads the user and requires `active` plus a matching `session_version` (D160) | `http/auth.ts`, `http/app.ts` |
| **Sign out** | `POST /auth/logout` deletes the cookie in the browser and nothing else. **A copied cookie stays valid until it expires** (up to 7 days). Only a password or email change, a disable, or an admin one-time password ends it, and each of those ends every session the user holds | `routes/auth.ts:178` |
| Recovery | The admin's one-time password (D162, D239), or `scripts/admin-password.sh` for the admin | `routes/admin.ts:356` |
| Email ownership | **Never verified.** `users` has no verified-at column, and `/auth/email` changes the address with the password alone (its comment: "no outbound email before M10") | `routes/auth.ts:227`, `\d users` |
| Shape of `users` | `password_hash` is nullable (an account without a password is representable), `lower(email)` is unique, and status is one of `pending`/`active`/`rejected`/`disabled` | compose `\d users` |
| Gate | Two routes outside the protected prefixes, `/narration` and `/universe/taxonomy`, call `currentUserId` themselves. That also means they skip the one-time-password refusal; both are read-only | `http/app.ts` `PROTECTED_PREFIXES` |

Live users on compose: 1 admin (`active`), 1 user (`active`, cap $5, own key `valid`) and
1 `rejected` request. Each has an email and a hash.

**What OAuth would need, measured against this:**
- **A table**: provider + subject -> `user_id`. Nothing like it exists.
- **A callback route** at a public HTTPS redirect URI that is registered with Google and with
  GitHub.
- **Short-lived state** for `state` and PKCE.
- **A linking rule** for a provider email that matches an existing account.

`password_hash` is already nullable, so an OAuth-only account fits `users` as it is. Whether
a `*.ts.net` name is accepted as a redirect URI or an authorized domain was **not checked**
(it needs the providers' consoles).

**What self-service reset would need:**
- outbound email (§5);
- a single-use, expiring token, stored hashed;
- a route that sets the password and bumps `session_version`, the same as a password change
  does today;
- the same answer whatever the email (D185's rule).

**Is a sessions table now required?** Not for anything M9's mechanism already covers: a reset
bumps the version, and a disable checks status. A table is required for three things the cookie
cannot do:
- a sign-out that ends **this** session, rather than none or all;
- a list of devices;
- revoking one stolen cookie without signing the user out everywhere.

The cost of each is in decision 8.

## 3. Abuse and cost surface

**Who can reach what:**

| Caller | What they can reach | What it costs |
|---|---|---|
| Signed out | `/auth/login`, `/auth/signup`, `/auth/logout`, `/auth/session`, `/healthz`, `/readyz`, `/telegram/webhook` (needs the secret header) | Login and signup each cost one argon2id (~65 ms CPU, 19 MiB). With signup open, each new email sends the admin one Telegram message, up to `max_pending_signups` |
| `pending`, `rejected`, `disabled` | The same as signed out: login refuses them, so they never get a session | The same |
| `active` user | The 79 routes outside `/admin/*` (20) and `/internal/runs` | Below |

**What an active user can spend:**

| Spend | Routes | Bound today |
|---|---|---|
| **LLM, installation's key** | `POST /agents/:id/scans`, `POST /proposals/:id/recheck`, `POST /agents/:id/instructions-check`, `POST /assistant/messages`, Telegram questions. Scheduled scans and narration for their holdings run unasked | Checked before each call: the monthly cap (D203; default $10 from `installation_settings`), then each agent's daily allowance, then the assistant's $0.50 a day. **`LLM_DAILY_BUDGET_USD` ($5 on compose) is one installation-wide UTC-day ceiling shared by everyone** |
| LLM, own key | The same routes | The installation's limits are off; OpenRouter's limit on the key applies (D206, D210, D211). The agent and assistant allowances still apply |
| **Embeddings** (OpenRouter on compose: `EMBEDDINGS_PROVIDER=openrouter`) | `GET /concepts/search`, `POST /topics/resolve`, `POST /topics` | **Not metered, not capped and not in `llm_calls`.** Logged only; by the module's own note a query is about 10 tokens (`corpus/openrouter_embedder.py`). The live count is **unknown** |
| **Market data** (yfinance, unofficial) | `POST /holdings` and `POST /imports/preview` (one resolve per symbol; the file may be up to 2 MiB), `POST /topics/resolve`, `GET /portfolio` (quotes, 60 s cache), history, trade previews, fills | **60 requests a minute per provider, shared by every user** (`provider_rate_limit_per_minute`). One user can use it up for everyone, and whether Yahoo blocks this host's address under load is **unknown** |
| News (GDELT) | No user route fetches it; the routes read what `news_collect` stored | None needed |
| Process memory | `POST /imports/preview` | The preview store is in-process and **capped at 20 entries for the whole installation** (`services/previewStore.ts`). It is keyed by user, so nobody sees another's preview, but one user's uploads evict everyone else's |
| Scan queue | Manual and scheduled scans | One BullMQ queue; scheduled scans are interleaved across users (D161), and manual scans join the same queue |
| Rows | Agents: 3 active, 50 not archived. Targets: 500. Conversations: deleted after 90 quiet days | Per-user ceilings on topics, holdings and imports were **not measured** |

**Measured spend (compose, `llm_calls`, 2026-09-30 to 2026-10-21, 487 calls):**

| Payer | Who | Calls | USD | Largest single call |
|---|---|---|---|---|
| installation | admin | 463 (agent_scan 71, ask 10, assistant 46, mandate_check 3, narration 333) | **$0.3383** | $0.0128 (an agent scan) |
| own key | the one user | 24 | $0.0162 | $0.0013 |

The installation's costliest UTC day was 2026-10-07 ($0.108, 32 calls); the busiest was 2026-10-17
(170 calls, $0.066). So real load has reached at most about 2% of the $5 daily ceiling.

**What the limits imply, worked out from the settings above** (not observed):
- One user with a $10 cap and three agents can pass the $5 daily ceiling on their own. From then
  until UTC midnight, every user's narration falls back to the template, and every
  installation-paid scan and Ask turn is refused, the admin's included.
- With approval removed, nothing stops one person from opening many accounts. Each account has
  its own cap, and emails are never verified.

## 4. Data isolation

**Every user-owned table carries `user_id`.** The live schema has 46 tables, and 29 have the
column:
- `NOT NULL` on 26.
- Nullable on 3, each for installation rows by design (D238): `llm_calls` (a call with no
  user), `runs` (installation kinds) and `ops_events`.

The 17 tables without it are shared or installation data:
- Market and reference data: `instruments`, `quotes`, `articles`*, `article_entities`,
  `article_sentiment`, `instrument_profiles`, `etf_holdings`, `universe_*`, `kb_*`,
  `news_feed_cursors`.
- Installation configuration: `installation_settings`, `llm_model_choices`, `alembic_version`.
- Keyed by something else: `admin_audit` (`admin_user_id`) and `users` itself.

A user's input reaches a shared table in one place: `upsertInstrument`. It runs only after the
market-data provider has resolved the symbol, and it never writes a user's notes or quantities
there (`routes/holdings.ts:189`).

**Row-level security is off on every table** (`relrowsecurity = f`). Isolation is the
application's `WHERE user_id = $1`, as it has been since M1.

**Routes.** Every one of the 32 signed-in write routes reads the signed-in user, either through
`currentUserId` or a helper. That count excludes `/admin`, `/internal`, `/auth` and the Telegram
webhook. Seven go through a helper and were read by hand: three through `ownKeyUser`, two through
`confirmed` (topics), and two through `getAgent(userId, …)` (trades).

**What the D240 exit test covers, and what it does not:**

| Covered | Not covered |
|---|---|
| Every GET route outside `/admin`, `/internal`, `/auth` and the probes, read from the app (37) | **Write routes** (POST/PUT/PATCH/DELETE) asked with the other user's ids. Single-feature tests cover some: `proposalsApi`, `holdingDetailApi`, `assistantApi` |
| Marked rows of four kinds: agent, holding, topic, conversation | Proposals, observations, notifications, agent scans, fills, snapshots, own keys. A GET that leaks one of these would pass |
| The fan-out, a run with no user, a disabled user's cookie | Telegram: a callback or message from another user's chat. The code resolves the chat to its binding (`telegram/updates.ts`), but the exit test does not walk it |

\* `articles` are shared by design: news is collected once for the union of instruments (D238).

## 5. Outbound email

**There is none.** `git grep` finds no mail package, SMTP setting or sending code in `apps`,
`services`, `packages`, `infra` or `.env.example`. Everything that reaches a user goes through
the screen or Telegram. A user without a Telegram binding can be reached only on the screen.
Every M10 feature that proves an address (verification) or reaches someone who cannot sign in
(reset) needs a new outbound channel. Sending from a domain also needs DNS records (SPF/DKIM)
on a domain the operator controls; this installation has no domain of its own (§1).

## 6. Privacy and legal surface

Facts only: what is held, where it goes, how long it stays and what a user can do about it.

**What is held about a user:**
- Email, password hash, time zone, last sign-in and Telegram chat id.
- Holdings: quantities, cost basis per unit and free-text notes. Imported broker files are
  parsed, not stored (the preview lives in memory for 30 minutes).
- Agents' instructions and their virtual ledgers.
- Observations, proposals and notifications.
- Ask conversations: the user's questions and the answers, as text.
- **`llm_calls.prompt` and `completion`, verbatim.** Live: 487 of 487 calls have a prompt and
  431 a completion. Scan and assistant prompts carry the user's holdings and instructions.
- An own OpenRouter key, encrypted (D208).

**Where it goes outside the installation:**
- OpenRouter, and through it the model's provider: prompts with holdings and instructions.
- Yahoo Finance: symbols.
- Telegram: alert and digest text, and Ask answers.
- OpenRouter's embedding model: concept and topic search text.

**How long it stays:**

| What | Retention | Where |
|---|---|---|
| `llm_calls`, prompts included | Pruned past 32 days on each insert (D204). The oldest live row is from 2026-09-30 | `llm/call_log.py`, `LLM_CALL_RETENTION_DAYS` |
| Ask conversations | 90 days after the last message | `assistant/conversations.py:24` |
| Holdings, observations, proposals, notifications, ledgers | **Until the user resets or the row is deleted; no expiry** | - |
| **`account_resets.backup`** | **Forever.** A reset keeps a JSON copy of every row it erased, and the app's database role **cannot delete it** (`REVOKE … DELETE` in `0045`). Live: 2 | `alembic/versions/0045_account_reset.py:84` |
| Database backups | 14 most recent, plus weekly ones up to 56 days. **Unencrypted** `pg_dump` files in `~/Backups/traders/<env>` (directories `chmod 700`). Live: 30 files for compose, the newest from 2026-10-22 01:00 UTC | `scripts/lib/backups.sh:27-28`, `scripts/db-backup.sh:99` |

**What a user can do:**
- **Delete their account: no.** There is no route, and `DELETE FROM users` still fails
  (M9-MEASUREMENT §7, re-read live). Seven foreign keys to `users` have no `ON DELETE` action:
  `admin_audit`, `agent_cash`, `agent_scans`, `assistant_conversations`, `cash_movements`,
  `fills` and `proposal_attempts`.
- **Erase their data:** the reset erases by group, but its backup row stays (above).
- **Delete one conversation:** yes (`DELETE /assistant/conversations/:id`).
- **Export their data: no.** No route and no button.
- **Read a privacy policy or terms: no.** The web app has neither. The only legal text is the
  disclaimer ("Educational and informational only. Nothing here is investment advice…").

**What the operator can read:** the whole database, stored prompts included. D162 says so
plainly for M9's household. It stays true with strangers, who have not been told.

**Which laws apply** depends on where the operator and the users are. That was not measured
and is a question for a lawyer, not for this document. The facts that question would start from
are the ones above.

## Decisions M10 needs

Each decision below has its options, what each costs, and a recommendation. None is taken here:
they are asked one at a time. Where a maintained package would replace non-trivial code, it is
named; choosing it is the user's call (convention 5). Migration numbers start at `0068`; `main`
has one Alembic head, `0067_telegram_conversation` (read 2026-10-22).

1. **Who gets in, and what gate replaces approval.**
   - (a) Keep D156's approval and only open the door: every stranger waits for the admin.
     Costs: the admin judges strangers they cannot judge, and every request is a Telegram ping.
   - (b) Automatic activation after the email is verified, with a daily ceiling on new accounts.
     Approval stays as an installation switch (`signup_mode`: approval / automatic / closed).
     Costs: a setting and a verification step; one person can still open several verified
     accounts.
   - (c) Invite codes the admin hands out. Costs: not "people the admin doesn't know".

   **Recommendation: (b).** It is what M10 says. The switch lets the admin fall back to approval
   or close the door in one setting, the way `max_pending_signups = 0` closes it today.

2. **Where it is served, and under what name.**
   - (a) Tailscale Funnel from this Mac. Costs: no domain of your own (`ts.net`), so mail
     cannot be sent from it; Funnel's limits and terms were not checked.
   - (b) A domain you own, served through a tunnel from the Mac (Cloudflare Tunnel), with no
     inbound port opened. Costs: a domain (yearly fee), and Cloudflare terminates TLS, so it
     sees requests in the clear; the Mac's uptime becomes the service's.
   - (c) A domain plus a small rented server running the same images. Costs: a monthly bill, a
     second environment to deploy and back up, and strangers' data leaving this Mac.

   **Recommendation: a domain either way** (OAuth consoles and email sending both want one),
   **served by (b) for a capped first phase.** Move to (c) as its own decision when uptime or the
   number of users asks for it. Exposure is flipped on only on your word, after the hardening
   PRs.

3. **The production baseline** (no new dependency).
   - `APP_ENV=production` behind TLS, which turns on `Secure` cookies; the k8s README's warning
     about plain HTTP is satisfied by the tunnel.
   - Security headers in nginx: CSP, HSTS, `frame-ancestors 'none'`, `nosniff`.
   - Non-GET requests **without** an `Origin` are refused.
   - Only kind's nginx build faces the internet, never compose's Vite dev server.
   - Which `X-Forwarded-For` hop is the client is fixed, so the limits below key on the real
     address.

   The alternative is to take these piecemeal, per PR. Its cost: a gap while some are missing.
   **Recommendation: all of it, as the first code PR.**

4. **Rate limiting** (D182's debt). Package options:
   - `rate-limiter-flexible` on the Redis the orchestrator already uses. Costs: one dependency;
     sliding counters keyed by anything.
   - `hono-rate-limiter`. Costs: a smaller API; its Redis store is a separate package.
   - Hand-written `INCR`/`EXPIRE`. Costs: the code convention 5 asks about.
   - Only at the edge (Cloudflare rules). Costs: ties limits to option 2(b), and they cannot see
     users.

   Scopes: login per account and per address; signup and reset requests per address and per
   email; the model and provider routes of §3 per user.

   **Recommendation: `rate-limiter-flexible` on the existing Redis.**

5. **Outbound email: provider and package.**
   - `nodemailer` over SMTP behind an `EmailSender` interface (guideline 6), with the provider
     chosen by environment (Postmark, Resend and SES all speak SMTP). Costs: one dependency;
     the domain's SPF/DKIM records.
   - A provider's own SDK. Costs: ties the code to one provider.
   - None: keep Telegram-only. Costs: no reset or verification for anyone without a binding,
     which is every new stranger.

   **Recommendation: `nodemailer` + SMTP behind the interface**, with a fixture sender in tests
   (hermetic, guideline 7's spirit). The provider is your account to open.

6. **Email verification.**
   - (a) Required before an account is active.
   - (b) Required before a reset can be sent.
   - (c) Not required.

   The cost of (a) and (b) is a token table and a "check your inbox" screen. **Recommendation:
   (a)**, because decision 1(b) rests on it. Applies to signup and to `/auth/email` (a new
   address is verified before it replaces the old one).

7. **Self-service reset.** Design options:
   - A single-use token, stored as its SHA-256, expiring in 30-60 minutes (an `auth_tokens`
     table shared with verification: `0068`).
   - A signed, stateless token. Costs: it cannot be single-use without a table anyway.

   The same answer whatever the email (D185). Success bumps `session_version`, ending every
   session. **Recommendation: the table**, one migration for both purposes.

8. **Sessions table.**
   - (a) Keep D160's cookie and add "sign out everywhere" (a version bump). Costs: sign-out on a
     shared computer still leaves a copied cookie valid for up to 7 days.
   - (b) A `sessions` table. The cookie carries a session id, and each request reads it with the
     user (one indexed read, which the request already makes for `users`). Sign-out deletes the
     row; Settings lists devices. Costs: a migration, a cleanup of expired rows and a test
     surface.
   - (c) A shorter cookie lifetime. Costs: everyone signs in more often.

   **Recommendation: (b).** D160 rejected it for a household where "end at once" was the whole
   requirement. With strangers, "sign out ends this session" is a requirement too.

9. **OAuth package.**
   - `arctic`: small OAuth 2.0 clients for Google and GitHub, with no opinion on sessions or
     users. Costs: we store `state`/PKCE (a short cookie) and the identities table.
   - `openid-client`: certified OpenID Connect. Costs: GitHub is OAuth, not OIDC, so it needs a
     second path.
   - `better-auth` or Auth.js: a whole auth framework. Costs: it brings its own users and
     sessions, which would replace M9's, and M10 is meant to leave that layer alone.

   **Recommendation: `arctic`**, plus a `user_identities` table (provider, subject, `user_id`).

10. **Linking an OAuth sign-in to an existing account.**
    - (a) Link automatically when the provider says the email is verified (Google's
      `email_verified`; GitHub's verified primary email).
    - (b) Never link automatically: link from Settings while signed in.
    - (c) Always link by email.

    Costs: (b) means a user who signs up by password and later clicks "Google" gets a second
    account; (c) lets anyone who controls an unverified provider address take an account.
    **Recommendation: (a)**, falling back to (b) when the provider cannot vouch for the address.

11. **The free tier.**
    - (a) Self-signed-up accounts get the existing default cap ($10).
    - (b) A separate, lower default for automatic accounts, set on the Admin page.
    - (c) Own key only: strangers get no installation-paid model calls.

    Separately, should one user be able to use up the installation's daily ceiling? The option
    against it is a per-user share of `LLM_DAILY_BUDGET_USD`.

    **Recommendation: (b)**, plus a per-user daily share, so one stranger cannot silence
    everyone's narration (§3). Embeddings and market data are bounded by rate limits (4), not
    metered.

12. **Deletion and export.**
    - Delete account: erase now, after a grace period, or not at all. A migration settles the
      seven foreign keys of §6, and `account_resets` goes with the user. Backups age out within
      56 days, which the policy states.
    - Export: a JSON download of the user's own rows, or none.

    Costs: one migration and two routes. Not offering them is a fact strangers would have to be
    told. **Recommendation: delete with a 7-day grace period, and a JSON export.**

13. **Legal pages and consent.**
    - (a) Privacy policy and terms pages, with the signup recording which version was accepted.
    - (b) No pages.

    The app ships the pages and the record; **their wording is yours or a lawyer's**, not this
    document's. **Recommendation: (a), and no public signup until the pages have content.**

14. **The isolation proof for strangers.**
    - Extend D240's test to write routes, asked with the other user's ids, and to seed every
      user-owned kind of §4.
    - Add Postgres row-level security as a second wall. Costs: every query runs under a
      per-request setting, which changes the data layer M10 is meant to leave alone.

    **Recommendation: extend the test; no row-level security in M10.**

15. **Order of the PRs.** A proposal, to settle once the answers above are in:
    1. the production baseline and rate limits;
    2. email (the sender, verification and reset), with `0068`;
    3. sessions;
    4. OAuth and linking;
    5. the free tier and the signup switch;
    6. deletion and export;
    7. the legal pages;
    8. the isolation test;
    9. exposure itself, last, on your word.
