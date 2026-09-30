import { readEvidence } from '../lib/evidence.ts';

/**
 * The figures a sentence rests on, in the units a person reads.
 *
 * This is the collapsed half of PRD stance P3: the explanation above makes a
 * claim, and this is where the reader checks it. It is a definition list rather
 * than a table because the fields differ per observation kind - a table would
 * need a column set that fits all four rules and the ones not written yet.
 *
 * Each row keeps its raw evidence key as a tooltip. Someone comparing the UI
 * against the API response should be able to line the two up without guessing
 * which pretty label became which key.
 */
export function EvidenceDrawer({
  evidence,
  baseCurrency,
  id,
}: {
  evidence: unknown;
  baseCurrency: string;
  id: string;
}) {
  const sections = readEvidence(evidence, { fallbackCurrency: baseCurrency });

  if (sections.length === 0) {
    return (
      <div id={id} className="mt-3 rounded-lg border border-border-subtle bg-surface/60 px-3 py-2">
        <p className="text-xs text-text-muted">
          This observation was stored without evidence. It is shown as it was recorded rather than
          filled in.
        </p>
      </div>
    );
  }

  return (
    <div
      id={id}
      className="mt-3 space-y-3 rounded-lg border border-border-subtle bg-surface/60 px-3 py-3"
    >
      {sections.map((section, index) => (
        <div key={section.label ?? `figures-${index}`}>
          {section.label && (
            <p className="mb-1 text-[11px] uppercase tracking-wide text-text-muted">
              {section.label}
            </p>
          )}
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
            {section.entries.map((entry) => (
              <div
                key={`${section.label ?? ''}:${entry.key}`}
                className="flex items-baseline justify-between gap-3 border-b border-border-subtle/40 py-1 last:border-0 sm:last:border-b"
              >
                <dt className="text-xs text-text-muted" title={entry.key}>
                  {entry.label}
                </dt>
                <dd className="text-right text-xs font-medium text-text-primary">{entry.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}
