import { Lightbulb } from 'lucide-react';

import { AGENT_REVIEW_EVERY_SCANS, type AgentSuggestion, type AgentView } from '@traders/shared';

import { ApiRequestError, errorMessage } from '../api/client.ts';
import { useTranslation } from '../i18n/index.ts';
import { formatDate, formatFixed, formatMoney, formatNumber, formatPercent, leftToRight } from '../i18n/format.ts';
import { bpsShare, settingValue } from '../lib/suggestionPresentation.ts';
import { useAgentSuggestionsQuery, useApplySuggestion, useDismissSuggestion } from '../queries/agents.ts';
import { Button, Card } from './ui.tsx';

/** Apply's refusals the catalogue says in the user's language; any other shows the server's text. */
const REFUSALS = ['suggestion_stale', 'suggestion_closed', 'agent_archived', 'nothing_to_apply'] as const;

/**
 * The agent review's open suggestions (D335-D338), one card each: what a rule
 * found, with the figures it stands on, and the one setting it proposes to
 * change. Apply writes that setting; Dismiss closes the card. Shown above the
 * tabs, so a suggestion is seen whichever tab is open; nothing when there is
 * none, or when the list cannot be read - a review is advice, not a gate.
 */
export function AgentReviewCards({ agent }: { agent: AgentView }) {
  const { t } = useTranslation();
  const suggestions = useAgentSuggestionsQuery(agent.id, !agent.isPrimary);
  const open = suggestions.data?.suggestions ?? [];
  if (open.length === 0) return null;
  return (
    <section aria-labelledby="agent-review-title" className="space-y-2">
      <div>
        <h2 id="agent-review-title" className="flex items-center gap-1.5 text-sm font-semibold">
          <Lightbulb className="size-4 text-accent" aria-hidden />
          {t('agents.review.title')}
        </h2>
        <p className="text-xs text-text-muted">{t('agents.review.intro', { count: AGENT_REVIEW_EVERY_SCANS })}</p>
      </div>
      {open.map((suggestion) => (
        <SuggestionCard key={suggestion.id} agent={agent} suggestion={suggestion} />
      ))}
    </section>
  );
}

function SuggestionCard({ agent, suggestion }: { agent: AgentView; suggestion: AgentSuggestion }) {
  const { t } = useTranslation();
  const apply = useApplySuggestion(agent.id);
  const dismiss = useDismissSuggestion(agent.id);
  const busy = apply.isPending || dismiss.isPending;
  const change = suggestion.change;
  const refusal =
    apply.error instanceof ApiRequestError && (REFUSALS as readonly string[]).includes(apply.error.code)
      ? t(`agents.review.refusals.${apply.error.code as (typeof REFUSALS)[number]}`)
      : apply.error || dismiss.error
        ? errorMessage(apply.error ?? dismiss.error, t('agents.review.failed'))
        : null;

  return (
    <Card title={t(`agents.review.rules.${suggestion.rule}.title`)}>
      <div className="space-y-3 text-sm">
        <p>
          <EvidenceSentence suggestion={suggestion} />
        </p>
        {change ? (
          <div className="rounded-md bg-surface-hover px-3 py-2">
            <p className="text-xs text-text-muted">{t('agents.review.proposed')}</p>
            <p className="font-medium">
              {t(`agents.review.settings.${change.setting}`)}:{' '}
              <span className="whitespace-nowrap">{settingValue(change.setting, change.from)}</span>{' '}
              <span aria-hidden>{t('agents.review.arrow')}</span>
              <span className="sr-only">{t('agents.review.to')}</span>{' '}
              <span className="whitespace-nowrap">{settingValue(change.setting, change.to)}</span>
            </p>
          </div>
        ) : (
          <p className="text-text-muted">{t(`agents.review.rules.${suggestion.rule}.noChange`)}</p>
        )}
        {refusal && (
          <p role="alert" className="text-xs text-loss">
            {refusal}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {change && agent.state !== 'archived' && (
            <Button onClick={() => apply.mutate(suggestion.id)} disabled={busy}>
              {t('agents.review.apply')}
            </Button>
          )}
          <Button variant="secondary" onClick={() => dismiss.mutate(suggestion.id)} disabled={busy}>
            {t('agents.review.dismiss')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** The rule's sentence, every figure from the suggestion's evidence (guideline 7). */
function EvidenceSentence({ suggestion }: { suggestion: AgentSuggestion }) {
  const { t } = useTranslation();
  const evidence = suggestion.evidence;
  const money = (minor: number | undefined) => formatMoney(minor ?? null, evidence.currency);
  switch (suggestion.rule) {
    case 'idle_cash':
      return t('agents.review.rules.idle_cash.evidence', {
        count: evidence.scans,
        scans: formatNumber(evidence.scans),
        trades: formatNumber(evidence.tradeScans),
        cash: money(evidence.cashMinor),
        deposits: money(evidence.depositsMinor),
        share: bpsShare(evidence.cashShareBps),
      });
    case 'fee_drag':
      return t('agents.review.rules.fee_drag.evidence', {
        count: evidence.fills ?? 0,
        fills: formatNumber(evidence.fills ?? 0),
        since: formatDate(new Date(evidence.since), { dateStyle: 'medium' }),
        fees: money(evidence.feesMinor),
        deposits: money(evidence.depositsMinor),
        share: bpsShare(evidence.feeShareBps),
      });
    case 'benchmark_lag':
      return t('agents.review.rules.benchmark_lag.evidence', {
        // Signed: isolated, or a Hebrew sentence carries the minus to the number's far side.
        agentReturn: leftToRight(formatPercent(evidence.returnPct)),
        benchmarkReturn: leftToRight(formatPercent(evidence.benchmarkReturnPct)),
        points: formatFixed(Math.abs(evidence.differencePts ?? 0), 2),
        day: evidence.day ? formatDate(new Date(`${evidence.day}T12:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' }) : '—',
      });
  }
}
