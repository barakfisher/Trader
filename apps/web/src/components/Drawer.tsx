import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

/**
 * A panel over the page from its end edge: a form too long for a modal and too
 * short for a page of its own - adding a holding, placing a trade.
 *
 * On a phone it is the whole screen (`w-full`, up to `max-w-md`), which is what
 * a sheet is there. Escape or a click on the shade closes it. Focus moves into
 * it on opening - to its first field - and back to whatever opened it on
 * closing, so a keyboard user is never left on a control that is now behind
 * the shade.
 */
export function Drawer({
  title,
  closeLabel,
  onClose,
  children,
}: {
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>('input, select, textarea');
    (first ?? panel.current)?.focus();
    return () => opener?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onClick={onClose}>
      <aside
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="h-full w-full max-w-md overflow-y-auto border-s border-border-subtle bg-surface-raised p-4 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="mb-4 flex items-center justify-between">
          <h2 id={titleId} className="text-sm font-semibold">
            {title}
          </h2>
          <button type="button" onClick={onClose} aria-label={closeLabel} className="text-text-muted">
            <X className="size-4" aria-hidden />
          </button>
        </header>
        {children}
      </aside>
    </div>
  );
}
