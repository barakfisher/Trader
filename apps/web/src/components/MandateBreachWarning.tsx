import { Link } from '@tanstack/react-router';

import type { AgentMandate, MandateBreach } from '@traders/shared';

import { useTranslation } from '../i18n/index.ts';
import { formatMoney, formatNumber, formatShare } from '../i18n/format.ts';
import { instructionsAreOwnWords } from '../lib/agentMandate.ts';
import { useAgentQuery, useCheckInstructions, useUpdateAgent } from '../queries/agents.ts';
import { Button, ErrorNote } from './ui.tsx';

/** A limit in basis points with the places it needs: "10%", "12.5%", "12.25%". */
function limitShare(bps: number): string {
  return formatShare(bps / 100, bps % 100 === 0 ? 0 : bps % 10 === 0 ? 1 : 2);
}

/** The one-field mandate change a breach suggests, or null when no allowed value would do. */
function suggestion(breach: MandateBreach): { patch: Partial<AgentMandate>; value: string } | null {
  switch (breach.rule) {
    case 'max_position':
      return breach.suggestedBps === null
        ? null
        : { patch: { maxPositionBps: breach.suggestedBps }, value: limitShare(breach.suggestedBps) };
    case 'cash_buffer':
      return { patch: { cashBufferBps: breach.suggestedBps }, value: limitShare(breach.suggestedBps) };
    case 'max_holdings':
      return breach.suggestedLimit === null
        ? null
        : { patch: { maxHoldings: breach.suggestedLimit }, value: formatNumber(breach.suggestedLimit) };
  }
}

/**
 * The agent's limits an approval would break (D299), under the preview and above
 * Confirm. Each says which limit and by how much; a warning, never a refusal -
 * Confirm still fills, since approving is the user's explicit act.
 *
 * Each offers the one setting that would allow the trade, saved in place: an
 * override that is meant becomes the agent's rule, and the preview is asked
 * again. A change to the settings re-checks instructions in the user's own
 * words, as the settings form does (D176). The agent's settings tab holds the rest.
 */
export function MandateBreachWarning({
  breaches,
  agentId,
  symbol,
  currency,
  disabled,
  onAdjusted,
}: {
  breaches: MandateBreach[];
  agentId: string;
  symbol: string;
  currency: string;
  disabled: boolean;
  onAdjusted: () => void;
}) {
  const { t } = useTranslation();
  const agent = useAgentQuery(agentId);
  const update = useUpdateAgent(agentId);
  const check = useCheckInstructions();
  if (breaches.length === 0) return null;
  const money = (minor: number) => formatMoney(minor, currency);

  const adjust = (patch: Partial<AgentMandate>) => {
    // Read before the change: D176 compares the instructions with the settings they were written beside.
    const needsCheck = agent.data !== undefined && instructionsAreOwnWords(agent.data);
    update.mutate(
      { mandate: patch },
      {
        onSuccess: () => {
          if (needsCheck) check.mutate(agentId);
          onAdjusted();
        },
      },
    );
  };

  const sentence = (breach: MandateBreach): string => {
    switch (breach.rule) {
      case 'max_position':
        return t('proposal.trade.mandate.maxPosition', {
          symbol,
          share: formatShare(breach.positionAfterBps / 100, 1),
          position: money(breach.positionAfterMinor),
          capital: money(breach.capitalMinor),
          over: money(breach.overByMinor),
          limit: limitShare(breach.limitBps),
        });
      case 'cash_buffer':
        return t('proposal.trade.mandate.cashBuffer', {
          cashAfter: money(breach.cashAfterMinor),
          share: formatShare(breach.cashAfterBps / 100, 1),
          short: money(breach.shortByMinor),
          limit: limitShare(breach.limitBps),
        });
      case 'max_holdings':
        return t('proposal.trade.mandate.maxHoldings', {
          nth: formatNumber(breach.heldCount + 1),
          limit: formatNumber(breach.limit),
        });
    }
  };

  return (
    <section
      role="alert"
      aria-label={t('proposal.trade.mandate.title')}
      className="space-y-2 rounded-lg border border-warn/40 bg-warn/10 p-3 text-xs"
    >
      <h3 className="font-semibold text-warn">{t('proposal.trade.mandate.title')}</h3>
      <ul className="space-y-2">
        {breaches.map((breach) => {
          const offer = suggestion(breach);
          return (
            <li key={breach.rule} className="space-y-1">
              <p className="text-text-primary">{sentence(breach)}</p>
              {offer !== null && (
                <Button
                  variant="secondary"
                  disabled={disabled || update.isPending || agent.data === undefined}
                  onClick={() => adjust(offer.patch)}
                >
                  {update.isPending
                    ? t('proposal.trade.mandate.saving')
                    : t(`proposal.trade.mandate.set.${breach.rule}`, { value: offer.value })}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {update.error && <ErrorNote message={t('proposal.trade.mandate.saveFailed')} />}
      <p className="text-text-muted">
        {t('proposal.trade.mandate.override')}{' '}
        <Link
          to="/agents/$agentId"
          params={{ agentId }}
          search={{ tab: 'settings' }}
          className="font-medium text-accent hover:underline"
        >
          {t('proposal.trade.mandate.settings')}
        </Link>
      </p>
    </section>
  );
}
