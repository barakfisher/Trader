import { useState, type FormEvent } from 'react';
import { observer } from 'mobx-react-lite';
import { Newspaper, Plus, Search, Tags, X } from 'lucide-react';

import type {
  TopicDetail,
  TopicInstrument,
  TopicSentimentResponse,
  TopicSummary,
} from '@traders/shared';
import type { TopicCandidate } from '@traders/shared/ai';

import { Disclaimer } from '../components/Disclaimer.tsx';
import { Button, Card, EmptyState, ErrorNote, Spinner } from '../components/ui.tsx';
import { formatMoney } from '../i18n/format.ts';
import { useTranslation } from '../i18n/index.ts';
import { formatAge, formatExactTime } from '../lib/relativeTime.ts';
import { SERVER_ENGLISH } from '../lib/textDirection.ts';
import {
  coverageNote,
  heldByText,
  newsEmptyMessage,
  sentimentSummary,
  verdictMessage,
} from '../lib/topicPresentation.ts';
import type { Composer } from '../stores/TopicsStore.ts';
import { errorMessage } from '../api/client.ts';
import {
  useTopicNewsQuery,
  useTopicQuery,
  useTopicSentimentQuery,
  useTopicsQuery,
} from '../queries/topics.ts';
import { useStore } from '../stores/context.tsx';
import { NewsList } from '../components/NewsList.tsx';

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
  const { topics } = useStore();
  const list = useTopicsQuery();
  const { t } = useTranslation();
  const limits = topics.limits;

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Tags className="size-5 text-accent" aria-hidden />
          <h1 className="text-base font-semibold">{t('topicsPage.title')}</h1>
          {limits && (
            <span className="text-xs text-text-muted">
              {t('topicsPage.count', { active: topics.activeCount, max: limits.maxActiveTopics })}
            </span>
          )}
        </div>
      </header>

      <p className="max-w-3xl text-sm text-text-muted">
        {t('topicsPage.intro')}
      </p>

      {/* A failed read with nothing to show; a failed re-read keeps the list. */}
      {list.error && topics.topics === null && (
        <ErrorNote
          message={errorMessage(list.error, t('topicsPage.loadFailed'))}
          onRetry={() => void list.refetch()}
        />
      )}
      {topics.error && <ErrorNote message={topics.error} />}

      {topics.composer ? (
        <ComposerCard composer={topics.composer} />
      ) : topics.openTopicId ? (
        <OpenTopic topicId={topics.openTopicId} />
      ) : null}

      <ProposalList />

      <TopicList />

      <Disclaimer />
    </div>
  );
});

