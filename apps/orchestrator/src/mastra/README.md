# Mastra workflows

One workflow lives here: `proposalLifecycle`. It raises a proposal, suspends
until a human answers, and ends on approve, reject or expiry.

| File | Owns |
|---|---|
| `proposalLifecycle.ts` | the workflow, and the three functions the rest of the orchestrator calls: `startProposalLifecycle`, `decideProposal`, `sweepAndCloseLifecycles` |
| `workflowRuntime.ts` | the single Mastra instance, its Postgres storage, and the rule that every caller must survive its absence |

## Why only one workflow

MILESTONES.md M4 lists four - `portfolioScan`, `topicScan`, `dailyDigest` and
this one. **We adopted Mastra for `proposalLifecycle` only, and deliberately did
not port the scheduling half.**

Run kinds, run keys, the half-hour bucket and the claim in the `runs` table
already work, are tested, and answer the question a scheduler has to answer:
*did this already happen?* Re-expressing that against a new engine would buy a
different spelling of the same behaviour, and risk a regression in the one part
of the system whose failure mode is silence. Mastra's scheduling would also want
to own the trigger, and DESIGN.md §2 has exactly one trigger path -
`POST /internal/runs` - precisely so a Kubernetes CronJob and a local timer
cannot both fire.

What the scheduler genuinely cannot express is a **suspension**: a run that
pauses for hours waiting on a person and is still there after a restart. That is
what `suspend`/`resume` with Postgres-backed snapshots buys, it is the whole
reason the dependency earns its place, and it is the only thing it is used for.

## The rule that keeps this honest

**The state machine is `services/proposalState.ts` and `services/proposals.ts`.
Nothing in this directory decides anything.** Every transition goes through
`applyDecision`, because F3's invariants are properties of the system rather than
of a code path: "an expired proposal can never be approved" stops being true the
moment one surface can reach the `UPDATE` without passing the check. A condition
on a proposal's state that is about to be written here belongs in
`proposalState.ts` instead.

The dependency runs one way. `mastra/` imports from `services/`; `services/` must
not import from `mastra/` - with one deliberate exception, `portfolioScan.ts`,
which is the composition point where a scan hands its findings to the lifecycle.

## Everything degrades

`getWorkflowRuntime()` returns `null` when the runtime was never initialised - in
tests, or in a process that booted before migration 0007 ran - and every entry
point has a path that works anyway:

| Situation | What happens |
|---|---|
| no runtime | `startProposalLifecycle` raises the proposal directly; `decideProposal` applies the decision directly |
| no run for this proposal (raised before this PR) | the decision is applied directly |
| resume throws | the error is logged and the decision is applied directly |

That is the point of a coordinator rather than a gatekeeper: `applyDecision` is
idempotent by construction - its `UPDATE` is conditional on the state that was
read - so a fallback after a partial failure re-reads rather than re-applies, and
no user's decision is lost to an outage in a layer they never touched.

## Identity: a run id is an observation id

A lifecycle's run id is the id of the **observation** the proposal was raised
from, not the proposal's own id - the proposal does not exist until the first
step has run. It also comes for free: `proposals_one_per_observation` already
allows one proposal per observation, and the unique key on
`(workflow_name, run_id)` now allows one workflow per observation, under the same
identity, with no second deduplication scheme to keep in step with the first.

## Storage

Suspended runs live in `mastra.mastra_workflow_snapshot`, created by
`services/ai/alembic/versions/0008_mastra_workflow_state.py`. Three things about
that are deliberate and are argued in the migration itself: a separate `mastra`
schema, Alembic owning the DDL (`disableInit: true` on the store), and only the
`workflows` domain being wired - `PostgresStore` would otherwise create
forty-three tables for the twenty-four domains this product does not use.
`test/mastraSchemaOwnership.test.ts` fails the build if a Mastra upgrade changes
the shape the migration hard-codes.

## Still to come in M4

Telegram: the signed binding deep link, the webhook, and single-use signed
callbacks. A callback decides through `decideProposal` with `surface: 'telegram'`
and an `idempotencyKey`, which the audit table already has a unique index for.
Notification fan-out hangs off the resumed continuation, which is the seam this
workflow was bought for.
