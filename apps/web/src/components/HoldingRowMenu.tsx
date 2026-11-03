import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from '@tanstack/react-router';
import { EllipsisVertical, MessageCircleQuestion, Microscope, Minus, Pencil, Plus, Trash2 } from 'lucide-react';

import type { TradeSide } from '@traders/shared';

import { useTranslation } from '../i18n/index.ts';
import { useAgentsQuery } from '../queries/agents.ts';
import { usePrimaryCash } from '../queries/portfolioCash.ts';
import { useResearchQuery } from '../queries/research.ts';
import { useStore } from '../stores/context.tsx';
import { MenuButton } from './HoldingsActions.tsx';
import { ResearchStockDrawer } from './ResearchStockDrawer.tsx';
import { TradePanel } from './TradePanel.tsx';

/** The menu's width; it opens toward the row's start from the button's end edge. */
const MENU_WIDTH_PX = 224;

/**
 * Every holding row's "⋮", in every view (D332, D334, D366): the same six
 * actions on every row, and one that does not apply is shown disabled with
 * the reason, never hidden (D368).
 *
 * - **Buy** and **Sell** record a trade made at the broker on the main
 *   portfolio, through the agents' trade form and fills, with IBI's fee and
 *   the cash moving. Buy needs free cash; Sell needs the real portfolio to hold
 *   the stock - an agent's paper shares are not the user's to sell.
 * - **Ask about this stock** opens the assistant with the question filled in,
 *   not sent (decision 70).
 * - **Research this stock** rates this one stock now, after a confirmation
 *   that it spends the research agent's model (D369).
 * - **Edit** and **Remove** correct the real holding and never touch the cash;
 *   a row with no real part has nothing of the user's to correct: an agent's
 *   holdings change only through its own trades.
 *
 * The list is drawn in a portal at the button's place, because the table
 * scrolls sideways inside its card and would clip a list drawn inside it.
 */
export function HoldingRowMenu({
  symbol,
  instrumentId,
  onEdit,
  onRemove,
}: {
  symbol: string;
  instrumentId: string;
  /** The real holding's corrections; absent on a row the real portfolio does not hold. */
  onEdit?: () => void;
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { ask } = useStore();
  const primary = useAgentsQuery().data?.find((agent) => agent.isPrimary);
  const cash = usePrimaryCash();
  const research = useResearchQuery().data;
  const held = onEdit !== undefined;
  const cashOpen = primary !== undefined && cash.data?.state === 'open';
  const canBuy = cashOpen && cash.data?.state === 'open' && cash.data.cashMinor > 0;
  const canSell = cashOpen && held;
  const researchBlock =
    research === undefined
      ? 'loading'
      : research.agent === null
        ? 'noAgent'
        : research.agent.state !== 'active'
          ? 'agentNotActive'
          : research.run?.status === 'running'
            ? 'running'
            : null;
  const [trading, setTrading] = useState<TradeSide | null>(null);
  const [researching, setResearching] = useState(false);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLUListElement>(null);
  const panelId = useId();

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const rect = button.current.getBoundingClientRect();
    const rtl = getComputedStyle(button.current).direction === 'rtl';
    const left = rtl ? rect.left : rect.right - MENU_WIDTH_PX;
    setPlace({ top: rect.bottom + 4, left: Math.max(8, Math.min(left, window.innerWidth - MENU_WIDTH_PX - 8)) });
  }, [open]);

  // Six actions and their reasons are taller than a phone's space under a low
  // row, and a scroll closes the list: it opens upward when it would not fit.
  useLayoutEffect(() => {
    if (!open || !place || !panel.current || !button.current) return;
    const height = panel.current.offsetHeight;
    if (place.top + height <= window.innerHeight - 8) return;
    const top = Math.max(8, button.current.getBoundingClientRect().top - 4 - height);
    if (top !== place.top) setPlace({ ...place, top });
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    // A fixed list would float away from a row that scrolls: it closes instead.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  const askAbout = () => {
    ask.startNew();
    ask.setDraft(t('holdings.menu.askDraft', { symbol }));
    void navigate({ to: '/ask' });
  };
  const note = (text: string) => <li className="px-3 pb-1 text-[11px] text-text-muted">{text}</li>;

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={t('holdings.menu.label', { symbol })}
        title={t('holdings.menu.label', { symbol })}
        onClick={() => setOpen(!open)}
        className="rounded-lg p-1.5 text-text-muted transition hover:bg-surface-hover hover:text-text-primary"
      >
        <EllipsisVertical className="size-4" aria-hidden />
      </button>
      {open &&
        place &&
        createPortal(
          <ul
            ref={panel}
            id={panelId}
            style={{ top: place.top, left: place.left, width: MENU_WIDTH_PX }}
            className="fixed z-50 rounded-xl border border-border-subtle bg-surface-raised p-1 text-start shadow-lg"
          >
            <li>
              <MenuButton onClick={choose(() => setTrading('buy'))} disabled={!canBuy} icon={<Plus className="size-4" aria-hidden />}>
                {t('holdings.menu.buy')}
              </MenuButton>
            </li>
            <li>
              <MenuButton onClick={choose(() => setTrading('sell'))} disabled={!canSell} icon={<Minus className="size-4" aria-hidden />}>
                {t('holdings.menu.sell')}
              </MenuButton>
            </li>
            {cash.data?.state === 'unset'
              ? note(t('holdings.menu.needsCash'))
              : cashOpen && !canBuy && note(t('holdings.menu.noFreeCash'))}
            {cashOpen && !held && note(t('holdings.menu.notHeld'))}
            <li className="my-1 border-t border-border-subtle" aria-hidden />
            <li>
              <MenuButton onClick={choose(askAbout)} icon={<MessageCircleQuestion className="size-4" aria-hidden />}>
                {t('holdings.menu.ask')}
              </MenuButton>
            </li>
            <li>
              <MenuButton
                onClick={choose(() => setResearching(true))}
                disabled={researchBlock !== null}
                icon={<Microscope className="size-4" aria-hidden />}
              >
                {t('holdings.menu.research')}
              </MenuButton>
            </li>
            {researchBlock !== null && researchBlock !== 'loading' && note(t(`holdings.menu.researchBlocked.${researchBlock}`))}
            <li className="my-1 border-t border-border-subtle" aria-hidden />
            <li>
              <MenuButton onClick={onEdit && choose(onEdit)} disabled={!onEdit} icon={<Pencil className="size-4" aria-hidden />}>
                {t('holdings.menu.edit')}
              </MenuButton>
            </li>
            <li>
              <MenuButton onClick={onRemove && choose(onRemove)} disabled={!onRemove} icon={<Trash2 className="size-4" aria-hidden />}>
                {t('holdings.menu.remove')}
              </MenuButton>
            </li>
            {!held && note(t('holdings.menu.agentOnly'))}
          </ul>,
          document.body,
        )}
      {/* In a portal too: inside the row's end-aligned cell, the form would inherit its alignment. */}
      {trading &&
        primary &&
        createPortal(
          <TradePanel
            agentId={primary.id}
            initialSymbol={symbol}
            initialSide={trading}
            real
            onClose={() => setTrading(null)}
          />,
          document.body,
        )}
      {researching &&
        research?.agent &&
        createPortal(
          <ResearchStockDrawer
            symbol={symbol}
            instrumentId={instrumentId}
            agentName={research.agent.name}
            onClose={() => setResearching(false)}
          />,
          document.body,
        )}
    </>
  );
}
