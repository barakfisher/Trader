import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EllipsisVertical, Minus, Pencil, Plus, Trash2 } from 'lucide-react';

import type { TradeSide } from '@traders/shared';

import { useTranslation } from '../i18n/index.ts';
import { useAgentsQuery } from '../queries/agents.ts';
import { usePrimaryCash } from '../queries/portfolioCash.ts';
import { MenuButton } from './HoldingsActions.tsx';
import { TradePanel } from './TradePanel.tsx';

/** The menu's width; it opens toward the row's start from the button's end edge. */
const MENU_WIDTH_PX = 224;

/**
 * A main-portfolio holding's "⋮" (D332, D334): Buy and Sell record a trade made
 * at the broker, through the agents' trade form and fills, with IBI's fee and
 * the cash moving; Edit and Remove are corrections that never touch the cash.
 *
 * Buy and Sell wait for the cash to be set: a trade moves it. The list is
 * drawn in a portal at the button's place, because the table scrolls sideways
 * inside its card and would clip a list drawn inside it.
 */
export function HoldingRowMenu({
  symbol,
  onEdit,
  onRemove,
}: {
  symbol: string;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const primary = useAgentsQuery().data?.find((agent) => agent.isPrimary);
  const cash = usePrimaryCash();
  const canTrade = primary !== undefined && cash.data?.state === 'open';
  const [trading, setTrading] = useState<TradeSide | null>(null);
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
              <MenuButton onClick={choose(() => setTrading('buy'))} disabled={!canTrade} icon={<Plus className="size-4" aria-hidden />}>
                {t('holdings.menu.buy')}
              </MenuButton>
            </li>
            <li>
              <MenuButton onClick={choose(() => setTrading('sell'))} disabled={!canTrade} icon={<Minus className="size-4" aria-hidden />}>
                {t('holdings.menu.sell')}
              </MenuButton>
            </li>
            {cash.data?.state === 'unset' && (
              <li className="px-3 pb-1 text-[11px] text-text-muted">{t('holdings.menu.needsCash')}</li>
            )}
            <li className="my-1 border-t border-border-subtle" aria-hidden />
            <li>
              <MenuButton onClick={choose(onEdit)} icon={<Pencil className="size-4" aria-hidden />}>
                {t('holdings.menu.edit')}
              </MenuButton>
            </li>
            <li>
              <MenuButton onClick={choose(onRemove)} icon={<Trash2 className="size-4" aria-hidden />}>
                {t('holdings.menu.remove')}
              </MenuButton>
            </li>
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
    </>
  );
}
