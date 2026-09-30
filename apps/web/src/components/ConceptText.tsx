import { parseConceptText, type TextSpan } from '../lib/conceptText.ts';

/**
 * Corpus text rendered as the corpus wrote it: paragraphs, formula blocks,
 * bold and italic - parsed into elements (`conceptText.ts`), never HTML. Shared
 * by the concept dialog and `/ask`'s quoted passages, so a passage reads the
 * same wherever it is quoted.
 */
export function ConceptText({ text, size = 'sm' }: { text: string; size?: 'sm' | 'xs' }) {
  const prose = size === 'sm' ? 'text-sm' : 'text-xs';
  return (
    <div className="space-y-2">
      {parseConceptText(text).map((block, index) =>
        block.kind === 'code' ? (
          <pre
            key={index}
            className="overflow-x-auto rounded bg-surface-hover px-3 py-2 text-xs text-text-primary"
          >
            {block.text}
          </pre>
        ) : (
          <p key={index} className={`${prose} leading-relaxed text-text-muted`}>
            <Spans spans={block.spans} />
          </p>
        ),
      )}
    </div>
  );
}

function Spans({ spans }: { spans: TextSpan[] }) {
  return (
    <>
      {spans.map((span, index) => {
        if (span.style === 'bold') {
          return (
            <strong key={index} className="font-medium text-text-primary">
              {span.text}
            </strong>
          );
        }
        if (span.style === 'italic') {
          return (
            <em key={index} className="italic">
              {span.text}
            </em>
          );
        }
        return <span key={index}>{span.text}</span>;
      })}
    </>
  );
}

