import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useRouterState } from '@tanstack/react-router';

/**
 * A button that shows a list beneath it - the app bar's menus, the holdings
 * card's "⋯". A disclosure rather than an ARIA menu: its items are links and
 * buttons, Tab walks them, and there is no arrow-key model to get wrong.
 *
 * Closes on Escape (focus back on the button), on a click outside, on choosing
 * an item, and when the address changes - following a link is the usual way
 * to leave.
 */
export function Disclosure({
  label,
  icon,
  openIcon,
  children,
}: {
  label: string;
  icon: ReactNode;
  openIcon?: ReactNode;
  /** `<li>` items. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={label}
        title={label}
        onClick={() => setOpen(!open)}
        className="flex items-center rounded-lg p-1.5 text-text-muted transition hover:bg-surface-hover hover:text-text-primary"
      >
        {open && openIcon ? openIcon : icon}
      </button>
      {open && (
        <ul
          id={panelId}
          // Choosing an item is done with the menu. A disabled one is not a choice.
          onClick={(event) => {
            const item = (event.target as HTMLElement).closest('a, button');
            if (item && !(item as HTMLButtonElement).disabled) setOpen(false);
          }}
          className="absolute end-0 top-full z-40 mt-2 w-56 rounded-xl border border-border-subtle bg-surface-raised p-1 shadow-lg"
        >
          {children}
        </ul>
      )}
    </div>
  );
}
