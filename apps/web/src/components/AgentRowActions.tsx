import { Link } from '@tanstack/react-router';
import { Ellipsis, ExternalLink, Inbox, LoaderCircle, Pause, Play, PlayCircle } from 'lucide-react';

import type { AgentView } from '@traders/shared';

import { useTranslation } from '../i18n/index.ts';
import { agentErrorMessage, agentName } from '../lib/agentPresentation.ts';
import { useRunScan, useUpdateAgent } from '../queries/agents.ts';
import type { ModelAccess } from '../queries/modelAccess.ts';
import { openProposals, useProposalsQuery } from '../queries/proposals.ts';
import { runBlocked, runErrorText } from './AgentScans.tsx';
import { Disclosure } from './Disclosure.tsx';

const ICON_BUTTON =
  'inline-flex size-9 items-center justify-center rounded-lg border border-border-subtle text-text-muted transition hover:border-accent hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border-subtle disabled:hover:text-text-muted';
const MENU_ITEM =
  'flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-start text-sm text-text-muted transition hover:bg-surface-hover hover:text-text-primary';

/**
 * An agent's quick actions on its row of the Agents page (D252): *Run a scan
 * now* and *Pause* / *Resume* as icon buttons, each named for a screen reader,
 * and "⋯" with its pending proposals and its page. Each does exactly what the
 * agent's page does - the same mutation, the same refusals in the same words -
 * so the two can never disagree; the server refuses regardless.
 *
 * Not for the main portfolio, which neither scans nor pauses (D1), nor for an
 * archived agent, which has no actions until it is restored on its page.
 */
export function AgentRowActions({ agent, access }: { agent: AgentView; access: ModelAccess }) {
  const { t } = useTranslation();
  const run = useRunScan(agent.id);
  const update = useUpdateAgent(agent.id);
  const pending = openProposals(useProposalsQuery().data).filter((proposal) => proposal.agentId === agent.id).length;
  const name = agentName(agent);
  const blocked = runBlocked(agent);
  const scanning = run.isPending || agent.runningScan !== null;
  const paused = agent.state === 'paused';
  const error = runErrorText(run.error) ?? (update.error ? agentErrorMessage(update.error, t('agents.saveFailed')) : null);

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => run.mutate()}
          disabled={scanning || blocked !== null || access.block !== null}
          aria-label={t('agents.row.runScan', { name })}
          title={blocked !== null ? t(`agents.scans.refusals.${blocked}`) : t('agents.row.runScan', { name })}
          className={ICON_BUTTON}
        >
          {scanning ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <Play className="size-4" aria-hidden />}
        </button>
        <button
          type="button"
          onClick={() => update.mutate({ state: paused ? 'active' : 'paused' })}
          disabled={update.isPending}
          aria-label={t(paused ? 'agents.row.resume' : 'agents.row.pause', { name })}
          title={t(paused ? 'agents.row.resume' : 'agents.row.pause', { name })}
          className={ICON_BUTTON}
        >
          {paused ? <PlayCircle className="size-4" aria-hidden /> : <Pause className="size-4" aria-hidden />}
        </button>
        <Disclosure label={t('agents.row.more', { name })} icon={<Ellipsis className="size-5" aria-hidden />}>
          <li>
            <Link to="/insights" search={{ tab: 'proposals', agent: agent.id }} className={MENU_ITEM}>
              <Inbox className="size-4" aria-hidden />
              {t('agents.row.pending', { count: pending })}
            </Link>
          </li>
          <li>
            <Link to="/agents/$agentId" params={{ agentId: agent.id }} className={MENU_ITEM}>
              <ExternalLink className="size-4" aria-hidden />
              {t('agents.row.open')}
            </Link>
          </li>
        </Disclosure>
      </div>
      {run.isPending && (
        <p role="status" className="text-xs text-text-muted">
          {t('agents.scans.running')}
        </p>
      )}
      {run.isSuccess && (
        <p role="status" className="text-xs text-text-muted">
          {t('agents.row.scanned')}{' '}
          <Link
            to="/agents/$agentId"
            params={{ agentId: agent.id }}
            search={{ tab: 'scans', scan: run.data.scan_id }}
            className="text-accent hover:underline"
          >
            {t('agents.row.seeScan')}
          </Link>
        </p>
      )}
      {error && <p className="max-w-xs text-end text-xs text-loss">{error}</p>}
    </div>
  );
}
