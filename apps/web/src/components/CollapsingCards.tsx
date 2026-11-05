import { createContext, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useNarrowViewport } from '../lib/viewport.ts';
import { ExpandMark, ExpandingPanel, useRevealOnOpen } from './ExpandingCard.tsx';

interface CardGroup {
  /** A phone. On a wider screen the cards inside are open and offer nothing to close. */
  active: boolean;
  openId: string | null;
  setOpenId: (id: string | null) => void;
  /** Whether a card that opens itself also brings itself on screen. */
  revealAttention: boolean;
}

const CardGroupContext = createContext<CardGroup | null>(null);

export function useCardGroup(): CardGroup | null {
  return useContext(CardGroupContext);
}

/**
 * On a phone, every titled `Card` inside is a closed line, and a tap opens one at
 * a time (D385). A long page of settings is read for one card, so the first thing
 * it owes a phone is the list of what is there.
 *
 * Whatever is inside stays mounted when closed, and crossing the width (a phone
 * turned on its side) keeps the same elements: typing is never lost to either.
 */
export function CollapsingCards({
  revealAttention = true,
  children,
}: {
  revealAttention?: boolean;
  children: ReactNode;
}) {
  const active = useNarrowViewport();
  const [openId, setOpenId] = useState<string | null>(null);
  const group = useMemo(
    () => ({ active, openId, setOpenId, revealAttention }),
    [active, openId, revealAttention],
  );
  return <CardGroupContext.Provider value={group}>{children}</CardGroupContext.Provider>;
}

/** `Card`'s body inside a `CollapsingCards`; `Card` chooses it, so call sites stay as they are. */
export function CollapsingCard({
  group,
  title,
  className,
  attention,
  children,
}: {
  group: CardGroup;
  title: string;
  className: string;
  attention: string | null;
  children: ReactNode;
}) {
  const id = useId();
  const panelId = useId();
  const root = useRef<HTMLElement>(null);
  const { active, openId, setOpenId, revealAttention } = group;
  const open = !active || openId === id;
  const openedItself = useRef(false);

  // Before paint, so a card that arrives needing attention is simply open.
  useLayoutEffect(() => {
    if (attention === null) return;
    openedItself.current = true;
    setOpenId(id);
  }, [attention, id, setOpenId]);

  useRevealOnOpen(root, active && open && (revealAttention || !openedItself.current));

  const headerClass = !active
    ? 'flex items-center justify-between border-b border-border-subtle px-4 py-3'
    : open
      ? 'border-b border-border-subtle'
      : undefined;

  return (
    <section
      ref={root}
      className={`scroll-mt-16 rounded-xl border border-border-subtle bg-surface-raised ${className}`}
    >
      <header className={headerClass}>
        <h2 className="text-sm font-semibold tracking-wide text-text-primary">
          {active ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => {
                openedItself.current = false;
                setOpenId(open ? null : id);
              }}
              className="flex w-full items-center justify-between gap-2 rounded-xl px-4 py-3 text-start font-semibold transition active:bg-surface-hover/40"
            >
              <span>{title}</span>
              <ExpandMark open={open} />
            </button>
          ) : (
            title
          )}
        </h2>
      </header>
      <ExpandingPanel id={panelId} open={open} active={active}>
        {/* A card inside a card would be its own matter, not this group's. */}
        <CardGroupContext.Provider value={null}>
          <div className="p-4">{children}</div>
        </CardGroupContext.Provider>
      </ExpandingPanel>
    </section>
  );
}
