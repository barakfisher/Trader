import { Link } from '@tanstack/react-router';

import type { EvidenceChecked as Checked, ToolCheck } from '@traders/shared';

import { useTranslation } from '../i18n/index.ts';

/**
 * What an agent's scan looked at before it proposed a trade: each tool it
 * called and what it asked, read from the scan's transcript by the server - so
 * the user can judge how well-founded the trade is before approving it. The
 * link opens that transcript in the agent's *Decisions* tab, with the scan
 * expanded.
 *
 * A tool is named by the catalogue, never by its code name; a symbol is set
 * left to right, so "NVDA" reads the same on a Hebrew page.
 */
export function EvidenceCheckedLine({
  checked,
  agentId,
  scanId,
}: {
  checked: Checked;
  agentId: string;
  scanId: string;
}) {
  const { t } = useTranslation();
  const empty = checked.checks.length === 0 && checked.otherCalls === 0;
  return (
    <section aria-label={t('proposal.trade.checked.label')} className="space-y-1 text-xs">
      <p className="text-text-muted">
        <span className="font-semibold">{t('proposal.trade.checked.label')}: </span>
        {empty ? (
          t('proposal.trade.checked.none')
        ) : (
          <>
            {checked.checks.map((check, index) => (
              <span key={`${check.tool}:${check.subject ?? ''}`}>
                {index > 0 && ' · '}
                <CheckText check={check} />
              </span>
            ))}
            {checked.otherCalls > 0 && (
              <>
                {checked.checks.length > 0 && ' · '}
                {t('proposal.trade.checked.other', { count: checked.otherCalls })}
              </>
            )}
          </>
        )}
      </p>
      <Link
        to="/agents/$agentId"
        params={{ agentId }}
        search={{ tab: 'decisions', scan: scanId }}
        className="text-accent hover:underline"
      >
        {t('proposal.trade.checked.transcript')}
      </Link>
    </section>
  );
}

function CheckText({ check }: { check: ToolCheck }) {
  const { t } = useTranslation();
  const quoted = check.tool === 'search_universe' || check.tool === 'explain_concept';
  const window =
    check.days === null
      ? null
      : check.tool === 'get_price_history'
        ? t('proposal.trade.checked.tradingDays', { count: check.days })
        : check.tool === 'get_news'
          ? t('proposal.trade.checked.days', { count: check.days })
          : null;
  return (
    <>
      {t(`proposal.trade.checked.tools.${check.tool}`)}
      {check.subject !== null && (
        <>
          {' '}
          {quoted ? (
            // A search phrase is the model's text, in whichever script it wrote.
            <bdi>{t('proposal.trade.checked.quoted', { text: check.subject })}</bdi>
          ) : (
            <bdi dir="ltr">{check.subject}</bdi>
          )}
        </>
      )}
      {window !== null && ` (${window})`}
    </>
  );
}
