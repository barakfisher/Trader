import { makeAutoObservable, runInAction } from 'mobx';

import type {
  TopicConfirmRequest,
  TopicDetail,
  TopicLimits,
  TopicNewsResponse,
  TopicSentimentResponse,
  TopicSummary,
  TopicsResponse,
} from '@traders/shared';
import type { TopicCandidate, TopicResolveResponse } from '@traders/shared/ai';

import { ApiRequestError, api } from '../api/client.ts';
import type { RootStore } from './RootStore.ts';

/**
 * Topics: the list, one topic's confirmed instruments, and the confirm screen.
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
  topics: TopicSummary[] | null = null;
  limits: TopicLimits | null = null;
  loading = false;
  error: string | null = null;

  /** The topic whose confirmed instruments are on screen, if any. */
  detail: TopicDetail | null = null;
  detailLoading = false;

  /**
   * The open topic's card: its week of news and its tone. Each loads on its own
   * and fails on its own, so a broken sentiment call never hides the news, and
   * neither hides the instruments.
   */
  news: TopicNewsResponse | null = null;
  newsError: string | null = null;
  sentiment: TopicSentimentResponse | null = null;
  sentimentError: string | null = null;
  /** Which topic `news` and `sentiment` belong to: a late answer for another is dropped. */
  cardTopicId: string | null = null;

  /** The confirm screen. Null while it is closed. */
  composer: Composer | null = null;

  constructor(private readonly root: RootStore) {
    makeAutoObservable(this, {}, { autoBind: true });
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

  /** True when `topicId` is an open proposal, so confirming it would add a topic. */
  isProposal(topicId: string | null): boolean {
    return topicId !== null && this.proposals.some((t) => t.id === topicId);
  }

  /** True when a new topic would be refused by the cap. */
  get atLimit(): boolean {
    return this.limits !== null && this.activeCount >= this.limits.maxActiveTopics;
  }

  async load(): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      const response = await api.get<TopicsResponse>('/topics');
      runInAction(() => {
        this.topics = response.topics;
        this.limits = response.limits;
      });
    } catch (error) {
      runInAction(() => {
        this.error = messageOf(error, 'Could not load your topics.');
      });
    } finally {
      runInAction(() => {
        this.loading = false;
      });
    }
  }

  async open(topicId: string): Promise<void> {
    this.detailLoading = true;
    this.error = null;
    this.news = null;
    this.newsError = null;
    this.sentiment = null;
    this.sentimentError = null;
    this.cardTopicId = topicId;
    void this.loadCard(topicId);
    try {
      const detail = await api.get<TopicDetail>(`/topics/${topicId}`);
      runInAction(() => {
        this.detail = detail;
      });
    } catch (error) {
      runInAction(() => {
        this.error = messageOf(error, 'Could not load that topic.');
      });
    } finally {
      runInAction(() => {
        this.detailLoading = false;
      });
    }
  }

  /** The card's two halves, each recorded only if the same topic is still open. */
  private async loadCard(topicId: string): Promise<void> {
    const stillOpen = () => this.cardTopicId === topicId;
    const loadNews = async () => {
      try {
        const news = await api.get<TopicNewsResponse>(`/topics/${topicId}/news`);
        runInAction(() => {
          if (stillOpen()) this.news = news;
        });
      } catch (error) {
        runInAction(() => {
          if (stillOpen()) this.newsError = messageOf(error, 'Could not load this topic’s news.');
        });
      }
    };
    const loadSentiment = async () => {
      try {
        const sentiment = await api.get<TopicSentimentResponse>(`/topics/${topicId}/sentiment`);
        runInAction(() => {
          if (stillOpen()) this.sentiment = sentiment;
        });
      } catch (error) {
        runInAction(() => {
          if (stillOpen()) this.sentimentError = messageOf(error, 'Could not load this topic’s tone.');
        });
      }
    };
    await Promise.all([loadNews(), loadSentiment()]);
  }

  closeDetail(): void {
    this.detail = null;
    this.cardTopicId = null;
    this.news = null;
    this.sentiment = null;
  }

  /** Open an empty confirm screen for a new topic. */
  startNew(): void {
    this.detail = null;
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
    this.detail = null;
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
      await this.load();
      return true;
    } catch (error) {
      runInAction(() => {
        this.error = messageOf(error, 'Could not decline that proposal.');
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
        if (this.detail?.id === topicId) this.detail = null;
        if (this.composer?.topicId === topicId) this.composer = null;
      });
      await this.load();
      return true;
    } catch (error) {
      runInAction(() => {
        this.error = messageOf(error, 'Could not remove that topic.');
      });
      return false;
    }
  }

  /** Called by a composer that saved: show what the server stored. */
  adoptSaved(topic: TopicDetail): void {
    this.composer = null;
    this.detail = topic;
    // A changed set changes which articles are the topic's, so the card reloads.
    this.news = null;
    this.sentiment = null;
    this.newsError = null;
    this.sentimentError = null;
    this.cardTopicId = topic.id;
    void this.loadCard(topic.id);
    void this.load();
  }

  reset(): void {
    this.topics = null;
    this.limits = null;
    this.detail = null;
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
    if (!label) return 'Name the topic.';
    if (label.length > this.maxLabelLength) {
      return `A topic name can be at most ${this.maxLabelLength} characters.`;
    }
    if (this.selected.length === 0) return 'Choose at least one instrument.';
    if (this.selected.length > this.maxInstruments) {
      return `A topic can hold at most ${this.maxInstruments} instruments.`;
    }
    // A proposal is not followed yet, so confirming it adds a topic like a new one does.
    if ((this.topicId === null || this.store.isProposal(this.topicId)) && this.store.atLimit) {
      return `You follow ${this.store.limits?.maxActiveTopics} topics already, which is the most you can. Remove one to add another.`;
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
        this.error = messageOf(error, 'Could not look that topic up.');
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
        this.error = messageOf(error, 'Could not save the topic.');
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