const TopicList = observer(function TopicList() {
  const { topics } = useStore();
  const list = useTopicsQuery();
  const { t } = useTranslation();

  if (list.isPending) return <Spinner label={t('topicsPage.loading')} />;
  if (topics.topics === null) return null;

  const newButton = (
    <Button onClick={topics.startNew} disabled={topics.atLimit || topics.composer !== null}>
      <span className="flex items-center gap-1">
        <Plus className="size-4" aria-hidden />
        {t('topicsPage.new')}
      </span>
    </Button>
  );

  if (topics.followed.length === 0) {
    return topics.composer ? null : (
      <div className="rounded-xl border border-border-subtle bg-surface-raised">
        <EmptyState
          title={t('topicsPage.emptyTitle')}
          body={t('topicsPage.emptyBody')}
          action={newButton}
        />
      </div>
    );
  }

  return (
    <Card title={t('topicsPage.yours')} action={newButton}>
      {topics.atLimit && (
        <p className="mb-3 text-xs text-text-muted">
          {t('topicsPage.atLimit', { max: topics.limits?.maxActiveTopics })}
        </p>
      )}
      <ul className="divide-y divide-border-subtle">
        {topics.followed.map((topic) => (
          <li key={topic.id}>
            <button
              type="button"
              onClick={() => void topics.open(topic.id)}
              className={`flex w-full items-center justify-between gap-3 py-2 text-start text-sm hover:text-accent ${
                topics.openTopicId === topic.id ? 'text-accent' : ''
              }`}
            >
              <span className="font-medium">{topic.label}</span>
              <span className="text-xs text-text-muted">
                {t('topicsPage.instruments', { count: topic.instrumentCount })}
                {topic.createdBy === 'auto' && t('topicsPage.foundInNews')}
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
  const { t } = useTranslation();
  if (topics.proposals.length === 0) return null;
  const cooldown = topics.limits?.rejectionCooldownDays;
  const ttl = topics.limits?.proposalTtlDays;
  const weak = topics.weakProposals.length;

  return (
    <Card title={t('topicsPage.suggested')}>
      <p className="mb-3 text-xs text-text-muted">
        {t('topicsPage.suggestedIntro')}
        {cooldown !== undefined && t('topicsPage.cooldown', { days: cooldown })}
        {ttl !== undefined && t('topicsPage.proposalTtl', { days: ttl })}
      </p>
      {topics.shownProposals.length > 0 && (
        <ul className="space-y-4">
          {topics.shownProposals.map((topic) => (
            <ProposalRow key={topic.id} topic={topic} />
          ))}
        </ul>
      )}
      {weak > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-text-muted">
          <Button variant="ghost" onClick={topics.toggleWeakProposals}>
            {topics.showWeakProposals
              ? t('topicsPage.hideWeak')
              : t('topicsPage.showWeak', { count: weak })}
          </Button>
          {!topics.showWeakProposals &&
            t('topicsPage.weakExplained')}
        </div>
      )}
    </Card>
  );
});

const ProposalRow = observer(function ProposalRow({ topic }: { topic: TopicSummary }) {
  const { topics } = useStore();
  const { t } = useTranslation();
  const evidence = topic.evidence;
  const reviewing = topics.composer?.topicId === topic.id;

  return (
    <li className="text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-medium">
          <Newspaper className="size-4 text-accent" aria-hidden />
          {topic.label}
          {topic.proposalBand === 'weak' && (
            <span className="rounded border border-border-subtle px-1.5 py-0.5 text-xs font-normal text-text-muted">
              {t('topicsPage.weakMatch')}
            </span>
          )}
        </span>
        <span className="flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => topics.review(topic)}
            disabled={reviewing || topics.atLimit}
          >
            {t('topicsPage.chooseInstruments')}
          </Button>
          <Button variant="ghost" onClick={() => void topics.reject(topic.id)}>
            {t('topicsPage.notInterested')}
          </Button>
        </span>
      </div>
      {evidence && (
        <div className="mt-1 space-y-1">
          <p className="text-xs text-text-muted">
            {t('topicsPage.evidence', {
              articles: evidence.articleCount,
              sources: evidence.sourceCount,
              days: evidence.windowDays,
            })}
            {evidence.symbols.length > 0 &&
              (topic.proposalBand === 'weak'
                ? t('topicsPage.looseMatches', { symbols: evidence.symbols.join(t('common.listSeparator')) })
                : t('topicsPage.resolverSuggested', {
                    symbols: evidence.symbols.join(t('common.listSeparator')),
                  }))}
          </p>
          <ul className="space-y-0.5">
            {evidence.headlines.map((headline) => (
              <li key={headline.articleId} className="break-words text-xs">
                <q {...SERVER_ENGLISH} className="italic text-text-muted">{headline.title}</q>
                <span className="text-text-muted">{t('topicsPage.headlineSource', { source: headline.source })}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {topics.atLimit && (
        <p className="mt-1 text-xs text-text-muted">
          {t('topicsPage.atLimitSuggestion')}
        </p>
      )}
    </li>
  );
});

/** The open topic: its confirmed instruments, then its tone and news, each read on its own. */
function OpenTopic({ topicId }: { topicId: string }) {
  const detail = useTopicQuery(topicId);
  const { t } = useTranslation();
  if (detail.isPending) return <Spinner label={t('topicsPage.topicLoading')} />;
  if (detail.error) {
    return (
      <ErrorNote
        message={errorMessage(detail.error, t('topicsPage.topicLoadFailed'))}
        onRetry={() => void detail.refetch()}
      />
    );
  }
  return <DetailCard topic={detail.data} />;
}

const DetailCard = observer(function DetailCard({ topic }: { topic: TopicDetail }) {
  const { topics } = useStore();
  const { t } = useTranslation();
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  return (
    <Card
      title={topic.label}
      action={
        <div className="flex items-center gap-2">
          {confirmingRemove ? (
            <>
              <span className="text-xs text-text-muted">{t('topicsPage.stopFollowing')}</span>
              <Button variant="danger" onClick={() => void topics.remove(topic.id)}>
                {t('common.remove')}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmingRemove(false)}>
                {t('topicsPage.keep')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={() => topics.edit(topic)}>
                {t('common.edit')}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmingRemove(true)}>
                {t('common.remove')}
              </Button>
              <Button variant="ghost" onClick={topics.closeDetail}>
                <X className="size-4" aria-label={t('common.close')} />
              </Button>
            </>
          )}
        </div>
      }
    >
      {topic.confirmedAt && (
        <p className="mb-3 text-xs text-text-muted">
          {t('topicsPage.confirmedAt', { when: formatExactTime(topic.confirmedAt) })}
        </p>
      )}
      <ul className="space-y-3">
        {topic.instruments.map((instrument) => (
          <ConfirmedRow key={instrument.instrumentId} instrument={instrument} />
        ))}
      </ul>
      <ToneSection topicId={topic.id} />
      <NewsSection topicId={topic.id} />
    </Card>
  );
});

/** The topic's tone: a score with the counts behind it, or the reason there is none. */
function ToneSection({ topicId }: { topicId: string }) {
  const tone = useTopicSentimentQuery(topicId);
  const { t } = useTranslation();
  return (
    <section className="mt-5 border-t border-border-subtle pt-4">
      <h3 className="mb-1 text-sm font-semibold">{t('topicsPage.tone')}</h3>
      {tone.error ? (
        <p className="text-xs text-text-muted">
          {errorMessage(tone.error, t('topicsPage.toneFailed'))}
        </p>
      ) : tone.data === undefined ? (
        <Spinner label={t('topicsPage.toneLoading')} />
      ) : (
        <ToneLine sentiment={tone.data} />
      )}
    </section>
  );
}

function ToneLine({ sentiment }: { sentiment: TopicSentimentResponse }) {
  const summary = sentimentSummary(sentiment);
  return (
    <p className="text-sm">
      {summary.score !== null && (
        <span className="me-2 font-semibold tabular-nums">{summary.score}</span>
      )}
      <span className="text-xs text-text-muted">{summary.text}</span>
    </p>
  );
}

/** The topic's week of news, newest first, each with the instrument that tied it here. */
function NewsSection({ topicId }: { topicId: string }) {
  const query = useTopicNewsQuery(topicId);
  const news = query.data;
  const { t } = useTranslation();
  return (
    <section className="mt-5 border-t border-border-subtle pt-4">
      <h3 className="mb-1 text-sm font-semibold">{t('topicsPage.news')}</h3>
      {query.error ? (
        <p className="text-xs text-text-muted">
          {errorMessage(query.error, t('topicsPage.newsFailed'))}
        </p>
      ) : news === undefined ? (
        <Spinner label={t('holding.newsLoading')} />
      ) : news.articles.length === 0 ? (
        <p className="text-xs text-text-muted">
          {newsEmptyMessage(news.collection, news.days)}
          {news.collection && t('holding.lastCollection', { age: formatAge(news.collection.lastRunAt) })}
        </p>
      ) : (
        <NewsList articles={news.articles} />
      )}
    </section>
  );
}

function ConfirmedRow({ instrument }: { instrument: TopicInstrument }) {
  const held = heldByText(instrument.heldBy);
  const { t } = useTranslation();
  return (
    <li className="text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{instrument.symbol}</span>
        {instrument.name && <bdi className="text-text-muted">{instrument.name}</bdi>}
        {instrument.source === 'user' ? (
          <Badge tone="muted">{t('topicsPage.addedByYou')}</Badge>
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
  const { t } = useTranslation();
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
          ? t('topicsPage.newTopic')
          : topics.isProposal(composer.topicId)
            ? t('topicsPage.suggestedTopic')
            : t('topicsPage.editTopic')
      }
      action={
        <Button variant="ghost" onClick={topics.closeComposer}>
          <X className="size-4" aria-label={t('common.close')} />
        </Button>
      }
    >
      <div className="space-y-4">
        <form onSubmit={submitLabel} className="flex flex-wrap items-center gap-2">
          <input
            aria-label={t('topicsPage.topic')}
            value={composer.label}
            onChange={(event) => composer.setLabel(event.target.value)}
            placeholder={t('topicsPage.topicPlaceholder')}
            maxLength={composer.maxLabelLength}
            className="min-w-60 flex-1 rounded-lg border border-border-subtle bg-surface px-3 py-1.5 text-sm"
          />
          <Button
            type="submit"
            variant="secondary"
            disabled={!composer.label.trim() || composer.resolving}
          >
            <span className="flex items-center gap-1">
              <Search className="size-4" aria-hidden />
              {t('topicsPage.find')}
            </span>
          </Button>
        </form>

        {composer.resolving && <Spinner label={t('topicsPage.resolving')} />}
        {composer.stale && !composer.resolving && (
          <p className="text-xs text-text-muted">
            {t('topicsPage.stale', { label: composer.resolvedLabel })}
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
            {t('topicsPage.ambiguous')}
          </p>
        )}
        {(resolution?.interpretations ?? []).map((interpretation, index) => (
          <section key={`${interpretation.label ?? 'group'}-${index}`} className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                {interpretation.label ?? t('topicsPage.suggestions')}
              </h3>
              <Button
                variant="ghost"
                onClick={() => composer.selectAll(interpretation.candidates)}
                disabled={composer.atInstrumentLimit}
              >
                {t('topicsPage.tickAll')}
              </Button>
            </div>
            <ul className="space-y-2">
              {interpretation.candidates.map((candidate) => (
                <CandidateRow
                  key={candidate.instrument_id}
                  composer={composer}
                  candidate={candidate}
                />
              ))}
            </ul>
          </section>
        ))}

        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            {t('topicsPage.addMissed')}
          </h3>
          <form onSubmit={submitAdd} className="flex flex-wrap items-center gap-2">
            <input
              aria-label={t('topicsPage.addTickers')}
              value={composer.addText}
              onChange={(event) => composer.setAddText(event.target.value)}
              placeholder={t('topicsPage.addPlaceholder')}
              className="min-w-48 flex-1 rounded-lg border border-border-subtle bg-surface px-3 py-1.5 text-sm"
            />
            <Button
              type="submit"
              variant="secondary"
              disabled={!composer.addText.trim() || composer.atInstrumentLimit}
            >
              {t('topicsPage.add')}
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
                    {unknown && <span>{t('topicsPage.notRecognised')}</span>}
                    <button
                      type="button"
                      onClick={() => composer.toggle(symbol)}
                      aria-label={t('holdings.removeSymbol', { symbol })}
                    >
                      <X className="size-3" aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-xs text-text-muted">
            {t('topicsPage.checkedOnConfirm')}
          </p>
        </section>

        {composer.error && <ErrorNote message={composer.error} />}

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-3">
          <span className="text-xs text-text-muted">
            {composer.blockingIssue ??
              t('topicsPage.chosen', { chosen: composer.selected.length, max: composer.maxInstruments })}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={topics.closeComposer}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void composer.confirm()} disabled={!composer.canConfirm}>
              {composer.saving ? t('settings.saving') : t('topicsPage.confirm')}
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
  const { t } = useTranslation();
  const checked = composer.isSelected(candidate.symbol);
  const held = heldByText(candidate.held_by ?? []);
  const size =
    candidate.size_minor !== null && candidate.size_currency !== null
      ? formatMoney(candidate.size_minor, candidate.size_currency, { compact: true })
      : null;

  return (
    <li>
      <label className="flex cursor-pointer items-start gap-3 rounded-lg p-2 text-sm hover:bg-surface-hover">
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
            {candidate.name && <bdi className="text-text-muted">{candidate.name}</bdi>}
            <Band confidence={candidate.confidence} />
            {candidate.asset_class === 'etf' && <Badge tone="muted">{t('topicsPage.etf')}</Badge>}
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
  const { t } = useTranslation();
  if (confidence === null) return null;
  return confidence === 'confident' ? (
    <Badge tone="accent">{t('topicsPage.strongMatch')}</Badge>
  ) : (
    <Badge tone="muted">{t('topicsPage.weakMatch')}</Badge>
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

/** Quoted, because it is: verbatim from the instrument's own description - in English. */
function Quote({ text }: { text: string }) {
  return (
    <q {...SERVER_ENGLISH} className="block text-xs italic text-text-muted">
      {text}
    </q>
  );
}
