/**
 * Turning a stored concept section into renderable blocks.
 *
 * The corpus is markdown, but only a deliberately small subset of it: the
 * documents are written to a fixed four-section shape and use exactly four
 * devices - paragraphs, four-space indented formula blocks, `**bold**` to open
 * a misreading, and `*italic*` for the emphasised word inside a sentence.
 * Nothing else is used, and a test over the shipped corpus asserts that: the
 * italics were found by auditing the documents rather than assumed away, after
 * a first version of this parser would have rendered them as literal asterisks.
 *
 * So this is a parser for that subset rather than a markdown library. The
 * alternative was a dependency that renders arbitrary markdown, which for
 * server-supplied prose means either trusting it with `dangerouslySetInnerHTML`
 * or sanitising it - and the corpus reaches the browser through two services
 * from a database anyone with a shell can write to. Parsing three constructs
 * into React elements means no HTML is ever constructed from that text at all.
 *
 * Anything unrecognised renders as plain text, which is the safe direction: a
 * new markdown construct in a document looks slightly wrong rather than
 * disappearing.
 */

/** A run of text, with the emphasis the document asked for. */
export interface TextSpan {
  text: string;
  style: 'plain' | 'bold' | 'italic';
}

export type ConceptBlock =
  | { kind: 'paragraph'; spans: TextSpan[] }
  /** A four-space indented run, kept verbatim: it is usually a formula. */
  | { kind: 'code'; text: string };

const INDENT = /^ {4}\S/;

/**
 * `**bold**` before `*italic*`, because the alternation is tried left to right
 * and a bold marker would otherwise parse as an italic wrapping an empty
 * string. Both bodies are non-greedy and reject `*`, so two separate emphases
 * in one sentence stay separate instead of merging into one long run.
 */
const EMPHASIS = /\*\*([^*]+)\*\*|\*([^*]+)\*/g;

/**
 * Split emphasis runs out of a line of prose.
 *
 * Unbalanced markers are left as literal text rather than swallowed: a document
 * with a stray `*` should look odd, not lose a sentence.
 */
export function parseSpans(text: string): TextSpan[] {
  const spans: TextSpan[] = [];
  let cursor = 0;

  for (const match of text.matchAll(EMPHASIS)) {
    const start = match.index;
    if (start > cursor) spans.push({ text: text.slice(cursor, start), style: 'plain' });

    spans.push(
      match[1] !== undefined
        ? { text: match[1], style: 'bold' }
        : { text: match[2]!, style: 'italic' },
    );
    cursor = start + match[0].length;
  }

  if (cursor < text.length) spans.push({ text: text.slice(cursor), style: 'plain' });
  return spans.filter((span) => span.text.length > 0);
}

/**
 * Split one section's text into blocks.
 *
 * Paragraphs are separated by blank lines and their internal newlines are
 * collapsed to spaces, because the corpus is hard-wrapped at about 80 columns
 * for the benefit of a diff, not of a reader - preserving those breaks would
 * wrap the text twice.
 */
export function parseConceptText(text: string): ConceptBlock[] {
  const blocks: ConceptBlock[] = [];

  for (const chunk of text.split(/\n\s*\n/)) {
    const lines = chunk.split('\n').filter((line) => line.trim().length > 0);
    if (lines.length === 0) continue;

    if (lines.every((line) => INDENT.test(line))) {
      blocks.push({ kind: 'code', text: lines.map((line) => line.slice(4)).join('\n') });
      continue;
    }

    const paragraph = lines.map((line) => line.trim()).join(' ');
    blocks.push({ kind: 'paragraph', spans: parseSpans(paragraph) });
  }

  return blocks;
}
