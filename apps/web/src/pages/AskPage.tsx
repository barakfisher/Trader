import { useEffect, useRef, useState, type FormEvent } from 'react';
import { observer } from 'mobx-react-lite';
import { Link } from '@tanstack/react-router';
import { ExternalLink, MessageCircleQuestion, Plus, Trash2 } from 'lucide-react';

import type { AssistantReplyView, AssistantSourceView } from '@traders/shared';

import { AssistantText } from '../components/AssistantText.tsx';
import { Disclaimer } from '../components/Disclaimer.tsx';
import { Button, Card, ErrorNote, Spinner } from '../components/ui.tsx';
import { useTranslation } from '../i18n/index.ts';
import { formatAge } from '../lib/relativeTime.ts';
import { SERVER_ENGLISH } from '../lib/textDirection.ts';
import { useAssistantConversationsQuery } from '../queries/assistant.ts';
import { MAX_QUESTION_LENGTH, type AskTurn } from '../stores/AskStore.ts';
import { useStore } from '../stores/context.tsx';

/**
 * Questions to start from, one of each kind the assistant answers - three of
 * them the user's own (data/eval/assistant.json, U2 and U6). Filled in, never
 * sent (decision 70). Not translated: they become the question itself, and the
 * assistant answers in English for now (guideline 1), so they are marked English.
 */
const EXAMPLES = [
  'How is my portfolio doing today?',
  'Give me a tour in the app',
  'What tools did my agent use in its last scan?',
];

/**
 * The assistant (`/ask` with tools): a conversation, the conversations before
 * it, and a reply that says what it is.
 *
 * An answer is shown with where its facts came from - the sources the server
 * built from the tools that ran - and questions to ask next, which fill the box
 * and are not sent. A decline says why in the page's language; a reply that
 * could not be checked, a spent budget and a missing model are each said
 * plainly, and none of them is an error: only a failure to get any reply is.
 */
export const AskPage = observer(function AskPage() {
  const { ask } = useStore();
  const { t } = useTranslation();
  const box = useRef<HTMLTextAreaElement>(null);
  const tooLong = ask.draft.length > MAX_QUESTION_LENGTH;
  const fill = (text: string) => {
    ask.setDraft(text);
    box.current?.focus();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void ask.send();
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <MessageCircleQuestion className="size-5 text-accent" aria-hidden />
          <h1 className="text-base font-semibold">{t('ask.title')}</h1>
        </div>
        <Button variant="secondary" onClick={ask.startNew} disabled={ask.pending !== null}>
          <span className="inline-flex items-center gap-1">
            <Plus className="size-4" aria-hidden />
            {t('ask.newConversation')}
          </span>
        </Button>
      </header>

      <div className="grid gap-4 lg:grid-cols-[1fr_16rem]">
        <Card>
          <div className="space-y-4">
            {ask.opening && <Spinner label={t('ask.opening')} />}
            {ask.openError && <ErrorNote message={ask.openError} />}
            {!ask.opening && ask.turns.length === 0 && (
              <div className="space-y-2">
                <p className="text-sm text-text-muted">{t('ask.intro')}</p>
                <Suggestions suggestions={EXAMPLES} onPick={fill} />
              </div>
            )}
            {ask.turns.map((turn, index) => (
              <TurnView key={turn.id} turn={turn} last={index === ask.turns.length - 1} onPick={fill} />
            ))}
          </div>

          <form onSubmit={submit} className="mt-4 space-y-2 border-t border-border-subtle pt-4">
            <label htmlFor="ask-question" className="sr-only">
              {t('ask.label')}
            </label>
            <textarea
              id="ask-question"
              ref={box}
              value={ask.draft}
              onChange={(event) => ask.setDraft(event.target.value)}
              onKeyDown={(event) => {
                // Enter sends, as in a chat box; Shift+Enter is a new line.
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void ask.send();
                }
              }}
              rows={2}
              placeholder={t('ask.placeholder')}
              dir="auto"
              className="w-full resize-y rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm"
            />
            <div className="flex items-center justify-end gap-3">
              {tooLong && (
                <span className="text-xs text-loss">
                  {t('ask.tooLong', { length: ask.draft.length, max: MAX_QUESTION_LENGTH })}
                </span>
              )}
              <Button
                type="submit"
                disabled={ask.pending !== null || ask.opening !== null || ask.draft.trim() === '' || tooLong}
              >
                {ask.pending ? t('ask.answering') : t('ask.submit')}
              </Button>
            </div>
          </form>
        </Card>

        <History />
      </div>

      <Disclaimer />
    </div>
  );
});

const TurnView = observer(function TurnView({
  turn,
  last,
  onPick,
}: {
  turn: AskTurn;
  last: boolean;
  onPick: (text: string) => void;
}) {
  const { ask } = useStore();
  return (
    <div className="space-y-2">
      <p dir="auto" className="ms-auto w-fit max-w-[85%] rounded-lg bg-surface-hover px-3 py-2 text-sm">
        {turn.question}
      </p>
      {turn.reply === null && turn.error === null && turn.askedAt !== null && <Waiting since={turn.askedAt} />}
      {turn.error !== null && (
        <ErrorNote message={turn.error} onRetry={ask.pending || turn.askedAt === null ? undefined : () => ask.retry(turn.id)} />
      )}
      {turn.reply !== null && <ReplyView reply={turn.reply} showSuggestions={last} onPick={onPick} />}
    </div>
  );
});

