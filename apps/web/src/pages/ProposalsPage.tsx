import { useEffect } from 'react';
import { observer } from 'mobx-react-lite';
import { ArrowLeft, Inbox, ShieldCheck } from 'lucide-react';

import type { Proposal } from '@traders/shared';

import { Disclaimer } from '../components/Disclaimer.tsx';
import { Button, Card, EmptyState, ErrorNote, Spinner } from '../components/ui.tsx';
import { isUrgent, snoozeDescription, timeLeft } from '../lib/proposalCountdown.ts';
import { formatExactTime } from '../lib/relativeTime.ts';
import { SNOOZE_HOURS } from '../stores/ProposalsStore.ts';
import { useStore } from '../stores/context.tsx';

/**
 * The approvals inbox.
 *
 * Three things about this page are deliberate and would be wrong if done the
 * obvious way.
 *
 * **Every proposal shows its evidence before its buttons.** The product's
 * central rule is that a claim without its data is not shippable, and an
 * approval is the one place a user acts on a claim rather than merely reading
 * it. Asking someone to approve something whose figures are one click away, in
 * a drawer, would be the moment that rule stopped meaning anything.
 *
 * **The deadline is stated on every card, not just implied by ordering.** A
 * proposal is answerable until a specific moment, and the ordering alone cannot
 * say when; a user who cannot see a deadline cannot tell an urgent question
 * from a patient one.
 *
 * **Nothing is rendered optimistically.** The button disables while the decision
 * is in flight and the card re-renders from the server's answer. An approval
 * writes a ledger row, and a screen that says "Approved" for one the server
 * refused is the most expensive kind of wrong this product can be.
 */
export const ProposalsPage = observer(function ProposalsPage() {
  const { proposals, navigation } = useStore();

  useEffect(() => {
    void proposals.load();
  }, [proposals]);

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Inbox className="size-5 text-accent" aria-hidden />
          <h1 className="text-base font-semibold">Proposals</h1>
          {proposals.openCount > 0 && (
            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
              {proposals.openCount} open
            </span>
          )}
        </div>
        <Button variant="ghost" onClick={() => navigation.show('portfolio')}>
          <span className="flex items-center gap-1.5">
            <ArrowLeft className="size-4" aria-hidden />
            Back to portfolio
          </span>
        </Button>
      </header>

      {/*
        Said once, at the top, rather than on every card. Approving records an
        intention in a ledger this product owns; nothing is ever sent to a
        broker, and a user about to press a button labelled "Approve" should not
        have to infer that.
      */}
      <Card>
        <p className="flex items-start gap-2 text-sm text-text-muted">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
          <span>
            Approving records your intention in this app&rsquo;s own ledger. No order is ever placed
            and no broker is contacted.
          </span>
        </p>
      </Card>

      {proposals.loading && proposals.proposals.length === 0 && (
        <Spinner label="Loading proposals…" />
      )}

      {proposals.error !== null && (
        <ErrorNote message={proposals.error} onRetry={() => void proposals.load()} />
      )}

      {proposals.isEmpty && proposals.error === null && (
        <EmptyState
          title="Nothing waiting on you"
          body="When a finding needs a decision, it appears here. You can change what qualifies in Settings."
          action={
            <Button variant="secondary" onClick={() => navigation.show('settings')}>
              Open settings
            </Button>
          }
        />
      )}

      <div className="space-y-3">
        {proposals.open.map((proposal) => (
          <ProposalCard key={proposal.id} proposal={proposal} />
        ))}
      </div>

      <Disclaimer />
    </div>
  );
});

const ProposalCard = observer(function ProposalCard({ proposal }: { proposal: Proposal }) {
  const { proposals } = useStore();
  const deciding = proposals.isDeciding(proposal.id);
  const remaining = timeLeft(proposal.expiresAt);
  const urgent = isUrgent(proposal.expiresAt);
  const snoozed = proposal.state === 'snoozed' ? snoozeDescription(proposal.snoozedUntil) : null;
  const refusal =
    proposals.refusal?.proposalId === proposal.id ? proposals.refusal.message : null;

  return (
    <Card>
      <div className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold text-text-primary">{proposal.headline}</h2>
            {proposal.explanation !== null && (
              <p className="text-sm text-text-muted">{proposal.explanation}</p>
            )}
          </div>
          <span
            // Urgency is a threshold, not a gradient: the only decision it
            // drives is whether to draw the eye, and a continuously changing
            // colour would claim a precision the deadline does not have.
            className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
              urgent ? 'bg-loss/15 text-loss' : 'bg-surface-hover text-text-muted'
            }`}
            title={formatExactTime(proposal.expiresAt)}
          >
            {remaining ?? 'expired'}
          </span>
        </div>

        {snoozed !== null && <p className="text-xs text-text-muted">{snoozed}</p>}

        <EvidenceTable evidence={proposal.evidence} />

        {refusal !== null && (
          // Rendered against the proposal it concerned rather than as a page
          // banner: "this one expired while you were reading" is about a
          // specific card, and a global message would leave the user hunting.
          <p className="rounded-lg border border-loss/40 bg-loss/10 px-3 py-2 text-xs text-loss">
            {refusal}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button disabled={deciding} onClick={() => void proposals.decide(proposal.id, 'approve')}>
            {deciding ? 'Working…' : 'Approve'}
          </Button>
          <Button
            variant="secondary"
            disabled={deciding}
            onClick={() => void proposals.decide(proposal.id, 'snooze')}
          >
            Snooze {SNOOZE_HOURS}h
          </Button>
          <Button
            variant="danger"
            disabled={deciding}
            onClick={() => void proposals.decide(proposal.id, 'reject')}
          >
            Reject
          </Button>
        </div>
      </div>
    </Card>
  );
});

/**
 * The figures behind the headline.
 *
 * Rendered generically from whatever the rule emitted rather than from a
 * per-kind template. A template has to be written for each rule and updated
 * when one changes its evidence, and the failure mode is silent: the drawdown
 * template once read `peak_price_minor` while the rule emitted
 * `high_price_minor`, and every unit test passed because every unit test
 * supplied evidence written by hand. Showing the keys the producer actually
 * emitted cannot drift from the producer.
 */
function EvidenceTable({ evidence }: { evidence: unknown }) {
  if (evidence === null || typeof evidence !== 'object') return null;
  const entries = Object.entries(evidence as Record<string, unknown>).filter(
    ([, value]) => value !== null && typeof value !== 'object',
  );
  if (entries.length === 0) return null;

  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-surface-hover px-3 py-2 text-xs sm:grid-cols-3">
      {entries.map(([key, value]) => (
        <div key={key} className="flex flex-col">
          <dt className="text-text-muted">{key.replace(/_/g, ' ')}</dt>
          <dd className="font-mono text-text-primary">{String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}
