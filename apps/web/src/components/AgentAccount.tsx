import { useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';

import type { ActivityEntry, AgentAccountResponse, AgentView, HoldingView } from '@traders/shared';

import { errorMessage } from '../api/client.ts';
import { useTranslation } from '../i18n/index.ts';
import { formatMoney, formatNumber, formatPercent } from '../i18n/format.ts';
import { BUDGET_INPUT, tradeErrorMessage } from '../lib/agentPresentation.ts';
import { formatExactTime } from '../lib/relativeTime.ts';
import { useAgentAccountQuery, useAgentActivityQuery, useTopUp } from '../queries/agents.ts';
import { AgentField } from './AgentField.tsx';
import { Button, Card, Delta, EmptyState, ErrorNote, Spinner } from './ui.tsx';

/**
 * A simulated agent's standing (D6): cash, what it holds at market, net worth,
 * and profit or loss against everything deposited. When a holding is unpriced
 * the totals are not shown - a total that left a position out would read as
 * complete (guideline 7) - and the unpriced symbols are named instead.
 */
export function AccountSummary({ agent }: { agent: AgentView }) {
  const { t } = useTranslation();
  const account = useAgentAccountQuery(agent.id, true);
  if (account.isPending) return <Spinner label={t('agents.account.loading')} />;
  if (account.error) {
    return (
      <ErrorNote
        message={errorMessage(account.error, t('agents.account.loadFailed'))}
        onRetry={() => void account.refetch()}
      />
    );
  }
  const data = account.data;
  const money = (minor: number | null) => <bdi>{formatMoney(minor, data.currency)}</bdi>;
  const unpriced = data.portfolio.summary.unpricedSymbols;
  return (
    <Card title={t('agents.account.title')} action={agent.state === 'archived' ? undefined : <AddCash agent={agent} />}>
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Figure label={t('agents.account.cash')}>{money(data.cashMinor)}</Figure>
        <Figure label={t('agents.account.holdingsValue')}>{money(data.holdingsValueMinor)}</Figure>
        <Figure label={t('agents.account.netWorth')}>{money(data.netWorthMinor)}</Figure>
        <Figure label={t('agents.account.pnl')}>
          <Delta value={data.pnlMinor}>
            {money(data.pnlMinor)} <bdi>{formatPercent(data.pnlPct)}</bdi>
          </Delta>
        </Figure>
      </dl>
      <p className="mt-3 text-xs text-text-muted">
        {t('agents.account.pnlHint', { deposits: formatMoney(data.depositsMinor, data.currency) })}
      </p>
      {unpriced.length > 0 && (
        <p className="mt-2 text-xs text-loss">
          {t('agents.account.unpriced', { symbols: unpriced.join(', ') })}
        </p>
      )}
    </Card>
  );
}

function Figure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}

/** Add cash (D22, D31): the budget rises by the amount, recorded as a top-up once the agent has traded. */
function AddCash({ agent }: { agent: AgentView }) {
  const { t } = useTranslation();
  const topUp = useTopUp(agent.id);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const valid = BUDGET_INPUT.test(amount.trim()) && Number(amount) > 0;

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <span className="flex items-center gap-1">
          <Plus className="size-4" aria-hidden />
          {t('agents.addCash.button')}
        </span>
      </Button>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    topUp.mutate(
      { amount: amount.trim() },
      {
        onSuccess: () => {
          setAmount('');
          setOpen(false);
        },
      },
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <AgentField label={t('agents.addCash.label')}>
        <input
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          inputMode="decimal"
          dir="ltr"
          autoFocus
          aria-invalid={amount !== '' && !valid}
          className="w-28 rounded-md border border-border-subtle bg-surface px-2 py-1 text-start"
        />
      </AgentField>
      <Button type="submit" disabled={!valid || topUp.isPending}>
        {t('agents.addCash.submit')}
      </Button>
      <Button variant="ghost" onClick={() => setOpen(false)}>
        {t('agents.addCash.cancel')}
      </Button>
      {topUp.error && <ErrorNote message={tradeErrorMessage(topUp.error, t('agents.addCash.failed'))} />}
    </form>
  );
}

