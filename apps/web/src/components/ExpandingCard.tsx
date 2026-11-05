import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { ChevronDown } from 'lucide-react';

/** As long as the open transition below, so the scroll sees the card at its final height. */
const OPEN_MS = 200;

/**
 * Keeps what just opened on screen. Closing the one above moves it up, possibly
 * under the header. A new touch cancels it: the page must not move under a thumb
 * that has gone on to something else, and a scroll would close a "⋮" menu it just
 * opened.
 */
export function useRevealOnOpen(target: RefObject<HTMLElement | null>, open: boolean) {
  useEffect(() => {
    if (!open) return;
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const timer = window.setTimeout(() => target.current?.scrollIntoView?.({ block: 'nearest' }), still ? 0 : OPEN_MS);
    const cancel = () => window.clearTimeout(timer);
    window.addEventListener('pointerdown', cancel, { once: true });
    return () => {
      cancel();
      window.removeEventListener('pointerdown', cancel);
    };
  }, [open, target]);
}

/**
 * What opens: stays mounted so closing can animate and typing in it survives;
 * closed, it is out of the tab order and the accessibility tree. With `active`
 * off (a wide screen) it is two plain wrappers around content that is simply
 * there, and the same two, so crossing the width never remounts what is inside.
 */
export function ExpandingPanel({
  id,
  open,
  active = true,
  className = '',
  clipClassName = '',
  children,
}: {
  id?: string;
  open: boolean;
  active?: boolean;
  className?: string;
  /** On the clipping element: room a focus ring needs, which the clip would otherwise cut. */
  clipClassName?: string;
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      aria-hidden={active ? !open : undefined}
      className={
        active
          ? `grid transition-[grid-template-rows,visibility] duration-200 motion-reduce:transition-none ${
              open ? 'visible grid-rows-[1fr]' : 'invisible grid-rows-[0fr]'
            } ${className}`
          : className
      }
    >
      <div className={active ? `min-h-0 overflow-hidden ${clipClassName}` : undefined}>{children}</div>
    </div>
  );
}

/**
 * A phone's holding card: a tap anywhere opens the details under it (D384).
 *
 * The whole card answers through one real button laid over it - a stretched
 * button rather than a click handler on the card, so a keyboard and a screen
 * reader have something to reach, and it says whether it is open. The controls
 * inside (the rating, "⋮", approving) sit above that button and do their own
 * thing. While the card is `locked` (being edited, or asking to confirm a
 * removal) the button is gone, so a tap in a field cannot close what is being typed.
 *
 * The details stay mounted so closing can animate too; closed, they are out of
 * the tab order and the accessibility tree.
 */
export function ExpandingCard({
  label,
  open,
  locked,
  onToggle,
  details,
  children,
}: {
  label: string;
  open: boolean;
  locked: boolean;
  onToggle: () => void;
  details: ReactNode;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);

  useRevealOnOpen(root, open);

  return (
    <div ref={root} className="relative scroll-mt-16">
      {!locked && (
        <button
          type="button"
          aria-expanded={open}
          aria-label={label}
          onClick={onToggle}
          className="absolute inset-0 z-[1] rounded-lg transition active:bg-surface-hover/40"
        />
      )}
      <div className="[&_a]:relative [&_a]:z-[2] [&_button]:relative [&_button]:z-[2]">{children}</div>
      <ExpandingPanel
        open={open}
        className="[&_a]:relative [&_a]:z-[2] [&_button]:relative [&_button]:z-[2]"
        clipClassName="-mx-1 -mb-1 px-1 pb-1"
      >
        <div className="mt-2 space-y-2 border-t border-border-subtle/60 pt-2">{details}</div>
      </ExpandingPanel>
    </div>
  );
}

/** The mark that a card opens; it turns over once it has. */
export function ExpandMark({ open }: { open: boolean }) {
  return (
    <ChevronDown
      className={`size-4 shrink-0 text-text-muted transition-transform duration-200 motion-reduce:transition-none ${
        open ? 'rotate-180' : ''
      }`}
      aria-hidden
    />
  );
}

/** One figure in an open card: its name at the start of the line, its value at the end. */
export function CardDetail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <dt className="text-text-muted">{label}</dt>
      <dd className="text-end tabular-nums">{children}</dd>
    </div>
  );
}
