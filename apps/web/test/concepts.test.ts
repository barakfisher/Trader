/**
 * The chips, and what happens behind them.
 *
 * Two properties carry the weight. A definition is fetched once per session,
 * because the corpus changes when somebody edits a file rather than with the
 * market, and a reader who meets `drawdown` on three observations should pay
 * for one request. And a concept the corpus does not hold has to read as "no
 * explanation available" rather than as a failure - otherwise an environment
 * that simply has not ingested the corpus greets its first user with an error.
 *
 * The text parser is tested against the shape the shipped documents actually
 * use, not against invented markdown.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConceptDocument } from '@traders/shared';

const get = vi.fn();
const post = vi.fn();
const postForm = vi.fn();
const patch = vi.fn();
const put = vi.fn();
const del = vi.fn();

class FakeApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

vi.mock('../src/api/client.ts', () => ({
  api: { get, post, postForm, patch, put, delete: del },
  ApiRequestError: FakeApiRequestError,
}));

const { RootStore } = await import('../src/stores/RootStore.ts');
const { parseConceptText, parseSpans } = await import('../src/lib/conceptText.ts');

const document_ = (over: Partial<ConceptDocument> = {}): ConceptDocument => ({
  slug: 'drawdown',
  title: 'Drawdown',
  source: 'traders-curated',
  uri: null,
  license: 'CC0-1.0',
  sections: [{ id: 'chunk-1', ord: 1, heading: 'What it is', text: 'A fall from a recent high.' }],
  ...over,
});

describe('ConceptStore', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches a concept and exposes it', async () => {
    const root = new RootStore();
    get.mockResolvedValueOnce(document_());

    await root.concepts.open('drawdown');

    expect(get).toHaveBeenCalledWith('/concepts/drawdown');
    expect(root.concepts.current?.title).toBe('Drawdown');
    expect(root.concepts.loading).toBe(false);
  });

  it('serves a second open of the same concept from cache', async () => {
    const root = new RootStore();
    get.mockResolvedValueOnce(document_());

    await root.concepts.open('drawdown');
    root.concepts.close();
    await root.concepts.open('drawdown');

    expect(get).toHaveBeenCalledTimes(1);
    expect(root.concepts.current?.title).toBe('Drawdown');
  });

  it('treats a concept the corpus does not hold as absent, not broken', async () => {
    const root = new RootStore();
    get.mockRejectedValueOnce(new FakeApiRequestError('not found', 404));

    await root.concepts.open('nonexistent');

    expect(root.concepts.notFound).toBe(true);
    expect(root.concepts.error).toBeNull();
  });

  it('reports a real failure as an error', async () => {
    const root = new RootStore();
    get.mockRejectedValueOnce(new FakeApiRequestError('upstream exploded', 502));

    await root.concepts.open('drawdown');

    expect(root.concepts.notFound).toBe(false);
    expect(root.concepts.error).toContain('upstream exploded');
  });

  it('retries with a real request rather than re-reading a cached failure', async () => {
    const root = new RootStore();
    get.mockRejectedValueOnce(new FakeApiRequestError('transient', 503));
    await root.concepts.open('drawdown');

    get.mockResolvedValueOnce(document_());
    await root.concepts.retry();

    expect(get).toHaveBeenCalledTimes(2);
    expect(root.concepts.current?.title).toBe('Drawdown');
    expect(root.concepts.error).toBeNull();
  });

  it('clears the error state when a different concept is opened', async () => {
    const root = new RootStore();
    get.mockRejectedValueOnce(new FakeApiRequestError('not found', 404));
    await root.concepts.open('nonexistent');

    get.mockResolvedValueOnce(document_());
    await root.concepts.open('drawdown');

    expect(root.concepts.notFound).toBe(false);
    expect(root.concepts.error).toBeNull();
  });

  it('closes and forgets nothing it has already paid for', async () => {
    const root = new RootStore();
    get.mockResolvedValueOnce(document_());
    await root.concepts.open('drawdown');

    root.concepts.close();
    expect(root.concepts.openSlug).toBeNull();
    expect(root.concepts.current).toBeNull();

    await root.concepts.open('drawdown');
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe('parseSpans', () => {
  it('splits a bold lead out of a misreading', () => {
    expect(parseSpans('**Treating it as risk.** Volatility is one component.')).toEqual([
      { text: 'Treating it as risk.', style: 'bold' },
      { text: ' Volatility is one component.', style: 'plain' },
    ]);
  });

  it('renders a single-asterisk emphasis as italic, not as literal asterisks', () => {
    // The shipped documents use this throughout - "a weight moves when
    // *anything* moves". A first version of the parser handled only `**` and
    // would have shown the asterisks to the reader.
    expect(parseSpans('A weight moves when *anything* moves.')).toEqual([
      { text: 'A weight moves when ', style: 'plain' },
      { text: 'anything', style: 'italic' },
      { text: ' moves.', style: 'plain' },
    ]);
  });

  it('keeps two emphases in one sentence separate', () => {
    expect(parseSpans('Not *this* but *that*.')).toEqual([
      { text: 'Not ', style: 'plain' },
      { text: 'this', style: 'italic' },
      { text: ' but ', style: 'plain' },
      { text: 'that', style: 'italic' },
      { text: '.', style: 'plain' },
    ]);
  });

  it('does not read a bold marker as an italic wrapping nothing', () => {
    expect(parseSpans('**Bold.** and *italic*')).toEqual([
      { text: 'Bold.', style: 'bold' },
      { text: ' and ', style: 'plain' },
      { text: 'italic', style: 'italic' },
    ]);
  });

  it('leaves an unbalanced marker as literal text rather than losing the sentence', () => {
    expect(parseSpans('A stray * marker here')).toEqual([
      { text: 'A stray * marker here', style: 'plain' },
    ]);
  });

  it('returns plain prose as a single span', () => {
    expect(parseSpans('No emphasis at all.')).toEqual([
      { text: 'No emphasis at all.', style: 'plain' },
    ]);
  });
});

describe('parseConceptText', () => {
  it('joins a hard-wrapped paragraph back into one line', () => {
    // The corpus wraps at about 80 columns for the benefit of a diff. Keeping
    // those breaks would wrap the text a second time in the browser.
    const blocks = parseConceptText('A drawdown is how far an\ninstrument has fallen.');
    expect(blocks).toEqual([
      {
        kind: 'paragraph',
        spans: [{ text: 'A drawdown is how far an instrument has fallen.', style: 'plain' }],
      },
    ]);
  });

  it('keeps an indented formula verbatim', () => {
    const blocks = parseConceptText('Take the close:\n\n    daily return = (a - b) / b\n\nA move.');
    expect(blocks).toEqual([
      { kind: 'paragraph', spans: [{ text: 'Take the close:', style: 'plain' }] },
      { kind: 'code', text: 'daily return = (a - b) / b' },
      { kind: 'paragraph', spans: [{ text: 'A move.', style: 'plain' }] },
    ]);
  });

  it('keeps a multi-line formula block together', () => {
    const blocks = parseConceptText('    peak = high\n    trough = low');
    expect(blocks).toEqual([{ kind: 'code', text: 'peak = high\ntrough = low' }]);
  });

  it('produces nothing from empty text rather than an empty paragraph', () => {
    expect(parseConceptText('\n\n   \n')).toEqual([]);
  });
});


/**
 * The claim in `conceptText.ts` - that the corpus uses only the constructs this
 * parser handles - asserted against the shipped documents rather than assumed.
 *
 * This is the test that would have caught the italics. It reads the real files,
 * because a fixture of what the documents are believed to contain is exactly
 * the mistake it exists to prevent.
 */
