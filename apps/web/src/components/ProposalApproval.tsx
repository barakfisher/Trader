import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Check, ShieldCheck } from 'lucide-react';

import type { ConsolidatedPendingTrade } from '@traders/shared';

import { errorMessage } from '../api/client.ts';
import { useTranslation } from '../i18n/index.ts';
import { baseCurrencyOf } from '../lib/portfolioView.ts';
import { DecidedCard } from '../pages/ProposalPage.tsx';
import { usePortfolioQuery } from '../queries/portfolio.ts';
import { useProposalQuery } from '../queries/proposals.ts';
import { useStore } from '../stores/context.tsx';
import { ProposalCard } from './ProposalCards.tsx';
import { Drawer } from './Drawer.tsx';
import { ErrorNote, Spinner } from './ui.tsx';

/**
 * *Approve* on the dashboard (D230): a pending agent trade, approved where its
 * ticker is shown rather than only from the inbox.
 *
 * Never one click. The button opens the proposal's own card in a drawer - the
 * agent's thesis, what its scan checked, the deadline - and that card's
 * two steps are the only way through: *Approve* prices the trade at the live
 * quote beside the agent's (D47), *Confirm* fills it. So every refusal the
 * inbox applies - a price too far from the agent's, a closed market, a
 * superseded proposal (D218) - applies here too, said against the same card.
 * It writes to the agent's paper ledger only (guideline 2).
 */
export function ApproveProposalButton({ trade }: { trade: ConsolidatedPendingTrade }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('combined.approve.label', {
          agent: trade.agentName,
          side: t(`consolidated.pending.sides.${trade.side}`),
          symbol: trade.symbol,
        })}
        className="flex items-center gap-1 rounded-lg border border-accent/40 px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10"
      >
        <Check className="size-3.5" aria-hidden />
        {t('combined.approve.button')}
      </button>
      {open && <ProposalApprovalDrawer proposalId={trade.proposalId} onClose={() => setOpen(false)} />}
    </>
  );
}

export function ProposalApprovalDrawer({ proposalId, onClose }: { proposalId: string; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Drawer title={t('combined.approve.title')} closeLabel={t('holdings.actions.close')} onClose={onClose}>
      <ProposalApprovalBody proposalId={proposalId} />
    </Drawer>
  );
}

/** The proposal as its page shows it: the card while it is answerable, its outcome once it is not. */
const ProposalApprovalBody = observer(function ProposalApprovalBody({ proposalId }: { proposalId: string }) {
  const { t } = useTranslation();
  const { proposals } = useStore();
  const detail = useProposalQuery(proposalId);
  const baseCurrency = baseCurrencyOf(usePortfolioQuery().data);
  if (detail.isPending) return <Spinner label={t('combined.approve.loading')} />;
  if (detail.error && detail.data === undefined)
    return (
      <ErrorNote
        message={errorMessage(detail.error, t('combined.approve.loadFailed'))}
        onRetry={() => void detail.refetch()}
      />
    );
  const proposal = detail.data?.proposal ?? null;
  if (proposal === null) return <p className="text-sm text-text-muted">{t('proposalPage.notFoundBody')}</p>;
  if (proposal.state !== 'pending' && proposal.state !== 'snoozed')
    return <DecidedCard proposal={proposal} baseCurrency={baseCurrency} />;
  return (
    <div className="space-y-3">
      <p className="flex items-start gap-2 text-xs text-text-muted">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
        <span>{t('proposals.ledgerOnly')}</span>
      </p>
      {proposals.decisionError !== null && <ErrorNote message={proposals.decisionError} />}
      <ProposalCard proposal={proposal} baseCurrency={baseCurrency} />
    </div>
  );
});