/** The seconds since asking, ticking, so a model's minute does not look like a hang. */
function Waiting({ since }: { since: number }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <Spinner label={t('ask.thinking', { seconds: Math.floor((now - since) / 1000) })} />;
}

function ReplyView({
  reply,
  showSuggestions,
  onPick,
}: {
  reply: AssistantReplyView;
  showSuggestions: boolean;
  onPick: (text: string) => void;
}) {
  const { t } = useTranslation();
  if (reply.outcome === 'failed' || reply.outcome === 'budget_reached' || reply.outcome === 'no_model') {
    // Said in the page's language: the server's wording is a fallback for
    // other callers, and these three mean exactly one thing each.
    return (
      <p role="status" className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
        {t(`ask.outcome.${reply.outcome}`)}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {reply.outcome === 'decline' && reply.reason && (
        <p className="text-xs uppercase tracking-wide text-text-muted">{t(`ask.declined.${reply.reason}`)}</p>
      )}
      <AssistantText text={reply.text} />
      <Sources sources={reply.sources} />
      {showSuggestions && reply.suggestions.length > 0 && (
        <Suggestions suggestions={reply.suggestions} onPick={onPick} />
      )}
    </div>
  );
}

function Suggestions({ suggestions, onPick }: { suggestions: string[]; onPick: (text: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-1.5" aria-label={t('ask.suggestions')}>
      {suggestions.map((suggestion) => (
        <button
          key={suggestion}
          {...SERVER_ENGLISH}
          type="button"
          onClick={() => onPick(suggestion)}
          className="rounded-full bg-surface-hover px-2.5 py-1 text-xs text-text-muted hover:text-text-primary"
        >
          {suggestion}
        </button>
      ))}
    </div>
  );
}

/** Where the reply's facts came from: built by the server from the tools that ran. */
function Sources({ sources }: { sources: AssistantSourceView[] }) {
  const { t } = useTranslation();
  if (sources.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-[11px] uppercase tracking-wide text-text-muted">{t('ask.sources', { count: sources.length })}</p>
      <ul className="space-y-0.5 text-xs text-text-muted">
        {sources.map((source, index) => (
          <li key={`${source.label}-${index}`} {...SERVER_ENGLISH}>
            <SourceLabel source={source} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function SourceLabel({ source }: { source: AssistantSourceView }) {
  if (source.url) {
    return (
      <a href={source.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:underline">
        {source.label}
        <ExternalLink className="size-3" aria-hidden />
      </a>
    );
  }
  if (source.link) {
    return (
      <Link to={source.link as never} className="hover:underline">
        {source.label}
      </Link>
    );
  }
  return <span>{source.label}</span>;
}

/** The conversations before this one, newest first: open one, or delete it. */
const History = observer(function History() {
  const { ask } = useStore();
  const { t } = useTranslation();
  const conversations = useAssistantConversationsQuery();
  const [failed, setFailed] = useState<string | null>(null);
  const remove = async (id: string) => {
    if (!window.confirm(t('ask.deleteConfirm'))) return;
    setFailed(null);
    try {
      await ask.remove(id);
    } catch {
      setFailed(t('ask.deleteFailed'));
    }
  };
  return (
    <Card title={t('ask.history')}>
      {conversations.isPending && <Spinner label={t('ask.historyLoading')} />}
      {conversations.error && <ErrorNote message={t('ask.historyFailed')} onRetry={() => void conversations.refetch()} />}
      {failed && <ErrorNote message={failed} />}
      {conversations.data?.length === 0 && <p className="text-xs text-text-muted">{t('ask.historyEmpty')}</p>}
      <ul className="space-y-1">
        {conversations.data?.map((conversation) => (
          <li key={conversation.id} className="flex items-start gap-1">
            <button
              type="button"
              onClick={() => void ask.open(conversation.id)}
              aria-current={conversation.id === ask.conversationId ? 'true' : undefined}
              disabled={ask.pending !== null}
              className={`min-w-0 flex-1 rounded px-2 py-1 text-start text-xs hover:bg-surface-hover ${
                conversation.id === ask.conversationId ? 'bg-surface-hover text-text-primary' : 'text-text-muted'
              }`}
            >
              <span dir="auto" className="block truncate">
                {conversation.title}
              </span>
              <span className="block text-[11px]">{formatAge(conversation.updatedAt)}</span>
            </button>
            <button
              type="button"
              onClick={() => void remove(conversation.id)}
              aria-label={t('ask.delete', { title: conversation.title })}
              className="rounded p-1 text-text-muted hover:text-loss"
            >
              <Trash2 className="size-3.5" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-text-muted">{t('ask.retention')}</p>
    </Card>
  );
});
