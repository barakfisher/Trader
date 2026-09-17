/**
 * The proposal lifecycle as a durable workflow: raise, wait for a human, end.
 *
 * FLOWS.md F3 is a state machine, and it already has an implementation -
 * `services/proposalState.ts` for the rules and `services/proposals.ts` for the
 * writes. **Nothing here re-decides anything.** Every transition in this file
 * goes through `applyDecision`, because F3's invariants ("an expired proposal
 * can never be approved") are properties of the system rather than of a code
 * path, and a second implementation is a second implementation that disagrees.
 * If you are about to add a `if (state === ...)` below, it belongs in
 * `proposalState.ts` instead.
 *
 * **What Mastra buys, then.** One thing, and it is the thing the existing
 * scheduler cannot express: a run that suspends for hours waiting on a person
 * and survives a restart. Today a proposal is a row that anybody may poll and
 * nothing is *waiting* on it; a suspended run is a resumable continuation, so
 * "when the answer arrives, do the rest" becomes something the code can say.
 * The rest is currently small - terminate, and report the final state - and the
 * notification fan-out and the Telegram message edit are what hang off it next.
 * The dependency is being bought for that seam, and the PR says so plainly.
 *
 * **Every entry point degrades.** If the runtime was never initialised, or the
 * run is missing, or a resume throws, each function here falls back to calling
 * the service directly. A coordinator that can block a decision the user made
 * is worse than no coordinator, and `applyDecision` is idempotent by
 * construction - its UPDATE is conditional on the state that was read - so a
 * fallback after a partial failure re-reads rather than re-applies.
 */

import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import { findProposal } from '../db/queries.js';
import { logger } from '../logger.js';
import {
  applyDecision,
  factsOf,
  isProposableKind,
  meetsSeverity,
  raiseProposals,
  sweepExpiredProposals,
  type DecisionInput,
  type DecisionOutcome,
  type FindingForProposal,
} from '../services/proposals.js';
import { effectiveState, isTerminal } from '../services/proposalState.js';
import { getWorkflowRuntime } from './workflowRuntime.js';

/** The key the workflow is registered and looked up under. */
export const PROPOSAL_LIFECYCLE_ID = 'proposalLifecycle';

/** The step that holds the suspension. Named because `resume` addresses it. */
export const AWAIT_DECISION_STEP = 'await-decision';

/** The step that raises the proposal, and the run's only write before the wait. */
export const RAISE_PROPOSAL_STEP = 'raise-proposal';

/**
 * The settings a raise depends on. The same two fields `raiseProposals` takes,
 * and deliberately not the whole settings row: a workflow input is persisted
 * inside the run snapshot, and persisting a copy of every notification
 * preference would mean a suspended run carries a stale answer to a question it
 * never asked.
 */
const settingsSchema = z.object({
  proposalSeverity: z.string(),
  proposalTtlHours: z.number(),
});

const findingSchema = z.object({
  id: z.string(),
  kind: z.string(),
  severity: z.string(),
  subjectRef: z.string().nullable(),
  evidence: z.unknown(),
});

/**
 * What a resume carries. `refresh` is not a decision: it is the sweep saying
 * "the clock has moved", and it exists so an expiry can end a run without
 * inventing a user who decided something. Everything else maps one-to-one onto
 * `ProposalAction`, and is applied by `applyDecision` rather than interpreted
 * here.
 */
