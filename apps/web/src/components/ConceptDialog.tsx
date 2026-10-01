import { useEffect, useRef } from 'react';
import { observer } from 'mobx-react-lite';
import { X } from 'lucide-react';

import { SERVER_ENGLISH } from '../lib/textDirection.ts';
import { ConceptText } from './ConceptText.tsx';
import { conceptLabel } from '../lib/observationPresentation.ts';
import { errorMessage } from '../api/client.ts';
import { useConceptQuery } from '../queries/concepts.ts';
import { useStore } from '../stores/context.tsx';
import { ErrorNote, Spinner } from './ui.tsx';

/**
 * The explanation behind a concept chip.
 *
 * A dialog rather than a page or an inline expansion. A page would take the
 * reader away from the observation that raised the question, which is the
 * context that makes the answer worth reading; an inline expansion would push
 * the rest of the feed down by several screens every time somebody asked what a
 * word meant.
 *
 * Nothing renders when no concept is open, so the feed pays nothing for this.
 */
export const ConceptDialog = observer(function ConceptDialog() {
  const { concepts } = useStore();
  const closeRef = useRef<HTMLButtonElement>(null);
  const slug = concepts.openSlug;
  const concept = useConceptQuery(slug);

  // Escape closes, from anywhere. Registered only while open so the handler is
  // not sitting on the document for the whole session.
  useEffect(() => {
    if (slug === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') concepts.close();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [slug, concepts]);

  // Move focus into the dialog when it opens, or a keyboard user is left on the
  // chip behind the overlay with no way into what just appeared.
  useEffect(() => {
    if (slug !== null) closeRef.current?.focus();
  }, [slug]);

  if (slug === null) return null;

  const document_ = concept.data ?? null;
  const title = document_?.title ?? conceptLabel(slug);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8"
      // The backdrop closes, but only when the backdrop itself is the target:
      // without the check, a click that starts on the text and drifts onto the
      // overlay closes the dialog mid-selection.
      onClick={(event) => {
        if (event.target === event.currentTarget) concepts.close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="concept-dialog-title"
        className="w-full max-w-2xl rounded-lg border border-border bg-surface shadow-xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h2 id="concept-dialog-title" className="text-base font-medium text-text-primary">
              {title}
            </h2>
            <p className="mt-0.5 text-[11px] uppercase tracking-wide text-text-muted">Concept</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={concepts.close}
            aria-label="Close explanation"
            className="rounded p-1 text-text-muted hover:bg-surface-hover hover:text-text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          {concept.isPending && <Spinner label="Loading the explanation…" />}

          {concept.data === null && (
            <p className="text-sm text-text-muted">
              No explanation is available for “{conceptLabel(slug)}” yet. The concept corpus may not
              have been ingested in this environment.
            </p>
          )}

          {concept.error && (
            <ErrorNote
              message={errorMessage(concept.error, 'The explanation could not be loaded.')}
              onRetry={() => void concept.refetch()}
            />
          )}

          {document_ !== null && (
            <article {...SERVER_ENGLISH} className="space-y-5">
              {document_.sections.map((section) => (
                <section key={section.id}>
                  {section.heading !== null && (
                    <h3 className="text-sm font-medium text-text-primary">{section.heading}</h3>
                  )}
                  <div className="mt-1">
                    <ConceptText text={section.text} />
                  </div>
                </section>
              ))}

              <p className="border-t border-border pt-3 text-[11px] text-text-muted">
                Source: {document_.source} · Licence: {document_.license}
                {document_.uri !== null && (
                  <>
                    {' · '}
                    <a
                      href={document_.uri}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-accent hover:underline"
                    >
                      original
                    </a>
                  </>
                )}
              </p>
            </article>
          )}
        </div>
      </div>
    </div>
  );
});
