import { Link } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';

import { RECHECK_WINDOW_DAYS, type ProposalRecheck, type RecheckResult } from '@traders/shared';

import { ApiRequestError, errorMessage } from '../api/client.ts';
import { useTranslation } from '../i18n/index.ts';
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

/**
 * *Re-check* on an expired trade proposal (D212-D216): the agent looks at that
 * one trade once more, at today's price and under the same rules, and either
 * proposes it again - a new proposal, linked here - or says why not. Offered
 * once a proposal, for a week after it expired; a re-check that reached no
 * answer (a budget, the cap, a failure) does not use it up. Not offered when a
 * later approved proposal already made the same trade (D218): the card says so.
 */
export function RecheckCard({
  proposalId,
  agentId,
  recheck,
}: {
  proposalId: string;
  agentId: string;
  recheck: ProposalRecheck;
}) {
  const { t } = useTranslation();
  const run = useRecheckProposal(proposalId, agentId);
  // D245, D280: no re-check is offered that nobody may pay for; the notice says why.
  const access = useModelAccess();
  // The answer just given is the freshest; the page's own read follows it.
  const last = run.data ?? recheck.last;
  if (!recheck.available && last === null && recheck.supersededBy === null) return null;

  const refusal =
    run.error instanceof ApiRequestError && (REFUSALS as readonly string[]).includes(run.error.code)
      ? t(`proposalPage.recheck.refusals.${run.error.code as (typeof REFUSALS)[number]}`)
      : run.error
        ? errorMessage(run.error, t('proposalPage.recheck.failed'))
        : null;
  const offered = recheck.available && run.data?.outcome !== 'proposed' && run.data?.outcome !== 'declined';

  return (
    <Card title={t('proposalPage.recheck.title')}>
      <div className="space-y-2 text-sm">
        {last !== null && <RecheckOutcome result={last} />}
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