const resumeSchema = z.object({
  action: z.enum(['approve', 'reject', 'snooze', 'refresh']),
  surface: z.enum(['web', 'telegram', 'system']),
  /**
   * The moment the decision was made, decided at the edge and carried in rather
   * than read from the clock inside the step. `proposalState.ts` made `now` an
   * argument so that "an expired proposal can never be approved" is testable
   * without waiting an hour; a workflow step that called `new Date()` would put
   * the one unmockable clock back in the middle of it.
   */
  decidedAt: z.string(),
  /** ISO 8601 UTC, like every other timestamp that crosses a boundary. */
  snoozeUntil: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

/**
 * The outcome is typed as `DecisionOutcome` and validated as `unknown` on
 * purpose. Restating that union in zod would be a second definition of a type
 * the service already owns, and the two would drift the first time a refusal
 * reason is added - which is exactly the failure this workflow is not allowed
 * to have.
 */
const outcomeSchema = z.unknown();

const lifecycleOutputSchema = z.object({
  proposalId: z.string().nullable(),
  /** The state the proposal ended in, or null when none was ever raised. */
  finalState: z.string().nullable(),
  outcome: outcomeSchema,
});

const raiseProposalStep = createStep({
  id: RAISE_PROPOSAL_STEP,
  inputSchema: z.object({
    userId: z.string(),
    finding: findingSchema,
    settings: settingsSchema,
  }),
  outputSchema: z.object({ userId: z.string(), proposalId: z.string() }),
  execute: async ({ inputData, bail }) => {
    const { userId, finding, settings } = inputData;
    // The cast is zod's doing: `z.unknown()` infers an optional key, and a
    // finding's evidence is not optional - it is the thing the decision will be
    // audited against. The shapes are otherwise identical.
    const raised = await raiseProposals(userId, [finding as FindingForProposal], settings);
    const proposalId = raised.proposalIds[0];

    if (proposalId === undefined) {
      // Either the finding was never a question (wrong kind, below the severity
      // floor) or an earlier run already asked it. Both are ordinary, and both
      // mean there is nothing to wait for - so the run ends here rather than
      // suspending forever on a proposal that does not exist.
      return bail({ proposalId: null, finalState: null, outcome: null });
    }
    return { userId, proposalId };
  },
});

const awaitDecisionStep = createStep({
  id: AWAIT_DECISION_STEP,
  inputSchema: z.object({ userId: z.string(), proposalId: z.string() }),
  resumeSchema,
  suspendSchema: z.object({
    proposalId: z.string(),
    /** When the question dies on its own, so a reader of the snapshot can tell. */
    expiresAt: z.string().nullable(),
    /** The result of the previous resume, for a resume that did not end the run. */
    lastOutcome: outcomeSchema.optional(),
  }),
  outputSchema: lifecycleOutputSchema,
  execute: async ({ inputData, resumeData, suspend }) => {
    const { userId, proposalId } = inputData;

    if (resumeData === undefined) {
      return await suspend({ proposalId, expiresAt: await deadlineOf(userId, proposalId) });
    }

    const decidedAt = new Date(resumeData.decidedAt);
    const outcome =
      resumeData.action === 'refresh'
        ? // Nobody decided anything; the clock did. Read the state machine's
          // answer instead of writing one, so the run ends when - and only
          // when - `effectiveState` says the proposal is finished.
          await currentOutcome(userId, proposalId, decidedAt)
        : await applyDecision(
            {
              userId,
              proposalId,
              action: resumeData.action,
              surface: resumeData.surface,
              ...(resumeData.snoozeUntil === undefined
                ? {}
                : { snoozeUntil: new Date(resumeData.snoozeUntil) }),
              ...(resumeData.idempotencyKey === undefined
                ? {}
                : { idempotencyKey: resumeData.idempotencyKey }),
            },
            decidedAt,
          );

    if (outcome.outcome === 'not_found') {
      // The proposal is gone - its observation was deleted, or the database was
      // restored under us. There is nothing left to wait for, and a run that
      // kept waiting would be suspended on a question that no longer exists.
      return { proposalId, finalState: null, outcome };
    }
    if (isTerminal(outcome.state)) {
      return { proposalId, finalState: outcome.state, outcome };
    }

    // A snooze, or a refusal that left the proposal answerable. The question is
    // still live, so the run goes back to waiting - which is what makes a
    // snooze a pause rather than an answer.
    return await suspend({
      proposalId,
      expiresAt: await deadlineOf(userId, proposalId),
      lastOutcome: outcome,
    });
  },
});

export const proposalLifecycle = createWorkflow({
  id: PROPOSAL_LIFECYCLE_ID,
  inputSchema: z.object({
    userId: z.string(),
    finding: findingSchema,
    settings: settingsSchema,
  }),
  outputSchema: lifecycleOutputSchema,
})
  .then(raiseProposalStep)
  .then(awaitDecisionStep)
  .commit();

// --- The seam the rest of the orchestrator calls -------------------------------

export interface LifecycleStart {
  userId: string;
  finding: FindingForProposal;
  settings: { proposalSeverity: string; proposalTtlHours: number };
}

/**
 * Would this finding become a question at all?
 *
 * A pre-filter, not a policy: the authoritative answer is `raiseProposals`, and
 * this asks the same two exported predicates before paying for a workflow run.
 * Being wrong here can only cost a run that bails at its first step; it cannot
 * raise a proposal that the service would have declined, because the service
 * still decides.
 */
export function mayRaiseProposal(finding: FindingForProposal, severityFloor: string): boolean {
  return isProposableKind(finding.kind) && meetsSeverity(finding.severity, severityFloor);
}

/**
 * Start a lifecycle for one finding, and return the proposal it raised.
 *
 * The run id is the *observation* id rather than the proposal id, because the
 * proposal does not exist until the first step has run - and because it makes
 * starting a lifecycle idempotent for free. `proposals_one_per_observation`
 * already guarantees one proposal per observation; the unique key on
 * (workflow_name, run_id) now guarantees one workflow per observation, under
 * the same identity, with no second scheme to keep in step with the first.
 */
export async function startProposalLifecycle(
  start: LifecycleStart,
): Promise<{ proposalId: string | null }> {
  const runtime = getWorkflowRuntime();
  if (runtime === null) {
    // No engine: raise the proposal anyway. The inbox is the product; the
    // workflow is how the product waits.
    const raised = await raiseProposals(start.userId, [start.finding], start.settings);
    return { proposalId: raised.proposalIds[0] ?? null };
  }

  const workflow = runtime.getWorkflow(PROPOSAL_LIFECYCLE_ID);
  const runId = start.finding.id;

  const existing = await workflow.getWorkflowRunById(runId);
  if (existing !== null && existing !== undefined) {
    // A previous scan already opened this lifecycle. Starting it again would
    // re-run the raise step against a proposal that exists, which is harmless,
    // and would overwrite a suspended run's snapshot, which is not.
    logger().debug({ runId }, 'proposal.lifecycle_already_open');
    return { proposalId: null };
  }

  const run = await workflow.createRun({ runId });
  const result = await run.start({
    inputData: {
      userId: start.userId,
      finding: start.finding,
      settings: start.settings,
    },
  });

  const raised = stepOutput(result, RAISE_PROPOSAL_STEP);
  const proposalId = typeof raised?.proposalId === 'string' ? raised.proposalId : null;
  logger().info(
    { runId, proposalId, status: result.status },
    proposalId === null ? 'proposal.lifecycle_not_raised' : 'proposal.lifecycle_started',
  );
  return { proposalId };
}

/**
 * Apply a user's decision, through the suspended run when there is one.
 *
 * The run is resumed rather than told about the decision afterwards, so that
 * the workflow is genuinely in the loop: the step it wakes into is the thing
 * that calls `applyDecision`, and whatever the next milestone hangs after that
 * call - a Telegram message edit, a notification - runs as part of the same
 * resumed continuation rather than as a second mechanism nobody can see from
 * the workflow.
 */
export async function decideProposal(
  input: DecisionInput,
  now: Date = new Date(),
): Promise<DecisionOutcome> {
  const runtime = getWorkflowRuntime();
  if (runtime === null) return applyDecision(input, now);

  const runId = await runIdFor(input.userId, input.proposalId);
  if (runId === null) return applyDecision(input, now);

  const workflow = runtime.getWorkflow(PROPOSAL_LIFECYCLE_ID);
  const state = await workflow.getWorkflowRunById(runId);
  if (state?.status !== 'suspended') {
    // Nothing is waiting: the proposal predates this workflow, or its run has
    // already ended. The decision still has to land, and `applyDecision` is
    // where it lands either way.
    return applyDecision(input, now);
  }

  try {
    const run = await workflow.createRun({ runId });
    const result = await run.resume({
      step: AWAIT_DECISION_STEP,
      resumeData: {
        action: input.action,
        surface: input.surface,
        decidedAt: now.toISOString(),
        ...(input.snoozeUntil === undefined
          ? {}
          : { snoozeUntil: input.snoozeUntil.toISOString() }),
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      },
    });

    const outcome = resumedOutcome(result);
    if (outcome !== null) return outcome;
    logger().error({ runId, status: result.status }, 'proposal.resume_outcome_unreadable');
  } catch (error) {
    logger().error({ err: error, runId }, 'proposal.resume_failed');
  }

  // The resume failed or answered in a shape this code cannot read. Re-apply
  // directly: if the step already wrote the transition, this reads back
  // `unchanged`, and if it did not, the user's decision is not lost to an
  // orchestration failure they had nothing to do with.
  return applyDecision(input, now);
}

/**
 * Expire what the clock has already expired, and let the runs waiting on those
 * proposals finish.
 *
 * The sweep stays where it was - `sweepExpiredProposals` writes the transitions
 * - and this adds the second half F3 implies: a run suspended on a question
 * nobody answered has to end, or `mastra_workflow_snapshot` accumulates a
 * suspended run per dead proposal forever.
 */
export async function sweepAndCloseLifecycles(now: Date = new Date()): Promise<number> {
  const expired = await sweepExpiredProposals(now);
  const runtime = getWorkflowRuntime();
  if (runtime === null || expired.length === 0) return expired.length;

  const workflow = runtime.getWorkflow(PROPOSAL_LIFECYCLE_ID);
  for (const proposal of expired) {
    try {
      const state = await workflow.getWorkflowRunById(proposal.observationId);
      if (state?.status !== 'suspended') continue;
      const run = await workflow.createRun({ runId: proposal.observationId });
      await run.resume({
        step: AWAIT_DECISION_STEP,
        resumeData: { action: 'refresh', surface: 'system', decidedAt: now.toISOString() },
      });
    } catch (error) {
      // One stuck run must not stop the sweep: the expiry itself is already
      // written, so the worst case is a snapshot row that outlives its
      // proposal, which is litter rather than a correctness problem.
      logger().warn({ err: error, proposalId: proposal.id }, 'proposal.lifecycle_close_failed');
    }
  }
  return expired.length;
}

// --- Reading Mastra's answers -------------------------------------------------

/**
 * Mastra's run results are a union over five statuses, and the two fields this
 * module needs - a step's output and its suspend payload - sit at different
 * places in it. The casts are confined to these three helpers so that the rest
 * of the file reads in this project's types rather than the engine's.
 */
interface StepView {
  status?: string;
  output?: Record<string, unknown>;
  suspendPayload?: Record<string, unknown>;
}

function stepOutput(result: unknown, stepId: string): Record<string, unknown> | null {
  const steps = (result as { steps?: Record<string, StepView> } | null)?.steps;
  return steps?.[stepId]?.output ?? null;
}

function resumedOutcome(result: unknown): DecisionOutcome | null {
  const steps = (result as { steps?: Record<string, StepView> } | null)?.steps;
  const step = steps?.[AWAIT_DECISION_STEP];
  if (step === undefined) return null;
  // A run that ended carries the outcome in its output; one that went back to
  // waiting carries it in the payload it suspended with.
  const outcome = step.output?.outcome ?? step.suspendPayload?.['lastOutcome'];
  return isDecisionOutcome(outcome) ? outcome : null;
}

function isDecisionOutcome(value: unknown): value is DecisionOutcome {
  return typeof value === 'object' && value !== null && 'outcome' in value;
}

// --- Small reads the steps need ------------------------------------------------

/** The run id a proposal's lifecycle was started under: its observation. */
async function runIdFor(userId: string, proposalId: string): Promise<string | null> {
  const row = await findProposal(userId, proposalId);
  return row?.observation_id ?? null;
}

/** The deadline, for a reader of the suspended snapshot. Null if it vanished. */
async function deadlineOf(userId: string, proposalId: string): Promise<string | null> {
  const row = await findProposal(userId, proposalId);
  return row?.expires_at.toISOString() ?? null;
}

/**
 * What the state machine says about this proposal right now, in the shape a
 * decision would have returned. Used by `refresh`, which asks rather than acts:
 * `effectiveState` is the same function every other reader goes through, so a
 * run ends on an expiry at exactly the moment the inbox stops offering it.
 */
async function currentOutcome(
  userId: string,
  proposalId: string,
  now: Date,
): Promise<DecisionOutcome> {
  const row = await findProposal(userId, proposalId);
  if (row === null) return { outcome: 'not_found' };
  return { outcome: 'unchanged', state: effectiveState(factsOf(row), now) };
}
