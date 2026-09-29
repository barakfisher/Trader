/** Small shared primitives, kept in one file while there are only a few. */

import type { ReactNode } from 'react';

export function Card({
  title,
  action,
  children,
  className = '',
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-border-subtle bg-surface-raised ${className}`}
    >
      {(title || action) && (
        <header className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
          {title && <h2 className="text-sm font-semibold tracking-wide text-text-primary">{title}</h2>}
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-surface hover:brightness-110',
  secondary: 'border border-border-subtle bg-surface-hover text-text-primary hover:brightness-110',
  ghost: 'text-text-muted hover:text-text-primary',
  danger: 'border border-loss/40 text-loss hover:bg-loss/10',
};

/**
 * The classes a button of this variant wears. Exported for links that go
 * somewhere - "Topics", "Back to portfolio" - which look like buttons but are
 * anchors with real addresses, so they open in a new tab and read as links.
 */
export function buttonClass(variant: ButtonVariant = 'primary', className = ''): string {
  return `inline-block rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON_VARIANTS[variant]} ${className}`;
}

export function Button({
  children,
  onClick,
  variant = 'primary',
  disabled = false,
  type = 'button',
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  type?: 'button' | 'submit';
  className?: string;
}) {
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={buttonClass(variant, className)}>
      {children}
    </button>
  );
}

export function Delta({ value, children }: { value: number | null | undefined; children: ReactNode }) {
  const tone =
    value === null || value === undefined || value === 0
      ? 'text-text-muted'
      : value > 0
        ? 'text-gain'
        : 'text-loss';
  return <span className={tone}>{children}</span>;
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-text-muted" role="status">
      <span className="size-3 animate-spin rounded-full border-2 border-text-muted border-t-transparent" />
      {label}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-loss/40 bg-loss/10 px-3 py-2 text-sm text-loss">
      <span>{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="underline">
          Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="max-w-md text-sm text-text-muted">{body}</p>
      {action}
    </div>
  );
}
