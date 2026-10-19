import { useId, type ReactElement, cloneElement } from 'react';

/**
 * A labelled agent field whose hint is announced as a description, not as part
 * of the field's name - a screen reader says "Paper budget (USD)", then the hint.
 *
 * `aligned`: one of a row of fields in a grid. Label, field and hint take the
 * row's three subgrid rows, labels sitting on the field, so a label that wraps
 * to two lines no longer pushes its own field below its neighbours'.
 */
export function AgentField({
  label,
  hint,
  aligned = false,
  children,
}: {
  label: string;
  hint?: string;
  aligned?: boolean;
  children: ReactElement<{ id?: string; 'aria-describedby'?: string }>;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className={aligned ? 'text-sm sm:row-span-3 sm:grid sm:grid-rows-subgrid sm:gap-y-0' : 'text-sm'}>
      <label htmlFor={id} className={`mb-1 block text-text-muted ${aligned ? 'sm:self-end' : ''}`}>
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
