import { makeAutoObservable, runInAction } from 'mobx';

import type { TopicConfirmRequest, TopicDetail, TopicLimits, TopicSummary } from '@traders/shared';
import type { TopicCandidate, TopicResolveResponse } from '@traders/shared/ai';

import { ApiRequestError, api } from '../api/client.ts';
import { queryKeys } from '../queries/queryKeys.ts';
import { t } from '../i18n/index.ts';
import type { RootStore } from './RootStore.ts';

/**
 * Topics: which topic is open, the confirm screen, and the writes.
 *
 * The list and each topic's detail, news and tone are server state, in the
 * query cache (`queries/topics.ts`); the list is read here through
 * `root.topicsCache` because the confirm screen's rules depend on the limits
 * and on what is already followed.
 *
 * **Nothing is ticked for the user.** The resolver's candidates arrive
 * unticked, and a topic's instruments are only what the user chose. The same
 * rule is in migration 0017, which stores confirmed rows only. A pre-ticked
 * list would make "confirmed" mean "did not untick", and the resolver finds
 * under half of what people expect (docs/TOPIC_RESOLUTION.md), so its picks
 * must not be the default.
 *
 * **One selection, two sources.** `selected` holds every symbol the user
 * wants, whether they ticked it in the suggestions or typed it into the add
 * box. The server decides which of them carry the resolver's reasons, by
 * re-resolving the label on confirm. So this store never sends a rationale,
 * and it has no way to.
 */
export class TopicsStore {
  /** Why the last reject or remove failed. A failed read is the query's to report. */
  error: string | null = null;

  /** The topic whose card is open, if any. Its contents are queries keyed by this id. */
  openTopicId: string | null = null;

  /** The confirm screen. Null while it is closed. */
  composer: Composer | null = null;

  /**
   * Whether weak suggestions are on screen. Off by default, by the user's
   * decision (2026-09-29): a weak match is shown only to someone who asked for
   * it, and never in place of a confident one.
   */
  showWeakProposals = false;

