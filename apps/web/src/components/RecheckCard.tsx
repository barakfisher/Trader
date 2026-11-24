import { Link } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';

import { RECHECK_WINDOW_DAYS, type ProposalRecheck, type RecheckResult } from '@traders/shared';

import { ApiRequestError, errorMessage } from '../api/client.ts';
import { t as translate, useTranslation } from '../i18n/index.ts';
import { formatExactTime } from '../lib/relativeTime.ts';
import { useModelAccess } from '../queries/modelAccess.ts';
import { useRecheckProposal } from '../queries/proposals.ts';
import { OwnKeyNotice } from './OwnKeyNotice.tsx';
import { Button, Card, ErrorNote } from './ui.tsx';

/** The AI service's refusals the catalogue says in the user's language (D212); others show the server's text. */
const REFUSALS = [
  'not_expired',
  'recheck_window_passed',
  'already_rechecked',
  'superseded',
  'budget_spent',
  'scan_running',
  'agent_not_active',
  'no_persona',
  'own_key_required',
  'own_key_failed',
  'safety_limit_reached',
] as const;

/** A refused re-check in the user's language: the catalogue's sentence for a known code, else the server's text. */
export function recheckRefusalMessage(error: unknown): string | null {
  if (error instanceof ApiRequestError && (REFUSALS as readonly string[]).includes(error.code)) {
    return translate(`proposalPage.recheck.refusals.${error.code as (typeof REFUSALS)[number]}`);
  }
  return error ? errorMessage(error, translate('proposalPage.recheck.failed')) : null;
}

/**
 * *Re-check* on an expired trade proposal (D212-D216): the agent looks at that
 * one trade once more, at today's price and under the same rules, and either
 * proposes it again - a new proposal, linked here - or says why not. Offered
 * once a proposal, for a week after it expired; a re-check that reached no
 * answer (a budget, the cap, a failure) does not use it up. Not offered when a
 * later approved proposal already made the same trade (D218): the card says so.
 *
 * A pending trade refused for a moved price (D431) is re-checked from its own
 * card, beside Approve (`TradeProposalCard`), so this card stays away while it
 * is pending. Once that re-check closed it (D432), this card says what it came
 * to: the new proposal to approve, or the agent's reason - with Approve and
 * Re-check shown disabled, so the page says plainly that neither is left.
 */
export function RecheckCard({
  proposalId,
  agentId,
  recheck,
  pending = false,
}: {
  proposalId: string;
  agentId: string;
  recheck: ProposalRecheck;
  /** The proposal is still pending (or snoozed): a moved price's re-check is its card's. */
  pending?: boolean;
}) {
  const { t } = useTranslation();
  const run = useRecheckProposal(proposalId, agentId);
  // D245, D280: no re-check is offered that nobody may pay for; the notice says why.
  const access = useModelAccess();
  // The answer just given is the freshest; the page's own read follows it.
  const last = run.data ?? recheck.last;
  if (!recheck.available && last === null && recheck.supersededBy === null) return null;
  if (pending && recheck.cause === 'price_moved') return null;

  const refusal = recheckRefusalMessage(run.error);
  const offered = recheck.available && run.data?.outcome !== 'proposed' && run.data?.outcome !== 'declined';
  // D432: a moved price's re-check that reached an answer closed the proposal.
  const closed = recheck.cause === 'price_moved' && (last?.outcome === 'proposed' || last?.outcome === 'declined');

  return (
    <Card title={t('proposalPage.recheck.title')}>
      <div className="space-y-2 text-sm">
        {last !== null && <RecheckOutcome result={last} />}
        {closed && last !== null && (
          <>
            <p className="text-text-muted">{t('proposalPage.recheck.closed')}</p>
            {last.outcome === 'declined' && (
              <div className="flex flex-wrap gap-2">
                <Button disabled>{t('proposal.approve')}</Button>
                <Button variant="secondary" disabled>
                  <span className="flex items-center gap-1.5">
                    <RefreshCw className="size-4" aria-hidden />
                    {t('proposalPage.recheck.button')}
                  </span>
                </Button>
              </div>
            )}
          </>
        )}
        {last === null && recheck.supersededBy !== null && (
          // D218: the trade was made by a later proposal; re-checking would make it twice.
          <p className="text-text-muted">
            {t('proposalPage.recheck.superseded')}{' '}
            <Link
              to="/proposals/$proposalId"
              params={{ proposalId: recheck.supersededBy }}
              className="text-accent hover:underline"
            >
              {t('proposalPage.recheck.openLater')}
            </Link>
          </p>
        )}
        {offered && (
          <>
            <p className="text-text-muted">{t('proposalPage.recheck.body')}</p>
            <p className="text-xs text-text-muted">
              {t('proposalPage.recheck.once', { count: RECHECK_WINDOW_DAYS })}
            </p>
            <OwnKeyNotice access={access} />
            <Button disabled={run.isPending || access.block !== null} onClick={() => run.mutate()}>
              <span className="flex items-center gap-1.5">
                <RefreshCw className={`size-4 ${run.isPending ? 'animate-spin' : ''}`} aria-hidden />
                {run.isPending ? t('proposalPage.recheck.running') : t('proposalPage.recheck.button')}
              </span>
            </Button>
          </>
        )}
        {refusal !== null && <ErrorNote message={refusal} />}
      </div>
    </Card>
  );
}

function RecheckOutcome({ result }: { result: RecheckResult }) {
  const { t } = useTranslation();
  const when = formatExactTime(result.at);
  switch (result.outcome) {
    case 'running':
      return <p className="text-text-muted">{t('proposalPage.recheck.runningSince', { when })}</p>;
    case 'proposed':
      return (
        <p>
          {t('proposalPage.recheck.proposed', { when })}{' '}
          <Link
            to="/proposals/$proposalId"
            params={{ proposalId: result.proposalId }}
            className="text-accent hover:underline"
          >
            {t('proposalPage.recheck.openNew')}
          </Link>
        </p>
      );
    case 'unanswered':
      return (
        <p className="text-text-muted">
          {t('proposalPage.recheck.unanswered', {
            when,
            cause: t(`proposalPage.recheck.causes.${result.cause}`),
          })}
        </p>
      );
    case 'declined':
      return (
        <div className="space-y-1">
          <p>{t('proposalPage.recheck.declined', { when })}</p>
          {result.reason.kind === 'agent' ? (
            <p className="text-text-muted">
              {t('proposalPage.recheck.agentSaid')}{' '}
              {/* The agent's own words, written in the user's language (D51). */}
              <span dir="auto">{result.reason.thesis}</span>
            </p>
          ) : (
            <p className="text-text-muted">{t(`proposalPage.recheck.checks.${result.reason.check}`)}</p>
          )}
        </div>
      );
  }
}
