import { useEffect, useRef, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

/** As long as the open transition below, so the scroll sees the card at its final height. */
const OPEN_MS = 200;

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

  // Closing the card above moves this one up, possibly under the header. A new
  // touch cancels it: the page must not move under a thumb that has gone on to
  // something else, and a scroll would close a "⋮" menu it just opened.
  useEffect(() => {
    if (!open) return;
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const timer = window.setTimeout(() => root.current?.scrollIntoView?.({ block: 'nearest' }), still ? 0 : OPEN_MS);
    const cancel = () => window.clearTimeout(timer);
    window.addEventListener('pointerdown', cancel, { once: true });
    return () => {
      cancel();
      window.removeEventListener('pointerdown', cancel);
    };
  }, [open]);

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
      <div
        aria-hidden={!open}
        className={`grid transition-[grid-template-rows,visibility] duration-200 motion-reduce:transition-none ${
          open ? 'visible grid-rows-[1fr]' : 'invisible grid-rows-[0fr]'
        } [&_a]:relative [&_a]:z-[2] [&_button]:relative [&_button]:z-[2]`}
      >
        {/* The padding is room for the page button's focus ring, which the clip would cut. */}
        <div className="-mx-1 -mb-1 min-h-0 overflow-hidden px-1 pb-1">
          <div className="mt-2 space-y-2 border-t border-border-subtle/60 pt-2">{details}</div>
        </div>
      </div>
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