describe('the shipped corpus against the parser', () => {
  const corpus = resolve(import.meta.dirname, '../../../data/corpus/concepts');
  const files = readdirSync(corpus).filter((name) => name.endsWith('.md'));

  it('finds the nine documents', () => {
    expect(files).toHaveLength(9);
  });

  it.each(files)('%s parses with no marker left in the output', (name) => {
    const body = readFileSync(resolve(corpus, name), 'utf8').replace(/^---\n.*?\n---\n/s, '');

    for (const section of body.split(/^## .+$/m).slice(1)) {
      for (const block of parseConceptText(section)) {
        if (block.kind === 'code') continue;
        for (const span of block.spans) {
          // An asterisk surviving into rendered output means an emphasis the
          // parser did not understand, which the reader would see raw.
          expect(span.text).not.toContain('*');
        }
      }
    }
  });

  it.each(files)('%s uses no markdown construct the parser drops', (name) => {
    const body = readFileSync(resolve(corpus, name), 'utf8').replace(/^---\n.*?\n---\n/s, '');
    const prose = body.replace(/^ {4}.*$/gm, '');

    // Each of these would render as its own literal source text. If a document
    // ever needs one, the parser is what has to change.
    expect(prose).not.toMatch(/^[-*+] /m);
    expect(prose).not.toMatch(/^\d+\. /m);
    expect(prose).not.toMatch(/\[[^\]]+\]\([^)]*\)/);
    expect(prose).not.toMatch(/`/);
    expect(prose).not.toMatch(/^>/m);
  });
});