  constructor(private readonly root: RootStore) {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  /** Every topic, followed or proposed. Null before the first read. */
  get topics(): TopicSummary[] | null {
    return this.root.topicsCache.data?.topics ?? null;
  }

  get limits(): TopicLimits | null {
    return this.root.topicsCache.data?.limits ?? null;
  }

  get activeCount(): number {
    return this.followed.length;
  }

  /** Topics the user confirmed. */
  get followed(): TopicSummary[] {
    return (this.topics ?? []).filter((t) => t.status === 'active');
  }

  /** Auto-discovered themes waiting for a yes or a no (FR-11). Never followed until confirmed. */
  get proposals(): TopicSummary[] {
    return (this.topics ?? []).filter((t) => t.status === 'proposed');
  }

  /** Proposals the resolver was confident about: always shown. */
  get confidentProposals(): TopicSummary[] {
    return this.proposals.filter((t) => t.proposalBand !== 'weak');
  }

  /** Proposals the resolver matched only weakly: shown on request. */
  get weakProposals(): TopicSummary[] {
    return this.proposals.filter((t) => t.proposalBand === 'weak');
  }

  /** The proposals on screen: the confident ones, then the weak ones if asked for. */
  get shownProposals(): TopicSummary[] {
    return this.showWeakProposals
      ? [...this.confidentProposals, ...this.weakProposals]
      : this.confidentProposals;
  }

  toggleWeakProposals(): void {
    this.showWeakProposals = !this.showWeakProposals;
  }

  /** True when `topicId` is an open proposal, so confirming it would add a topic. */
  isProposal(topicId: string | null): boolean {
    return topicId !== null && this.proposals.some((t) => t.id === topicId);
  }

  /** True when a new topic would be refused by the cap. */
  get atLimit(): boolean {
    return this.limits !== null && this.activeCount >= this.limits.maxActiveTopics;
  }

  /** Show one topic's card. */
  open(topicId: string): void {
    this.openTopicId = topicId;
    this.error = null;
  }

  closeDetail(): void {
    this.openTopicId = null;
  }

  /** Open an empty confirm screen for a new topic. */
  startNew(): void {
    this.openTopicId = null;
    this.composer = new Composer(this, null, '', []);
  }

  /**
   * Open the confirm screen on an existing topic: its label, its current set
   * already selected (the user chose those), and a fresh resolution beside
   * them so they can see what else is suggested today.
   */
  edit(topic: TopicDetail): void {
    this.composer = new Composer(
      this,
      topic.id,
      topic.label,
      topic.instruments.map((i) => i.symbol),
    );
    void this.composer.resolve();
  }

  /**
   * Open the confirm screen on a proposal. Nothing is ticked, as for a topic
   * the user typed: the symbols the resolver was confident about when it
   * proposed are shown on the proposal as evidence, not carried in as choices.
   * Confirming is `PUT /topics/:id`, which makes the proposal a followed topic.
   */
  review(topic: TopicSummary): void {
    this.openTopicId = null;
    this.composer = new Composer(this, topic.id, topic.label, []);
    void this.composer.resolve();
  }

  /**
   * Decline a proposal. It leaves the list, and its theme is not proposed again
   * for `limits.rejectionCooldownDays` days.
   */
  async reject(topicId: string): Promise<boolean> {
    this.error = null;
    try {
      await api.post(`/topics/${topicId}/reject`);
      runInAction(() => {
        if (this.composer?.topicId === topicId) this.composer = null;
      });
      await this.root.queryClient.invalidateQueries({ queryKey: queryKeys.topics, exact: true });
      return true;
    } catch (error) {
      runInAction(() => {
        this.error = messageOf(error, t('errors.topicDeclineFailed'));
      });
      return false;
    }
  }

  closeComposer(): void {
    this.composer = null;
  }

  async remove(topicId: string): Promise<boolean> {
    this.error = null;
    try {
      await api.delete(`/topics/${topicId}`);
      runInAction(() => {
        if (this.openTopicId === topicId) this.openTopicId = null;
        if (this.composer?.topicId === topicId) this.composer = null;
      });
      // The topic, its news and its tone no longer exist; the list changed.
      this.root.queryClient.removeQueries({ queryKey: queryKeys.topic(topicId) });
      await this.root.queryClient.invalidateQueries({ queryKey: queryKeys.topics, exact: true });
      return true;
    } catch (error) {
      runInAction(() => {
        this.error = messageOf(error, t('errors.topicRemoveFailed'));
      });
      return false;
    }
  }

  /** Called by a composer that saved: show what the server stored. */
  adoptSaved(topic: TopicDetail): void {
    this.composer = null;
    this.openTopicId = topic.id;
    const client = this.root.queryClient;
    client.setQueryData(queryKeys.topic(topic.id), topic);
    // A changed set changes which articles are the topic's, so its news and
    // tone are re-read; so is the list, where a proposal may now be followed.
    void client.invalidateQueries({ queryKey: queryKeys.topicNews(topic.id) });
    void client.invalidateQueries({ queryKey: queryKeys.topicSentiment(topic.id) });
    void client.invalidateQueries({ queryKey: queryKeys.topics, exact: true });
  }

  reset(): void {
    this.openTopicId = null;
    this.composer = null;
    this.error = null;
  }
}

/**
 * The confirm screen: type a topic, look at what the resolver suggests, choose,
 * add, confirm.
 */
export class Composer {
  label: string;
  /** The label the current `resolution` answers, so a stale one is recognisable. */
  resolvedLabel: string | null = null;
  resolution: TopicResolveResponse | null = null;
  resolving = false;

  /** Every symbol the user wants in the topic, in the order they chose them. */
  selected: string[];
  addText = '';

  saving = false;
  error: string | null = null;
  /** Tickers the last confirm was refused over, so the screen can mark them. */
  unresolved: string[] = [];

  constructor(
    private readonly store: TopicsStore,
    readonly topicId: string | null,
    label: string,
    selected: string[],
  ) {
    this.label = label;
    this.selected = selected;
    makeAutoObservable(this, {}, { autoBind: true });
  }

  get maxInstruments(): number {
    return this.store.limits?.maxInstrumentsPerTopic ?? Number.POSITIVE_INFINITY;
  }

  get maxLabelLength(): number {
    return this.store.limits?.maxLabelLength ?? Number.POSITIVE_INFINITY;
  }

  /** Every candidate on offer, across interpretations, by symbol. */
  get offered(): Map<string, TopicCandidate> {
    const offered = new Map<string, TopicCandidate>();
    for (const interpretation of this.resolution?.interpretations ?? []) {
      for (const candidate of interpretation.candidates) {
        if (!offered.has(candidate.symbol)) offered.set(candidate.symbol, candidate);
      }
    }
    return offered;
  }

