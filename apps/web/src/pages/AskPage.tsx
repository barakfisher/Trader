import { useEffect, useState, type FormEvent } from 'react';
import { observer } from 'mobx-react-lite';
import { Link } from '@tanstack/react-router';
import { MessageCircleQuestion } from 'lucide-react';

import type { AskCitation, AskResponse } from '@traders/shared/ai';

import { ConceptText } from '../components/ConceptText.tsx';
import { Disclaimer } from '../components/Disclaimer.tsx';
import { EvidenceDrawer } from '../components/EvidenceDrawer.tsx';
import { Button, Card, ErrorNote, Spinner, buttonClass } from '../components/ui.tsx';
import { useTranslation } from '../i18n/index.ts';
import {
  computableQuestions,
  matchingNote,
  outcomeOf,
  similarityText,
  sourceText,
  waitingText,
} from '../lib/askPresentation.ts';
import { conceptLabel } from '../lib/observationPresentation.ts';
import { baseCurrencyOf } from '../lib/portfolioView.ts';
import { SERVER_ENGLISH } from '../lib/textDirection.ts';
import { usePortfolioQuery } from '../queries/portfolio.ts';
import { MAX_QUESTION_LENGTH, type AskEntry } from '../stores/AskStore.ts';
import { useStore } from '../stores/context.tsx';

/**
 * Questions to start from: one of each kind the page can answer. Filled in,
 * never sent. Deliberately not translated: they become the question itself,
 * and the service that reads it - its intent rules and its corpus - is English
 * (CLAUDE.md guideline 1), so they are marked as English text.
 */
const EXAMPLES = ['What is a drawdown?', 'What is my largest position?', 'How far am I from my targets?'];

/**
 * A question in the user's own words (FR-17).
 *
 * The page's job is to keep apart what the reply keeps apart (decisions 32,
 * 36): an answer, a weak match - given, and labelled as not sure - and four
 * refusals, each with its own title and next step. Who wrote an answer is said
 * on every one: quoted passages, a model's paragraph over them, or arithmetic
 * over the holdings that no model touched. And the passages an answer rests on
 * are shown verbatim, because an answer the reader cannot check is the thing
 * this product exists not to give.
 */
export const AskPage = observer(function AskPage() {
  const { ask } = useStore();
  const { t } = useTranslation();
  const tooLong = ask.draft.length > MAX_QUESTION_LENGTH;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void ask.ask();
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <MessageCircleQuestion className="size-5 text-accent" aria-hidden />
          <h1 className="text-base font-semibold">{t('ask.title')}</h1>
        </div>
      </header>

      <Card>
        <form onSubmit={submit} className="space-y-3">
          <label htmlFor="ask-question" className="block text-sm text-text-muted">
            {t('ask.intro')}
          </label>
          <textarea
            id="ask-question"
            value={ask.draft}
            onChange={(event) => ask.setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends, as in a chat box; Shift+Enter is a new line.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void ask.ask();
              }
            }}
            rows={2}
            placeholder={EXAMPLES[0]}
            // The question is English (see EXAMPLES), so the box takes the
            // direction of what is typed into it, not the page's.
            lang="en"
            dir="auto"
            className="w-full resize-y rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  {...SERVER_ENGLISH}
                  type="button"
                  onClick={() => ask.setDraft(example)}
                  className="rounded-full bg-surface-hover px-2.5 py-1 text-xs text-text-muted hover:text-text-primary"
                >
                  {example}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3">
              {tooLong && (
                <span className="text-xs text-loss">
                  {t('ask.tooLong', { length: ask.draft.length, max: MAX_QUESTION_LENGTH })}
                </span>
              )}
              <Button type="submit" disabled={ask.pending !== null || ask.draft.trim() === '' || tooLong}>
                {ask.pending ? t('ask.answering') : t('ask.submit')}
              </Button>
            </div>
          </div>
        </form>
      </Card>

      <div className="space-y-4">
        {ask.entries.map((entry) => (
          <EntryCard key={entry.id} entry={entry} />
        ))}
      </div>

      <Disclaimer />
    </div>
  );
});

const EntryCard = observer(function EntryCard({ entry }: { entry: AskEntry }) {
  const { ask } = useStore();
  return (
    <Card>
      <p className="mb-3 text-sm font-medium text-text-primary">{entry.question}</p>
      {entry.response === null && entry.error === null && <Waiting since={entry.askedAt} />}
      {entry.error !== null && (
        <ErrorNote message={entry.error} onRetry={ask.pending ? undefined : () => ask.retry(entry.id)} />
      )}
      {entry.response !== null && <Reply response={entry.response} entryId={entry.id} />}
    </Card>
  );
});