/** What the agent holds, at market, each with a Sell that opens the trade panel on it. */
export function AgentHoldings({
  agent,
  onSell,
}: {
  agent: AgentView;
  onSell: (symbol: string) => void;
}) {
  const { t } = useTranslation();
  const account = useAgentAccountQuery(agent.id, true);
  const holdings: HoldingView[] = account.data?.portfolio.holdings ?? [];
  if (!account.data) return null;
  if (holdings.length === 0) {
    return <EmptyState title={t('agents.holdingsEmpty.title')} body={t('agents.holdingsEmpty.body')} />;
  }
  const currency = (account.data as AgentAccountResponse).currency;
  const money = (minor: number | null) => <bdi>{formatMoney(minor, currency)}</bdi>;
  return (
    <ul className="divide-y divide-border-subtle/60 rounded-xl border border-border-subtle bg-surface-raised">
      {holdings.map((holding) => (
        <li key={holding.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
          <div>
            <p className="font-medium">
              <bdi>{holding.instrument.symbol}</bdi>
            </p>
            <p className="text-xs text-text-muted">
              {t('agents.holdings.line', {
                quantity: formatNumber(Number(holding.quantity)),
                cost: formatMoney(holding.costBasisMinor, currency),
              })}
            </p>
          </div>
          <div className="text-end">
            <p>{holding.valueMinor === null ? t('agents.holdings.unpriced') : money(holding.valueMinor)}</p>
            <p className="text-xs">
              <Delta value={holding.pnlMinor}>
                {money(holding.pnlMinor)} <bdi>{formatPercent(holding.pnlPct)}</bdi>
              </Delta>
            </p>
          </div>
          {agent.state !== 'archived' && (
            <Button variant="secondary" onClick={() => onSell(holding.instrument.symbol)}>
              {t('agents.holdings.sell')}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Every movement of the agent's cash, newest first, each with the balance it left (D31). */
export function AgentActivity({ agent }: { agent: AgentView }) {
  const { t } = useTranslation();
  const activity = useAgentActivityQuery(agent.id, true);
  if (activity.isPending) return <Spinner label={t('agents.activity.loading')} />;
  if (activity.error) {
    return (
      <ErrorNote
        message={errorMessage(activity.error, t('agents.activity.loadFailed'))}
        onRetry={() => void activity.refetch()}
      />
    );
  }
  if (activity.data.entries.length === 0) {
    return <EmptyState title={t('agents.activityEmpty.title')} body={t('agents.activityEmpty.body')} />;
  }
  return (
    <ul className="divide-y divide-border-subtle/60 rounded-xl border border-border-subtle bg-surface-raised">
      {activity.data.entries.map((entry) => (
        <ActivityRow key={entry.id} entry={entry} currency={activity.data.currency} />
      ))}
    </ul>
  );
}

function ActivityRow({ entry, currency }: { entry: ActivityEntry; currency: string }) {
  const { t } = useTranslation();
  const fill = entry.fill;
  const title =
    fill === null
      ? t(`agents.activity.kinds.${entry.kind === 'top_up' ? 'topUp' : 'openingDeposit'}`)
      : t(`agents.activity.${fill.side}`, {
          quantity: formatNumber(Number(fill.quantity)),
          symbol: fill.symbol,
          price: formatMoney(fill.priceMinor, currency),
        });
  const priceNote =
    fill === null
      ? null
      : fill.priceSource === 'user'
        ? t('agents.activity.typedPrice')
        : t('agents.activity.marketPrice', { time: formatExactTime(fill.quoteAsOf) });
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 p-3 text-sm">
      <div>
        <p className="font-medium">{title}</p>
        <p className="text-xs text-text-muted">
          {formatExactTime(entry.createdAt)}
          {priceNote && <> · {priceNote}</>}
          {fill && <> · {t('agents.activity.fee', { fee: formatMoney(fill.feeMinor, currency) })}</>}
        </p>
      </div>
      <div className="text-end">
        <p>
          <Delta value={entry.amountMinor}>
            <bdi>{formatMoney(entry.amountMinor, currency)}</bdi>
          </Delta>
        </p>
        <p className="text-xs text-text-muted">
          {t('agents.activity.balance', { balance: formatMoney(entry.balanceAfterMinor, currency) })}
        </p>
      </div>
    </li>
  );
}
