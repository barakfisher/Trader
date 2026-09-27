import { useState, type FormEvent } from 'react';
import { observer } from 'mobx-react-lite';
import { ArrowLeft, Newspaper, Plus, Search, Tags, X } from 'lucide-react';

import { formatMoney } from '@traders/shared';
import type { TopicDetail, TopicInstrument, TopicSummary } from '@traders/shared';
import type { TopicCandidate } from '@traders/shared/ai';

import { Disclaimer } from '../components/Disclaimer.tsx';
import { Button, Card, EmptyState, ErrorNote, Spinner } from '../components/ui.tsx';
import { coverageNote, heldByText, verdictMessage } from '../lib/topicPresentation.ts';
import type { Composer } from '../stores/TopicsStore.ts';
import { useStore } from '../stores/context.tsx';

/**
 * Topics: themes the user follows, each with the instruments they confirmed
 * for it (FR-10).
 *
 * The resolver suggests and the user decides. Every suggestion shows its reason
 * as evidence the user can check: a sentence quoted from the company's own
 * description, and the thematic funds that hold it. Nothing is ticked for them,
 * and a ticker the resolver missed can be added by hand. The resolver finds
 * under half of what people expect, so the add box is not a fallback. It is
 * half of how a topic gets its instruments.
 */
export const TopicsPage = observer(function TopicsPage() {
  const { topics, navigation } = useStore();
  const limits = topics.limits;

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Tags className="size-5 text-accent" aria-hidden />
          <h1 className="text-base font-semibold">Topics</h1>
          {limits && (
            <span className="text-xs text-text-muted">
              {topics.activeCount} of {limits.maxActiveTopics}
            </span>
          )}
        </div>
        <Button variant="secondary" onClick={() => navigation.show('portfolio')}>
          <span className="flex items-center gap-1">
            <ArrowLeft className="size-4" aria-hidden />
            Back to portfolio
          </span>
        </Button>
      </header>

      <p className="max-w-3xl text-sm text-text-muted">
        A topic is a theme you want to follow, in your own words: “uranium”, “robot surgery”. Type
        one and the app suggests instruments whose business descriptions are about it, each with
        the sentence that matched. Suggestions are never ticked for you, and you can add any ticker
        they missed. Following a topic buys nothing; it decides what the app watches.
      </p>

      {topics.error && <ErrorNote message={topics.error} onRetry={() => void topics.load()} />}

      {topics.composer ? (
        <ComposerCard composer={topics.composer} />
      ) : topics.detail ? (
        <DetailCard topic={topics.detail} />
      ) : null}

      <ProposalList />

      <TopicList />

      <Disclaimer />
    </div>
  );
});