  /**
   * Chosen symbols the current suggestions do not include: typed in, or kept
   * from an earlier confirm. They are saved as the user's own additions unless
   * the resolver offers them again for the label being confirmed.
   */
  get additions(): string[] {
    const offered = this.offered;
    return this.selected.filter((symbol) => !offered.has(symbol));
  }

  /** True when the label has changed since it was last resolved. */
  get stale(): boolean {
    return this.resolvedLabel !== null && this.resolvedLabel !== this.label.trim();
  }

  isSelected(symbol: string): boolean {
    return this.selected.includes(symbol);
  }

  get atInstrumentLimit(): boolean {
    return this.selected.length >= this.maxInstruments;
  }

  /**
   * Why the topic cannot be confirmed yet, or null when it can. These repeat
   * the server's own checks, which still apply, so the user learns a rule while
   * there is still something to fix rather than by being refused.
   */
  get blockingIssue(): string | null {
    const label = this.label.trim();
    if (!label) return t('validation.topicName');
    if (label.length > this.maxLabelLength) {
      return t('validation.topicNameLength', { max: this.maxLabelLength });
    }
    if (this.selected.length === 0) return t('validation.topicInstruments');
    if (this.selected.length > this.maxInstruments) {
      return t('validation.topicInstrumentsMax', { max: this.maxInstruments });
    }
    // A proposal is not followed yet, so confirming it adds a topic like a new one does.
    if ((this.topicId === null || this.store.isProposal(this.topicId)) && this.store.atLimit) {
      return t('validation.topicsLimit', { max: this.store.limits?.maxActiveTopics });
    }
    return null;
  }

  get canConfirm(): boolean {
    return !this.saving && !this.resolving && this.blockingIssue === null;
  }

  setLabel(label: string): void {
    this.label = label;
  }

  async resolve(): Promise<void> {
    const label = this.label.trim();
    if (!label || label.length > this.maxLabelLength) return;
    this.resolving = true;
    this.error = null;
    try {
      const resolution = await api.post<TopicResolveResponse>('/topics/resolve', { topic: label });
      runInAction(() => {
        this.resolution = resolution;
        this.resolvedLabel = label;
      });
    } catch (error) {
      runInAction(() => {
        this.error = messageOf(error, t('errors.topicLookupFailed'));
      });
    } finally {
      runInAction(() => {
        this.resolving = false;
      });
    }
  }

  toggle(symbol: string): void {
    if (this.isSelected(symbol)) {
      this.selected = this.selected.filter((s) => s !== symbol);
    } else if (!this.atInstrumentLimit) {
      this.selected = [...this.selected, symbol];
    }
  }

  /** Tick every candidate of one interpretation, up to the instrument cap. */
  selectAll(candidates: TopicCandidate[]): void {
    for (const candidate of candidates) {
      if (this.atInstrumentLimit) break;
      if (!this.isSelected(candidate.symbol)) this.selected = [...this.selected, candidate.symbol];
    }
  }

  setAddText(text: string): void {
    this.addText = text;
  }

  /**
   * Add what is in the box: one ticker, or several separated by commas or
   * spaces. They are not looked up here. The confirm does that, and names any
   * ticker no provider recognises, which the screen then marks.
   */
  addTickers(): void {
    const symbols = this.addText
      .split(/[\s,]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    for (const symbol of symbols) {
      if (this.atInstrumentLimit) break;
      if (!this.isSelected(symbol)) this.selected = [...this.selected, symbol];
    }
    this.addText = '';
  }

  async confirm(): Promise<boolean> {
    if (!this.canConfirm) return false;
    this.saving = true;
    this.error = null;
    this.unresolved = [];
    const body: TopicConfirmRequest = { label: this.label.trim(), symbols: this.selected };
    try {
      const topic =
        this.topicId === null
          ? await api.post<TopicDetail>('/topics', body)
          : await api.put<TopicDetail>(`/topics/${this.topicId}`, body);
      this.store.adoptSaved(topic);
      return true;
    } catch (error) {
      runInAction(() => {
        this.error = messageOf(error, t('errors.topicSaveFailed'));
        if (error instanceof ApiRequestError && error.code === 'unresolved_symbols') {
          this.unresolved = unresolvedFrom(error.details);
        }
      });
      return false;
    } finally {
      runInAction(() => {
        this.saving = false;
      });
    }
  }
}

function unresolvedFrom(details: unknown): string[] {
  const symbols = (details as { symbols?: unknown } | undefined)?.symbols;
  return Array.isArray(symbols) ? symbols.filter((s): s is string => typeof s === 'string') : [];
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiRequestError ? error.message : fallback;
}
