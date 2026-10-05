import { useId, type ReactElement, cloneElement } from 'react';

/**
 * A labelled agent field whose hint is announced as a description, not as part
 * of the field's name - a screen reader says "Paper budget (USD)", then the hint.
 */
export function AgentField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactElement<{ id?: string; 'aria-describedby'?: string }>;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="text-sm">
      <label htmlFor={id} className="mb-1 block text-text-muted">
        {label}
      </label>
      {cloneElement(children, { id, ...(hint ? { 'aria-describedby': hintId } : {}) })}
      {hint && (
        <p id={hintId} className="mt-1 text-xs text-text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}
