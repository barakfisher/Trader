# Application review, 2026-11-10

Eight role reviews of the repository at `95e4c6e` (VERSION 0.0.3). Each was written by an
independent reviewer reading source and documents; none ran the stack, a model or production.

| Role | File |
| --- | --- |
| Analyst / investor | [review-analyst.md](review-analyst.md) |
| Product, design, user journey | [review-product.md](review-product.md) |
| Security | [review-security.md](review-security.md) |
| Software engineering / architecture | [review-engineer.md](review-engineer.md) |
| Database | [review-db.md](review-db.md) |
| Backend | [review-backend.md](review-backend.md) |
| Frontend | [review-frontend.md](review-frontend.md) |
| DevOps / operations | [review-devops.md](review-devops.md) |

## What was verified, and what was not

- The lead reviewer re-read the cited lines behind ten of the top findings (marked ✔ below); all
  ten matched. The remaining findings are the reviewers' own reading and have not been re-checked.
- The database review could not measure anything: the local database was down at the time.
- Visual review: signed-out screens, then the signed-in screens at phone width in Hebrew on the
  local compose copy (see the two "Seen in the running UI" sections of the product review, which
  list what was not seen). Two defects were measured there: Ask overflows sideways at 375 px, and
  the dashboard's "Account" card includes the agents' paper cash under a "holdings only" caption.
- Nothing was checked against production. Each file's "Unverified" section names the command or
  query that settles each open point.

## Findings that more than one role reached

1. **Backups: one unencrypted copy on a laptop, silent when it fails, none taken before a
   migrating deploy.** Security 2, Database 1-2, DevOps 2-4. ✔ (`scripts/db-backup.sh:134-145`)
2. **Nothing watches production**: no uptime check, no signal when the scheduler stops, and a
   scan interrupted by a restart leaves its slot dead. DevOps 1, Backend 4.
3. **"Owner-only" premises that no code enforces** before a second user arrives: Langfuse text
   capture (D375), Yahoo descriptions (D396). Security 1, Product roadmap. ✔
   (`services/ai/app/config.py:281`)
4. **Valuation in TypeScript uses floats and returns 0 for bad input**, against guidelines 3
   and 7; portfolio maths is implemented in both languages on different bases. Engineer 3-4,
   Backend 8, Analyst 14. ✔ (`packages/shared/src/money.ts:69-89`)
5. **The figure check proves a number exists in the evidence, not that it is the right number**,
   and a scan's overview thesis beside its trades is not checked at all. Backend 2-3, Analyst 5.
   ✔ (`services/ai/app/agents/scan.py:603-611`, `services/ai/app/assistant/tools.py:368-376`)
6. **Synchronous SQL with no timeouts, transactions held across model calls.** Database 3,
   Backend 6.
7. **Unlocked Python dependencies**: production does not run what CI tested. Engineer 2, DevOps 7.
8. **No linter, no browser-level test, no error boundary or client error reporting.** Frontend
   1 and 5, Engineer 8-9.

## The top of each role

- **Analyst:** research views on the real portfolio rest on 60 days of prices and a headline
  score; no corporate actions; the real portfolio has no return, benchmark or realised P&L.
- **Product:** the own-key requirement is a hidden wall; no first-run path (the empty dashboard
  names a repository file ✔ `en.json:981`); the first scan mostly ends in "No trade"; the digest
  is only counts.
- **Security:** no outside-exploitable hole found; a Telegram binding survives a password change
  ✔ (`apps/orchestrator/src/db/queries/users.ts:144-154`); the admin has one factor and can issue
  a one-time password for any account.
- **Backend:** a muted or failed digest discards its entries ✔
  (`apps/orchestrator/src/services/notifications.ts:372-404`,
  `db/queries/notifications.ts:94-96`); a push that fails once is lost.
- **Frontend:** a failed session check shows the sign-in form ✔
  (`apps/web/src/stores/AuthStore.ts:90-93`); one bundle with no lazy routes; modals do not trap
  focus.
- **Engineer:** `.claude/MEMORY.md` is 10,259 lines and the only home of the decisions.
- **Database:** retention was decided at pre-public volumes; the schema has no single readable
  form.
- **DevOps:** losing the VM loses `LLM_KEY_ENCRYPTION_KEYS`, which the backup depends on.