/** The seconds since asking, ticking, so a minute of model time does not look like a hang. */
function Waiting({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <Spinner label={waitingText(Math.floor((now - since) / 1000))} />;
}

const Reply = observer(function Reply({
  response,
  entryId,
}: {
  response: AskResponse;
  entryId: number;
}) {
  const { t } = useTranslation();
  const outcome = outcomeOf(response);
  const baseCurrency = baseCurrencyOf(usePortfolioQuery().data);

  if (outcome.kind === 'refused') {
    return (
      <div className="space-y-2">
        <p className="text-sm font-semibold text-text-primary">{outcome.title}</p>
        <p {...SERVER_ENGLISH} className="text-sm text-text-muted">{response.text}</p>
        {outcome.reason === 'not_in_corpus' && similarityText(response.best_similarity) && (
          <p className="text-xs text-text-muted">
            {t('ask.closestBelow', { score: similarityText(response.best_similarity) })}
          </p>
        )}
        {outcome.reason === 'no_holdings' && (
          <Link to="/" className={buttonClass('secondary')}>
            {t('ask.addHoldings')}
          </Link>
        )}
        {outcome.reason === 'not_computable' && (
          <p className="text-xs text-text-muted">
            {t('ask.canCompute', { questions: computableQuestions().join(t('common.clauseSeparator')) })}
          </p>
        )}
        <MatchingNote response={response} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {outcome.kind === 'answer' && outcome.relevance === 'weak' && (
        // Said by the page as well as by the text's own opening line: a reader
        // skimming for the answer must not miss that it may not be one.
        <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
          {similarityText(response.best_similarity)
            ? t('ask.weakMatchScored', { score: similarityText(response.best_similarity) })
            : t('ask.weakMatch')}
        </p>
      )}
      <p {...SERVER_ENGLISH} className="whitespace-pre-line text-sm text-text-primary">{response.text}</p>
      <p className="text-xs text-text-muted">{sourceText(response)}</p>
      <MatchingNote response={response} />
      {outcome.kind === 'computed' && Object.keys(response.evidence ?? {}).length > 0 && (
        <EvidenceDrawer
          evidence={response.evidence}
          baseCurrency={baseCurrency}
          id={`ask-evidence-${entryId}`}
        />
      )}
      <ConceptChips slugs={response.concept_refs ?? []} />
      <Citations citations={response.citations ?? []} />
    </div>
  );
});

function MatchingNote({ response }: { response: AskResponse }) {
  const note = matchingNote(response);
  return note ? <p className="text-xs text-text-muted">{note}</p> : null;
}

/** The terms the passages explain, each opening its full note. */
const ConceptChips = observer(function ConceptChips({ slugs }: { slugs: string[] }) {
  const { concepts } = useStore();
  const { t } = useTranslation();
  if (slugs.length === 0) return null;
  return (
    <p className="flex flex-wrap items-center gap-1 text-[11px] text-text-muted">
      <span className="uppercase tracking-wide">{t('ask.concepts')}</span>
      {slugs.map((slug) => (
        <button
          key={slug}
          type="button"
          onClick={() => concepts.open(slug)}
          className="rounded bg-surface-hover px-1.5 py-0.5 text-text-primary hover:bg-border hover:underline"
        >
          {conceptLabel(slug)}
        </button>
      ))}
    </p>
  );
});

/** The passages, verbatim. The first is open; the rest are one click away. */
function Citations({ citations }: { citations: AskCitation[] }) {
  const { t } = useTranslation();
  if (citations.length === 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-[11px] uppercase tracking-wide text-text-muted">
        {t('ask.passages', { count: citations.length })}
      </p>
      {citations.map((citation, index) => (
        <details
          key={citation.chunk_id}
          open={index === 0}
          className="rounded-lg border border-border-subtle bg-surface/60 px-3 py-2"
        >
          <summary {...SERVER_ENGLISH} className="cursor-pointer text-xs text-text-primary">
            {citation.title}
            {citation.heading && (
              <span className="text-text-muted">{t('ask.heading', { heading: citation.heading })}</span>
            )}
            {similarityText(citation.similarity) && (
              <span className="text-text-muted">
                {t('ask.relevance', { score: similarityText(citation.similarity) })}
              </span>
            )}
          </summary>
          {/* Verbatim: the corpus's own words, with its own emphasis. */}
          <blockquote className="mt-2 border-s-2 border-border-subtle ps-3">
            <ConceptText text={citation.text} size="xs" />
          </blockquote>
        </details>
      ))}
    </div>
  );
}