const TopicList = observer(function TopicList() {
  const { topics } = useStore();

  if (topics.loading && topics.topics === null) return <Spinner label="Loading your topics…" />;
  if (topics.topics === null) return null;

  const newButton = (
    <Button onClick={topics.startNew} disabled={topics.atLimit || topics.composer !== null}>
      <span className="flex items-center gap-1">
        <Plus className="size-4" aria-hidden />
        New topic
      </span>
    </Button>
  );

  if (topics.followed.length === 0) {
    return topics.composer ? null : (
      <div className="rounded-xl border border-border-subtle bg-surface-raised">
        <EmptyState
          title="No topics yet"
          body="Follow a theme and the app will watch the instruments you confirm for it."
          action={newButton}
        />
      </div>
    );
  }

  return (
    <Card title="Your topics" action={newButton}>
      {topics.atLimit && (
        <p className="mb-3 text-xs text-text-muted">
          You follow {topics.limits?.maxActiveTopics} topics, which is the most you can. Remove one
          to add another.
        </p>
      )}
      <ul className="divide-y divide-border-subtle">
        {topics.followed.map((topic) => (
          <li key={topic.id}>
            <button
              type="button"
              onClick={() => void topics.open(topic.id)}
              className={`flex w-full items-center justify-between gap-3 py-2 text-left text-sm hover:text-accent ${
                topics.detail?.id === topic.id ? 'text-accent' : ''
              }`}
            >
              <span className="font-medium">{topic.label}</span>
              <span className="text-xs text-text-muted">
                {topic.instrumentCount} instrument{topic.instrumentCount === 1 ? '' : 's'}
                {topic.createdBy === 'auto' && ' · found in the news'}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
});

/**
 * Themes the app noticed recurring in the news about what the user follows
 * (FR-11). Each is a question, never a subscription: it is followed only once
 * the user confirms instruments for it, exactly as for a topic they typed.
 * The reason shown is the evidence as stored - the headlines verbatim and the
 * counts - so a proposal says nothing the news did not.
 */
const ProposalList = observer(function ProposalList() {
  const { topics } = useStore();
  if (topics.proposals.length === 0) return null;
  const cooldown = topics.limits?.rejectionCooldownDays;

  return (
    <Card title="Suggested from the news">
      <p className="mb-3 text-xs text-text-muted">
        These themes kept coming up in headlines about what you hold and follow. They are
        suggestions only: nothing is followed until you choose its instruments.
        {cooldown !== undefined &&
          ` If you are not interested, a theme like it is not suggested again for ${cooldown} days.`}
      </p>
      <ul className="space-y-4">
        {topics.proposals.map((topic) => (
          <ProposalRow key={topic.id} topic={topic} />
        ))}
      </ul>
    </Card>
  );
});

const ProposalRow = observer(function ProposalRow({ topic }: { topic: TopicSummary }) {
  const { topics } = useStore();
  const evidence = topic.evidence;
  const reviewing = topics.composer?.topicId === topic.id;

  return (
    <li className="text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-medium">
          <Newspaper className="size-4 text-accent" aria-hidden />
          {topic.label}
        </span>
        <span className="flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => topics.review(topic)}
            disabled={reviewing || topics.atLimit}
          >
            Choose instruments
          </Button>
          <Button variant="ghost" onClick={() => void topics.reject(topic.id)}>
            Not interested
          </Button>
        </span>
      </div>
      {evidence && (
        <div className="mt-1 space-y-1">
          <p className="text-xs text-text-muted">
            In {evidence.articleCount} headlines from {evidence.sourceCount} outlets over the last{' '}
            {evidence.windowDays} days
            {evidence.symbols.length > 0 && ` · the resolver suggested ${evidence.symbols.join(', ')}`}
          </p>
          <ul className="space-y-0.5">
            {evidence.headlines.map((headline) => (
              <li key={headline.articleId} className="text-xs">
                <q className="italic text-text-muted">{headline.title}</q>
                <span className="text-text-muted"> · {headline.source}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {topics.atLimit && (
        <p className="mt-1 text-xs text-text-muted">
          You follow the most topics you can; remove one to take this suggestion up.
        </p>
      )}
    </li>
  );
});

const DetailCard = observer(function DetailCard({ topic }: { topic: TopicDetail }) {
  const { topics } = useStore();
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  return (
    <Card
      title={topic.label}
      action={
        <div className="flex items-center gap-2">
          {confirmingRemove ? (
            <>
              <span className="text-xs text-text-muted">Stop following this topic?</span>
              <Button variant="danger" onClick={() => void topics.remove(topic.id)}>
                Remove
              </Button>
              <Button variant="ghost" onClick={() => setConfirmingRemove(false)}>
                Keep
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={() => topics.edit(topic)}>
                Edit
              </Button>
              <Button variant="ghost" onClick={() => setConfirmingRemove(true)}>
                Remove
              </Button>
              <Button variant="ghost" onClick={topics.closeDetail}>
                <X className="size-4" aria-label="Close" />
              </Button>
            </>
          )}
        </div>
      }
    >
      {topic.confirmedAt && (
        <p className="mb-3 text-xs text-text-muted">
          Confirmed {new Date(topic.confirmedAt).toLocaleString()}. The reasons below are the ones
          shown when you confirmed.
        </p>
      )}
      <ul className="space-y-3">
        {topic.instruments.map((instrument) => (
          <ConfirmedRow key={instrument.instrumentId} instrument={instrument} />
        ))}
      </ul>
    </Card>
  );
});

function ConfirmedRow({ instrument }: { instrument: TopicInstrument }) {
  const held = heldByText(instrument.heldBy);
  return (
    <li className="text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{instrument.symbol}</span>
        {instrument.name && <span className="text-text-muted">{instrument.name}</span>}
        {instrument.source === 'user' ? (
          <Badge tone="muted">added by you</Badge>
        ) : (
          <Band confidence={instrument.confidence} />
        )}
      </div>
      {instrument.rationale && <Quote text={instrument.rationale} />}
      {held && <p className="text-xs text-text-muted">{held}</p>}
    </li>
  );
}

const ComposerCard = observer(function ComposerCard({ composer }: { composer: Composer }) {
  const { topics } = useStore();
  const resolution = composer.resolution;
  const message = resolution ? verdictMessage(resolution) : null;
  const coverage = resolution ? coverageNote(resolution.universe) : null;

  const submitLabel = (event: FormEvent) => {
    event.preventDefault();
    void composer.resolve();
  };
  const submitAdd = (event: FormEvent) => {
    event.preventDefault();
    composer.addTickers();
  };

  return (
    <Card
      title={
        composer.topicId === null
          ? 'New topic'
          : topics.isProposal(composer.topicId)
            ? 'Suggested topic'
            : 'Edit topic'
      }
      action={
        <Button variant="ghost" onClick={topics.closeComposer}>
          <X className="size-4" aria-label="Close" />
        </Button>
      }
    >
      <div className="space-y-4">
        <form onSubmit={submitLabel} className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Topic"
            value={composer.label}
            onChange={(event) => composer.setLabel(event.target.value)}
            placeholder="e.g. uranium, robot surgery, GLP-1"
            maxLength={composer.maxLabelLength}
            className="min-w-60 flex-1 rounded-lg border border-border-subtle bg-surface px-3 py-1.5 text-sm"
          />
          <Button type="submit" variant="secondary" disabled={!composer.label.trim() || composer.resolving}>
            <span className="flex items-center gap-1">
              <Search className="size-4" aria-hidden />
              Find instruments
            </span>
          </Button>
        </form>

        {composer.resolving && <Spinner label="Looking through the instrument universe…" />}
        {composer.stale && !composer.resolving && (
          <p className="text-xs text-text-muted">
            The suggestions below are for “{composer.resolvedLabel}”. Find instruments again to see
            them for the new name. When you confirm, reasons are kept only for suggestions the new
            name also brings up.
          </p>
        )}
        {message && (
          <p
            className={`rounded-lg px-3 py-2 text-sm ${
              message.tone === 'caution'
                ? 'border border-accent/40 bg-accent/10'
                : 'border border-border-subtle bg-surface-hover text-text-muted'
            }`}
          >
            {message.text}
          </p>
        )}
        {coverage && <p className="text-xs text-text-muted">{coverage}</p>}

        {resolution?.ambiguous && (
          <p className="text-sm text-text-muted">
            This topic matches more than one kind of business. Choose from whichever you meant.
          </p>
        )}
        {(resolution?.interpretations ?? []).map((interpretation, index) => (
          <section key={`${interpretation.label ?? 'group'}-${index}`} className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                {interpretation.label ?? 'Suggestions'}
              </h3>
              <Button
                variant="ghost"
                onClick={() => composer.selectAll(interpretation.candidates)}
                disabled={composer.atInstrumentLimit}
              >
                Tick all
              </Button>
            </div>
            <ul className="space-y-2">
              {interpretation.candidates.map((candidate) => (
                <CandidateRow key={candidate.instrument_id} composer={composer} candidate={candidate} />
              ))}
            </ul>
          </section>
        ))}

        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            Add tickers the suggestions missed
          </h3>
          <form onSubmit={submitAdd} className="flex flex-wrap items-center gap-2">
            <input
              aria-label="Add tickers"
              value={composer.addText}
              onChange={(event) => composer.setAddText(event.target.value)}
              placeholder="e.g. ISRG or BWXT, LEU"
              className="min-w-48 flex-1 rounded-lg border border-border-subtle bg-surface px-3 py-1.5 text-sm"
            />
            <Button
              type="submit"
              variant="secondary"
              disabled={!composer.addText.trim() || composer.atInstrumentLimit}
            >
              Add
            </Button>
          </form>
          {composer.additions.length > 0 && (
            <ul className="flex flex-wrap gap-2">
              {composer.additions.map((symbol) => {
                const unknown = composer.unresolved.includes(symbol);
                return (
                  <li
                    key={symbol}
                    className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
                      unknown ? 'border-loss/60 text-loss' : 'border-border-subtle'
                    }`}
                  >
                    {symbol}
                    {unknown && <span>· not recognised</span>}
                    <button
                      type="button"
                      onClick={() => composer.toggle(symbol)}
                      aria-label={`Remove ${symbol}`}
                    >
                      <X className="size-3" aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-xs text-text-muted">
            Tickers are checked when you confirm. One that no market data provider recognises is
            marked here, and nothing is saved until it is fixed or removed.
          </p>
        </section>

        {composer.error && <ErrorNote message={composer.error} />}

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-3">
          <span className="text-xs text-text-muted">
            {composer.blockingIssue ??
              `${composer.selected.length} of at most ${composer.maxInstruments} instruments chosen`}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={topics.closeComposer}>
              Cancel
            </Button>
            <Button onClick={() => void composer.confirm()} disabled={!composer.canConfirm}>
              {composer.saving ? 'Saving…' : 'Confirm topic'}
            </Button>
          </div>
        </footer>
      </div>
    </Card>
  );
});

const CandidateRow = observer(function CandidateRow({
  composer,
  candidate,
}: {
  composer: Composer;
  candidate: TopicCandidate;
}) {
  const checked = composer.isSelected(candidate.symbol);
  const held = heldByText(candidate.held_by ?? []);
  const size =
    candidate.size_minor !== null && candidate.size_currency !== null
      ? formatMoney(candidate.size_minor, candidate.size_currency, { compact: true })
      : null;

  return (
    <li>
      <label className="flex cursor-pointer gap-3 rounded-lg p-2 text-sm hover:bg-surface-hover">
        <input
          type="checkbox"
          checked={checked}
          disabled={!checked && composer.atInstrumentLimit}
          onChange={() => composer.toggle(candidate.symbol)}
          className="mt-1"
        />
        <span className="flex-1 space-y-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{candidate.symbol}</span>
            {candidate.name && <span className="text-text-muted">{candidate.name}</span>}
            <Band confidence={candidate.confidence} />
            {candidate.asset_class === 'etf' && <Badge tone="muted">ETF</Badge>}
            {size && <span className="text-xs text-text-muted">{size}</span>}
          </span>
          <Quote text={candidate.rationale} />
          {held && <span className="block text-xs text-text-muted">{held}</span>}
        </span>
      </label>
    </li>
  );
});

/** The match band. Never a percentage: a similarity score is not a probability. */
function Band({ confidence }: { confidence: 'confident' | 'weak' | null }) {
  if (confidence === null) return null;
  return confidence === 'confident' ? (
    <Badge tone="accent">strong match</Badge>
  ) : (
    <Badge tone="muted">weak match</Badge>
  );
}

function Badge({ tone, children }: { tone: 'accent' | 'muted'; children: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs ${
        tone === 'accent' ? 'bg-accent/15 text-accent' : 'bg-surface-hover text-text-muted'
      }`}
    >
      {children}
    </span>
  );
}

/** Quoted, because it is: verbatim from the instrument's own description. */
function Quote({ text }: { text: string }) {
  return <q className="block text-xs italic text-text-muted">{text}</q>;
}
