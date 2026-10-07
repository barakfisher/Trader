import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Link } from '@tanstack/react-router';

import type { Proposal, TradeApprovalPreview, TradeProposalPayload } from '@traders/shared';

import { useTranslation } from '../i18n/index.ts';
import { formatMoney, formatNumber, formatPercent } from '../i18n/format.ts';
import { approvalErrorMessage } from '../lib/agentPresentation.ts';
import { isUrgent, timeLeft } from '../lib/proposalCountdown.ts';
import { observationText } from '../lib/observationText.ts';
import { formatExactTime } from '../lib/relativeTime.ts';
import { useConfirmTradeApproval, usePreviewTradeApproval } from '../queries/proposals.ts';
import { useStore } from '../stores/context.tsx';
import { PreviewSummary } from './TradePanel.tsx';
import { Button, Card, ErrorNote } from './ui.tsx';

/**
 * An agent's buy or sell, waiting for the user (D26, D47-D49).
 *
 * The frame - agent, side, quantity, symbol, the agent's price, the deadline -
 * is the catalogue's; the thesis below it is the agent's own words, in the
 * user's language (D51). Two steps, because the price has moved since the agent
 * decided: **Approve** asks the server for the trade at the live price beside
 * the agent's, and **Confirm** fills it, through the same path as a manual
 * trade. A refusal - the price too far from the agent's, the market closed, not
 * enough cash - is said against this card, and the proposal stays open to try
 * again or reject (D49). No snooze and no undo (D48).
 */
export const TradeProposalCard = observer(function TradeProposalCard({
  proposal,
  linkToPage = true,
}: {
  proposal: Proposal;
  linkToPage?: boolean;
}) {
  const { proposals } = useStore();
  const { t, i18n } = useTranslation();
  const text = observationText(proposal, i18n.language);
  const payload = proposal.payload as TradeProposalPayload;
  const preview = usePreviewTradeApproval(proposal.id);
  const confirm = useConfirmTradeApproval(proposal.id);
  const [shown, setShown] = useState<TradeApprovalPreview | null>(null);
  const rejecting = proposals.decidingAction(proposal.id) === 'reject';
  const busy = preview.isPending || confirm.isPending || rejecting;
  const remaining = timeLeft(proposal.expiresAt);
  const refusal = proposals.refusal?.proposalId === proposal.id ? proposals.refusal.message : null;

  const approve = () => {
    confirm.reset();
    preview.mutate(undefined, { onSuccess: setShown, onError: () => setShown(null) });
  };
  const cancel = () => {
    setShown(null);
    preview.reset();
    confirm.reset();
  };

  return (
    <Card>
      <div className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-1">
            <h2 {...text.attributes} className="text-sm font-semibold text-text-primary">
              {linkToPage ? (
                <Link
                  to="/proposals/$proposalId"
                  params={{ proposalId: proposal.id }}
                  className="hover:text-accent hover:underline"
                >
                  {text.headline}
                </Link>
              ) : (
                text.headline
              )}
            </h2>
            <p className="text-xs text-text-muted">
              <Link
                to="/agents/$agentId"
                params={{ agentId: proposal.agentId }}
                className="hover:text-accent hover:underline"
              >
                {proposal.agentName}
              </Link>
              {' · '}
              {t('proposal.trade.agentPrice', { price: formatMoney(payload.priceMinor, payload.currency) })}
            </p>
          </div>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
              isUrgent(proposal.expiresAt) ? 'bg-loss/15 text-loss' : 'bg-surface-hover text-text-muted'
            }`}
            title={formatExactTime(proposal.expiresAt)}
          >
            {remaining ?? t('countdown.expired')}
          </span>
        </div>

        {text.explanation !== null && (
          <section aria-label={t('proposal.trade.thesis')} className="space-y-1">
            <h3 className="text-xs font-semibold text-text-muted">{t('proposal.trade.thesis')}</h3>
            {/* The thesis is in the language the user had when the agent wrote it
                (D51), which need not be the page's now: its own text decides its
                direction, so an English thesis on a Hebrew page still reads left
                to right, full stop last. */}
            <p dir="auto" className="text-sm text-text-primary">
              {text.explanation}
            </p>
          </section>
        )}

        <p className="text-xs text-text-muted">{t('proposal.trade.paperOnly')}</p>

        {shown !== null && (
          <PreviewSummary preview={shown.trade}>
            <p className="text-xs text-text-muted">
              {t('proposal.trade.distance', {
                agent: formatMoney(shown.agentPriceMinor, payload.currency),
                distance: formatPercent(shown.distanceBps / 100, 1),
              })}
            </p>
          </PreviewSummary>
        )}

        {preview.error && (
          <ErrorNote message={approvalErrorMessage(preview.error, t('proposal.trade.previewFailed'), payload.currency)} />
        )}
        {confirm.error && (
          <ErrorNote message={approvalErrorMessage(confirm.error, t('proposal.trade.confirmFailed'), payload.currency)} />
        )}
        {refusal !== null && <ErrorNote message={refusal} />}
        {confirm.data && (
          <p role="status" className="rounded-lg bg-gain/10 px-3 py-2 text-xs text-gain">
            {t(`proposal.trade.filled.${confirm.data.fill.side}`, {
              quantity: formatNumber(Number(confirm.data.fill.quantity)),
              symbol: confirm.data.fill.symbol,
              price: formatMoney(confirm.data.fill.priceMinor, confirm.data.fill.currency),
              fee: formatMoney(confirm.data.fill.feeMinor, confirm.data.fill.currency),
            })}
          </p>
        )}

        {confirm.data === undefined && (
          <div className="flex flex-wrap gap-2">
            {shown === null ? (
              <Button disabled={busy} onClick={approve}>
                {preview.isPending ? t('proposal.trade.inFlight.preview') : t('proposal.approve')}
              </Button>
            ) : (
              <>
                <Button disabled={busy} onClick={() => confirm.mutate(shown.trade.priceMinor)}>
                  {confirm.isPending
                    ? t('proposal.trade.inFlight.confirm')
                    : t(`proposal.trade.confirm.${proposal.kind === 'sell' ? 'sell' : 'buy'}`, {
                        total: formatMoney(Math.abs(shown.trade.cashChangeMinor), payload.currency),
                      })}
                </Button>
                <Button variant="secondary" disabled={busy} onClick={cancel}>
                  {t('proposal.trade.cancel')}
                </Button>
              </>
            )}
            <Button variant="danger" disabled={busy} onClick={() => void proposals.decide(proposal.id, 'reject')}>
              {rejecting ? t('proposal.inFlight.reject') : t('proposal.reject')}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
});
